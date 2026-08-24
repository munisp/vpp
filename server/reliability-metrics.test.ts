import { describe, expect, it } from 'vitest';

import {
  MOMENTARY_THRESHOLD_MINUTES,
  assessReliability,
  type InterruptionRecord,
  type ServicePointExposure,
} from './services/reliability-metrics';

const PERIOD_START = new Date('2026-08-01T00:00:00Z');
const PERIOD_END = new Date('2026-08-31T00:00:00Z');
const PERIOD = { start: PERIOD_START, end: PERIOD_END };
const PERIOD_MINUTES = 30 * 24 * 60;

function point(overrides: Partial<ServicePointExposure> & { servicePointId: number }): ServicePointExposure {
  return {
    pointClass: 'residential',
    observed: true,
    connectedAt: new Date('2026-01-01T00:00:00Z'),
    disconnectedAt: null,
    ...overrides,
  };
}

function interruption(
  overrides: Partial<InterruptionRecord> & { id: number; servicePointId: number; startedAt: Date }
): InterruptionRecord {
  return {
    endedAt: null,
    cause: 'utility_grid_outage',
    detectionSource: 'meter_event',
    excludeFromIndices: false,
    ...overrides,
  };
}

function minutesAfter(from: Date, minutes: number): Date {
  return new Date(from.getTime() + minutes * 60_000);
}

describe('assessReliability — withheld results', () => {
  it('withholds every index when no connection is registered', () => {
    const result = assessReliability({ period: PERIOD, servicePoints: [], interruptions: [] });
    expect(result.reason).toBe('no_service_points_registered');
    expect(result.indices.saifi).toBeNull();
    expect(result.indices.asai).toBeNull();
    expect(result.basis).toBeNull();
    expect(result.limitations.join(' ')).toContain('empty register');
  });

  it('withholds indices when every registered connection is unmonitored', () => {
    const result = assessReliability({
      period: PERIOD,
      servicePoints: [point({ servicePointId: 1, observed: false }), point({ servicePointId: 2, observed: false })],
      interruptions: [],
    });
    expect(result.reason).toBe('no_observed_service_points');
    expect(result.indices.saidiMinutes).toBeNull();
    expect(result.coverage.registeredServicePoints).toBe(2);
    expect(result.coverage.observedServicePoints).toBe(0);
    expect(result.coverage.unobservedServicePoints).toBe(2);
  });

  it('withholds indices for a period with no duration', () => {
    const result = assessReliability({
      period: { start: PERIOD_START, end: PERIOD_START },
      servicePoints: [point({ servicePointId: 1 })],
      interruptions: [],
    });
    expect(result.reason).toBe('period_not_started');
    expect(result.indices.maifi).toBeNull();
  });

  it('does not report zero interruptions as perfect supply on an unobserved fleet', () => {
    const result = assessReliability({
      period: PERIOD,
      servicePoints: [point({ servicePointId: 1, observed: false })],
      interruptions: [],
    });
    expect(result.indices.asai).toBeNull();
    expect(result.counts.sustainedInterruptions).toBe(0);
  });
});

describe('assessReliability — indices', () => {
  it('reports a clean period over observed connections as measured', () => {
    const result = assessReliability({
      period: PERIOD,
      servicePoints: [point({ servicePointId: 1 }), point({ servicePointId: 2 })],
      interruptions: [],
    });
    expect(result.reason).toBeNull();
    expect(result.basis).toBe('measured');
    expect(result.indices.saifi).toBe(0);
    expect(result.indices.saidiMinutes).toBe(0);
    expect(result.indices.caidiMinutes).toBeNull();
    expect(result.indices.asai).toBe(1);
    expect(result.coverage.observedCustomerMinutes).toBe(2 * PERIOD_MINUTES);
  });

  it('computes SAIFI, SAIDI, CAIDI and ASAI over the observed population', () => {
    const result = assessReliability({
      period: PERIOD,
      servicePoints: [point({ servicePointId: 1 }), point({ servicePointId: 2 }), point({ servicePointId: 3 })],
      interruptions: [
        interruption({
          id: 1,
          servicePointId: 1,
          startedAt: new Date('2026-08-02T00:00:00Z'),
          endedAt: new Date('2026-08-02T01:00:00Z'),
        }),
        interruption({
          id: 2,
          servicePointId: 2,
          startedAt: new Date('2026-08-03T00:00:00Z'),
          endedAt: new Date('2026-08-03T00:30:00Z'),
        }),
      ],
    });
    expect(result.counts.sustainedInterruptions).toBe(2);
    expect(result.counts.sustainedMinutes).toBe(90);
    expect(result.indices.saifi).toBeCloseTo(2 / 3, 4);
    expect(result.indices.saidiMinutes).toBe(30);
    expect(result.indices.caidiMinutes).toBe(45);
    expect(result.indices.customersInterruptedFraction).toBeCloseTo(2 / 3, 4);
    expect(result.indices.asai).toBeCloseTo((3 * PERIOD_MINUTES - 90) / (3 * PERIOD_MINUTES), 6);
    expect(result.basis).toBe('measured');
  });

  it('excludes unmonitored connections from the denominator instead of diluting the index', () => {
    const withUnmonitored = assessReliability({
      period: PERIOD,
      servicePoints: [
        point({ servicePointId: 1 }),
        ...Array.from({ length: 99 }, (_, index) => point({ servicePointId: index + 2, observed: false })),
      ],
      interruptions: [
        interruption({
          id: 1,
          servicePointId: 1,
          startedAt: new Date('2026-08-02T00:00:00Z'),
          endedAt: new Date('2026-08-02T02:00:00Z'),
        }),
      ],
    });
    expect(withUnmonitored.indices.saifi).toBe(1);
    expect(withUnmonitored.indices.saidiMinutes).toBe(120);
    expect(withUnmonitored.coverage.unobservedServicePoints).toBe(99);
    expect(withUnmonitored.limitations.join(' ')).toContain('99 of 100');
  });

  it('counts a sub-five-minute interruption in MAIFI and keeps it out of SAIFI', () => {
    const result = assessReliability({
      period: PERIOD,
      servicePoints: [point({ servicePointId: 1 })],
      interruptions: [
        interruption({
          id: 1,
          servicePointId: 1,
          startedAt: new Date('2026-08-02T00:00:00Z'),
          endedAt: minutesAfter(new Date('2026-08-02T00:00:00Z'), MOMENTARY_THRESHOLD_MINUTES - 1),
        }),
      ],
    });
    expect(result.indices.maifi).toBe(1);
    expect(result.indices.saifi).toBe(0);
    expect(result.indices.saidiMinutes).toBe(0);
    expect(result.indices.asai).toBe(1);
    expect(result.counts.momentaryInterruptions).toBe(1);
  });

  it('counts a five-minute interruption as sustained', () => {
    const result = assessReliability({
      period: PERIOD,
      servicePoints: [point({ servicePointId: 1 })],
      interruptions: [
        interruption({
          id: 1,
          servicePointId: 1,
          startedAt: new Date('2026-08-02T00:00:00Z'),
          endedAt: minutesAfter(new Date('2026-08-02T00:00:00Z'), MOMENTARY_THRESHOLD_MINUTES),
        }),
      ],
    });
    expect(result.indices.saifi).toBe(1);
    expect(result.indices.maifi).toBe(0);
  });

  it('ignores interruptions recorded against connections nobody observes', () => {
    const result = assessReliability({
      period: PERIOD,
      servicePoints: [point({ servicePointId: 1 }), point({ servicePointId: 2, observed: false })],
      interruptions: [
        interruption({
          id: 1,
          servicePointId: 2,
          startedAt: new Date('2026-08-02T00:00:00Z'),
          endedAt: new Date('2026-08-02T06:00:00Z'),
        }),
      ],
    });
    expect(result.counts.sustainedInterruptions).toBe(0);
    expect(result.indices.saifi).toBe(0);
  });
});

describe('assessReliability — lower bounds', () => {
  it('clamps an open interruption at the period end and reports a lower bound', () => {
    const result = assessReliability({
      period: PERIOD,
      servicePoints: [point({ servicePointId: 1 })],
      interruptions: [
        interruption({ id: 1, servicePointId: 1, startedAt: new Date('2026-08-30T00:00:00Z'), endedAt: null }),
      ],
    });
    expect(result.basis).toBe('lower_bound');
    expect(result.coverage.openInterruptions).toBe(1);
    expect(result.indices.saidiMinutes).toBe(24 * 60);
    expect(result.limitations.join(' ')).toContain('lower bound');
  });

  it('clamps an interruption that outlives the period', () => {
    const result = assessReliability({
      period: PERIOD,
      servicePoints: [point({ servicePointId: 1 })],
      interruptions: [
        interruption({
          id: 1,
          servicePointId: 1,
          startedAt: new Date('2026-08-30T00:00:00Z'),
          endedAt: new Date('2026-09-05T00:00:00Z'),
        }),
      ],
    });
    expect(result.indices.saidiMinutes).toBe(24 * 60);
    expect(result.coverage.openInterruptions).toBe(1);
    expect(result.basis).toBe('lower_bound');
  });

  it('counts a mid-period connection pro rata and reports a lower bound', () => {
    const connectedAt = new Date('2026-08-21T00:00:00Z');
    const result = assessReliability({
      period: PERIOD,
      servicePoints: [point({ servicePointId: 1, connectedAt })],
      interruptions: [],
    });
    expect(result.coverage.observedCustomerMinutes).toBe(10 * 24 * 60);
    expect(result.basis).toBe('lower_bound');
    expect(result.limitations.join(' ')).toContain('pro rata');
  });

  it('counts a disconnected connection only while it was supplied', () => {
    const result = assessReliability({
      period: PERIOD,
      servicePoints: [
        point({ servicePointId: 1, disconnectedAt: new Date('2026-08-11T00:00:00Z') }),
      ],
      interruptions: [],
    });
    expect(result.coverage.observedCustomerMinutes).toBe(10 * 24 * 60);
  });

  it('does not count an interruption that ended before the period', () => {
    const result = assessReliability({
      period: PERIOD,
      servicePoints: [point({ servicePointId: 1 })],
      interruptions: [
        interruption({
          id: 1,
          servicePointId: 1,
          startedAt: new Date('2026-07-20T00:00:00Z'),
          endedAt: new Date('2026-07-20T06:00:00Z'),
        }),
      ],
    });
    expect(result.counts.sustainedInterruptions).toBe(0);
    expect(result.basis).toBe('measured');
  });

  it('counts only the in-period portion of an interruption that began earlier', () => {
    const result = assessReliability({
      period: PERIOD,
      servicePoints: [point({ servicePointId: 1 })],
      interruptions: [
        interruption({
          id: 1,
          servicePointId: 1,
          startedAt: new Date('2026-07-31T22:00:00Z'),
          endedAt: new Date('2026-08-01T01:00:00Z'),
        }),
      ],
    });
    expect(result.indices.saidiMinutes).toBe(60);
  });
});

describe('assessReliability — exclusions and attribution', () => {
  it('keeps excluded interruptions visible but out of the indices', () => {
    const result = assessReliability({
      period: PERIOD,
      servicePoints: [point({ servicePointId: 1 })],
      interruptions: [
        interruption({
          id: 1,
          servicePointId: 1,
          startedAt: new Date('2026-08-05T00:00:00Z'),
          endedAt: new Date('2026-08-05T04:00:00Z'),
          excludeFromIndices: true,
        }),
      ],
    });
    expect(result.indices.saifi).toBe(0);
    expect(result.coverage.excludedInterruptions).toBe(1);
    expect(result.coverage.excludedInterruptionMinutes).toBe(240);
    expect(result.limitations.join(' ')).toContain('exceptional days');
  });

  it('reports causes and detection sources separately', () => {
    const result = assessReliability({
      period: PERIOD,
      servicePoints: [point({ servicePointId: 1 }), point({ servicePointId: 2 })],
      interruptions: [
        interruption({
          id: 1,
          servicePointId: 1,
          startedAt: new Date('2026-08-02T00:00:00Z'),
          endedAt: new Date('2026-08-02T03:00:00Z'),
          cause: 'utility_grid_outage',
          detectionSource: 'meter_event',
        }),
        interruption({
          id: 2,
          servicePointId: 2,
          startedAt: new Date('2026-08-04T00:00:00Z'),
          endedAt: new Date('2026-08-04T01:00:00Z'),
          cause: 'storage_depleted',
          detectionSource: 'telemetry_gap',
        }),
      ],
    });
    expect(result.byCause).toEqual([
      { cause: 'utility_grid_outage', interruptions: 1, minutes: 180 },
      { cause: 'storage_depleted', interruptions: 1, minutes: 60 },
    ]);
    expect(result.byDetectionSource).toEqual(
      expect.arrayContaining([
        { detectionSource: 'meter_event', interruptions: 1 },
        { detectionSource: 'telemetry_gap', interruptions: 1 },
      ])
    );
    expect(result.limitations.join(' ')).toContain('gap in meter reporting');
  });

  it('never reports ASAI above one or below zero', () => {
    const result = assessReliability({
      period: PERIOD,
      servicePoints: [point({ servicePointId: 1 })],
      interruptions: [
        interruption({ id: 1, servicePointId: 1, startedAt: PERIOD_START, endedAt: PERIOD_END }),
      ],
    });
    expect(result.indices.asai).toBe(0);
    expect(result.indices.saidiMinutes).toBe(PERIOD_MINUTES);
  });
});
