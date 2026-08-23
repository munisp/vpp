import { describe, expect, it } from 'vitest';

import {
  formatAge,
  memberNotice,
  postureHeadline,
  stalenessRatio,
  summarisePosture,
  type CapabilityStatus,
  type DependencyPosture,
} from './degraded-operation';

const NOW = new Date('2026-08-22T12:00:00.000Z');

function dependency(
  name: string,
  state: DependencyPosture['state'],
  observedAgoSeconds: number | null = 30
): DependencyPosture {
  return {
    dependency: name,
    state,
    lastObservation:
      observedAgoSeconds === null
        ? null
        : {
            observation: state === 'up' ? 'reachable' : 'unreachable',
            observedBy: 'server',
            operation: 'call',
            observedAt: new Date(NOW.getTime() - observedAgoSeconds * 1000),
            detail: null,
          },
    outage:
      state === 'down'
        ? { startedAt: new Date(NOW.getTime() - 600_000), failureCount: 3, lastDetail: 'timeout' }
        : null,
    stalenessSeconds: 900,
    reason: 'test',
  };
}

function capability(
  name: string,
  posture: CapabilityStatus['posture'],
  missing: string[] = []
): CapabilityStatus {
  return {
    capability: name,
    requires: missing,
    missing,
    posture,
    evidenceLimit: posture === 'available' ? null : 'no evidence of delivery',
    reason: 'test',
  };
}

describe('summarisePosture', () => {
  it('counts each dependency state separately so unknown is never folded into up', () => {
    const summary = summarisePosture(
      [
        dependency('optimizer', 'up'),
        dependency('mqtt_broker', 'unknown', null),
        dependency('market_broker', 'down'),
      ],
      []
    );
    expect(summary).toMatchObject({ dependencies: 3, up: 1, unknown: 1, down: 1 });
  });

  it('flags a refused money capability distinctly from a refused control one', () => {
    const money = summarisePosture([], [capability('metered_settlement', 'refused')]);
    expect(money.moneyPathsBlocked).toBe(true);

    const control = summarisePosture([], [capability('matter_command', 'refused')]);
    expect(control.refused).toBe(1);
    expect(control.moneyPathsBlocked).toBe(false);
  });
});

describe('postureHeadline', () => {
  it('leads with refusals, then degraded work, then unobserved dependencies', () => {
    const refused = postureHeadline(
      summarisePosture([], [capability('settlement_payout', 'refused')])
    );
    expect(refused.tone).toBe('danger');
    expect(refused.text).toContain('money movement');

    const degraded = postureHeadline(
      summarisePosture([], [capability('control_dispatch', 'degraded')])
    );
    expect(degraded.tone).toBe('warning');

    const unobserved = postureHeadline(
      summarisePosture([dependency('optimizer', 'unknown', null)], [])
    );
    expect(unobserved.tone).toBe('warning');
    expect(unobserved.text).toContain('unobserved');
  });

  it('only reads as healthy when nothing is unobserved', () => {
    const headline = postureHeadline(
      summarisePosture([dependency('optimizer', 'up')], [capability('optimizer_dispatch', 'available')])
    );
    expect(headline.tone).toBe('good');
  });
});

describe('formatAge and stalenessRatio', () => {
  it('says never rather than showing a blank for a dependency never called', () => {
    expect(formatAge(null)).toBe('never');
    expect(stalenessRatio(dependency('optimizer', 'unknown', null), NOW)).toBeNull();
  });

  it('crosses 1 exactly when the observation passes its staleness bound', () => {
    expect(stalenessRatio(dependency('optimizer', 'up', 450), NOW)).toBeCloseTo(0.5);
    expect(stalenessRatio(dependency('optimizer', 'up', 1800), NOW)).toBeCloseTo(2);
  });

  it('keeps a stale age legible instead of rounding it to now', () => {
    expect(formatAge(45)).toBe('45s ago');
    expect(formatAge(3 * 3600)).toBe('3h ago');
    expect(formatAge(2 * 86400)).toBe('2d ago');
  });
});

describe('memberNotice', () => {
  it('tells a member what is paused, and stays silent when nothing is', () => {
    expect(memberNotice('available', null)).toBeNull();
    expect(memberNotice('refused', 'delivered energy is measured from telemetry')).toContain(
      'Paused'
    );
    expect(memberNotice('degraded', null)).toContain('Unverified');
  });
});
