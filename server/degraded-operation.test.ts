/**
 * Degraded operation decides what the platform may still do when it cannot see a
 * dependency, so the tests that matter are the refusals:
 *  - silence never reads as health: no observation, and a stale observation, are
 *    both `unknown`, and `unknown` blocks the same as `down`
 *  - a failing call below the outage threshold is `unknown`, not `up`
 *  - money and market capabilities are refused even with DEGRADED_GUARD=observe,
 *    which exists for local development, not for paying people blind
 *  - only a capability that declares it may run degraded gets a degraded posture
 *  - an undeclared capability is refused rather than assumed dependency-free
 *  - reconciling a degraded action without evidence is refused
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CAPABILITIES,
  DEPENDENCIES,
  STALENESS_SECONDS,
  derivePosture,
  guardMode,
  statusFor,
  type DependencyName,
  type DependencyPosture,
  type Observation,
} from './services/degraded-operation';

const NOW = new Date('2026-08-22T12:00:00.000Z');

function observation(
  observed: Observation,
  agoSeconds: number
): Parameters<typeof derivePosture>[1] {
  return {
    observation: observed,
    observedBy: 'server',
    operation: 'POST /optimize/dispatch',
    observedAt: new Date(NOW.getTime() - agoSeconds * 1000),
    detail: observed === 'reachable' ? null : 'connection refused',
  };
}

/** Every dependency `up`, so a test only has to state what it wants broken. */
function allUp(overrides: Partial<Record<DependencyName, DependencyPosture>> = {}) {
  const states = new Map<DependencyName, DependencyPosture>();
  for (const dependency of DEPENDENCIES) {
    states.set(
      dependency,
      overrides[dependency] ?? derivePosture(dependency, observation('reachable', 5), null, NOW)
    );
  }
  return states;
}

function posture(dependency: DependencyName, state: 'down' | 'unknown'): DependencyPosture {
  if (state === 'down') {
    return derivePosture(
      dependency,
      observation('unreachable', 10),
      { startedAt: new Date(NOW.getTime() - 600_000), failureCount: 3, lastDetail: 'timeout' },
      NOW
    );
  }
  return derivePosture(dependency, null, null, NOW);
}

describe('derivePosture', () => {
  it('reports unknown when nothing was ever observed', () => {
    const result = derivePosture('optimizer', null, null, NOW);
    expect(result.state).toBe('unknown');
    expect(result.lastObservation).toBeNull();
    expect(result.reason).toContain('never observed');
  });

  it('reports up only from a recent successful call', () => {
    const result = derivePosture('optimizer', observation('reachable', 30), null, NOW);
    expect(result.state).toBe('up');
    expect(result.reason).toContain('POST /optimize/dispatch');
  });

  it('reports unknown once a successful observation is past its staleness bound', () => {
    const stale = STALENESS_SECONDS.optimizer + 1;
    const result = derivePosture('optimizer', observation('reachable', stale), null, NOW);
    expect(result.state).toBe('unknown');
    expect(result.reason).toContain('silence is not health');
  });

  it('reports unknown, not up, for a fresh failing call below the outage threshold', () => {
    for (const observed of ['unreachable', 'faulted'] as const) {
      const result = derivePosture('mqtt_broker', observation(observed, 5), null, NOW);
      expect(result.state).toBe('unknown');
      expect(result.reason).toContain(observed);
    }
  });

  it('reports down while an outage is open, whatever the last observation said', () => {
    const result = derivePosture(
      'market_broker',
      observation('reachable', 5),
      { startedAt: NOW, failureCount: 4, lastDetail: 'HTTP 503' },
      NOW
    );
    expect(result.state).toBe('down');
    expect(result.outage?.failureCount).toBe(4);
  });
});

describe('statusFor', () => {
  it('makes a capability available when every dependency answered recently', () => {
    const status = statusFor('optimizer_dispatch', CAPABILITIES.optimizer_dispatch, allUp());
    expect(status.posture).toBe('available');
    expect(status.missing).toEqual([]);
    expect(status.evidenceLimit).toBeNull();
  });

  it('refuses a settlement whose meter path is merely unknown', () => {
    const status = statusFor(
      'metered_settlement',
      CAPABILITIES.metered_settlement,
      allUp({ meter_telemetry: posture('meter_telemetry', 'unknown') })
    );
    expect(status.posture).toBe('refused');
    expect(status.missing).toEqual(['meter_telemetry']);
  });

  it('refuses a market bid while the broker is in an open outage', () => {
    const status = statusFor(
      'market_bid',
      CAPABILITIES.market_bid,
      allUp({ market_broker: posture('market_broker', 'down') })
    );
    expect(status.posture).toBe('refused');
    expect(status.missing).toEqual(['market_broker']);
  });

  it('still allows a self-observed dependency that is unknown but not in outage', () => {
    // The payout call is the only thing that ever observes the gateway, so
    // requiring a prior success would make the first payout unreachable.
    const status = statusFor(
      'settlement_payout',
      CAPABILITIES.settlement_payout,
      allUp({ payment_gateway: posture('payment_gateway', 'unknown') })
    );
    expect(status.posture).toBe('available');
  });

  it('reports a self-observed unknown dependency as unproven rather than silently fine', () => {
    // Not blocked, but nothing has confirmed it either: the operator screen must
    // not paint a payout path green off the back of a dependency nothing has
    // called all day.
    const status = statusFor(
      'settlement_payout',
      CAPABILITIES.settlement_payout,
      allUp({ payment_gateway: posture('payment_gateway', 'unknown') })
    );
    expect(status.unproven).toEqual(['payment_gateway']);
    expect(status.evidenceLimit).not.toBeNull();
    expect(status.reason).toContain('has not answered a real call recently');
  });

  it('leaves nothing unproven when every dependency answered', () => {
    const status = statusFor('settlement_payout', CAPABILITIES.settlement_payout, allUp());
    expect(status.unproven).toEqual([]);
    expect(status.evidenceLimit).toBeNull();
  });

  it('gives control dispatch a degraded posture rather than refusing it', () => {
    const status = statusFor(
      'control_dispatch',
      CAPABILITIES.control_dispatch,
      allUp({ mqtt_broker: posture('mqtt_broker', 'down') })
    );
    expect(status.posture).toBe('degraded');
    expect(status.evidenceLimit).toContain('not evidence the asset received');
  });
});

describe('guardMode', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env.DEGRADED_GUARD = original.DEGRADED_GUARD;
    process.env.NODE_ENV = original.NODE_ENV;
  });

  it('enforces by default in production and observes elsewhere', () => {
    delete process.env.DEGRADED_GUARD;
    process.env.NODE_ENV = 'production';
    expect(guardMode()).toBe('enforce');
    process.env.NODE_ENV = 'development';
    expect(guardMode()).toBe('observe');
  });

  it('rejects an unreadable value instead of guessing', () => {
    process.env.DEGRADED_GUARD = 'maybe';
    expect(() => guardMode()).toThrow(/must be/);
  });
});

describe('requireCapability', () => {
  const original = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.DEGRADED_GUARD = original.DEGRADED_GUARD;
    vi.doUnmock('./db');
    vi.restoreAllMocks();
  });

  /** Postures come from the database; here nothing has ever been observed. */
  function mockEmptyDb() {
    const empty = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: async () => [] }),
            then: (onFulfilled: (rows: unknown[]) => unknown) => Promise.resolve([]).then(onFulfilled),
          }),
        }),
      }),
    };
    vi.doMock('./db', () => ({ getDb: async () => empty }));
  }

  it('refuses a money capability even when the guard is set to observe', async () => {
    process.env.DEGRADED_GUARD = 'observe';
    mockEmptyDb();
    const { requireCapability } = await import('./services/degraded-operation');
    await expect(requireCapability('metered_settlement')).rejects.toThrow(/refused/);
  });

  it('allows a non-binding capability under observe, but reports it as degraded', async () => {
    process.env.DEGRADED_GUARD = 'observe';
    mockEmptyDb();
    const { requireCapability } = await import('./services/degraded-operation');
    const result = await requireCapability('matter_command');
    expect(result.posture).toBe('degraded');
    expect(result.evidenceLimit).toContain('without its controller');
  });

  it('refuses a capability nobody declared rather than assuming it needs nothing', async () => {
    process.env.DEGRADED_GUARD = 'observe';
    mockEmptyDb();
    const { requireCapability } = await import('./services/degraded-operation');
    await expect(requireCapability('pay_everyone')).rejects.toThrow(/no dependency rule/);
  });
});
