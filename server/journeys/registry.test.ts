/**
 * The catalog is the contract and the registry is its implementation, so the
 * only interesting question here is whether they agree. A journey that runs
 * four of its five steps and reports itself green is the failure mode these
 * tests exist for.
 */

import { describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';

import { JOURNEYS } from '../../shared/journeys';
import { missingImplementations, orphanImplementations, stepImplementation } from './registry';
import { classifyDependencyError } from './step';

describe('journey registry', () => {
  it('implements every catalog step', () => {
    expect(missingImplementations()).toEqual([]);
  });

  it('has no implementation without a catalog step', () => {
    expect(orphanImplementations()).toEqual([]);
  });

  it('resolves each step to a function', () => {
    for (const journey of JOURNEYS) {
      for (const step of journey.steps) {
        expect(typeof stepImplementation(journey.id, step.id)).toBe('function');
      }
    }
  });

  it('does not resolve an unknown journey or step', () => {
    expect(stepImplementation('no-such-journey', 'no-such-step')).toBeUndefined();
    expect(stepImplementation(JOURNEYS[0].id, 'no-such-step')).toBeUndefined();
  });
});

describe('dependency error classification', () => {
  it('blocks on an absent provider rather than failing', () => {
    const report = classifyDependencyError(
      new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'no gateway is configured' }),
      'mobile_money'
    );
    expect(report.outcome).toBe('blocked');
    expect(report.facts.blockedOn).toBe('mobile_money');
  });

  it('records a documented refusal as a refusal', () => {
    const report = classifyDependencyError(
      new TRPCError({ code: 'PRECONDITION_FAILED', message: 'no delivery evidence' }),
      'mqtt_broker'
    );
    expect(report.outcome).toBe('refused');
    expect(report.facts.errorCode).toBe('PRECONDITION_FAILED');
  });

  it('fails on anything the service did not declare', () => {
    const report = classifyDependencyError(new Error('column does not exist'), 'kafka_broker');
    expect(report.outcome).toBe('failed');
    expect(report.facts.errorCode).toBe('none');
    expect(report.detail).toContain('column does not exist');
  });
});
