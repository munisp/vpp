/**
 * The whole point of these helpers is that a fleet figure never reaches the
 * screen without its blind spot attached, so the tests pin exactly that: silence
 * is surfaced by rated capacity, an unknown state of charge makes stored energy
 * a floor, an unelapsed bucket is not evidence, and a stalled rollup does not
 * read as an idle fleet.
 */

import { describe, expect, it } from 'vitest';

import {
  BUCKET_STATE_COPY,
  coverageVerdict,
  describeAvailableEnergy,
  formatFleetKw,
  formatFleetKwh,
  summariseSeries,
  type FleetBucket,
} from './fleet-telemetry';

function bucket(overrides: Partial<FleetBucket> = {}): FleetBucket {
  return {
    bucketStartsAt: '2026-03-01T10:00:00.000Z',
    bucketMinutes: 15,
    state: 'closed',
    meanNetPowerWatts: -8000,
    integratedEnergyWh: -2000,
    expectedAssets: 4,
    reportingAssets: 4,
    silentAssets: 0,
    samples: 40,
    reportingCapacityWh: 40000,
    silentCapacityWh: 0,
    socKnownAssets: 4,
    socUnknownAssets: 0,
    availableEnergyWh: 16000,
    computedAt: '2026-03-01T10:16:00.000Z',
    ...overrides,
  };
}

describe('coverageVerdict', () => {
  it('calls full coverage only when every asset reported', () => {
    const verdict = coverageVerdict(bucket());
    expect(verdict.tone).toBe('good');
    expect(verdict.capacityShare).toBe(1);
  });

  it('measures the blind spot by rated capacity, not asset count', () => {
    // One silent 20 kWh battery out of five assets: 4/5 assets reported, but
    // only a third of the rated capacity did.
    const verdict = coverageVerdict(
      bucket({
        expectedAssets: 5,
        reportingAssets: 4,
        silentAssets: 1,
        reportingCapacityWh: 10000,
        silentCapacityWh: 20000,
      })
    );
    expect(verdict.tone).toBe('danger');
    expect(verdict.capacityShare).toBeCloseTo(1 / 3);
    expect(verdict.label).toContain('33%');
    expect(verdict.meaning).toContain('20.0 kWh');
  });

  it('warns rather than reassures at 90-99% coverage', () => {
    const verdict = coverageVerdict(
      bucket({
        expectedAssets: 10,
        reportingAssets: 9,
        silentAssets: 1,
        reportingCapacityWh: 95000,
        silentCapacityWh: 5000,
      })
    );
    expect(verdict.tone).toBe('warning');
  });

  it('says nothing reported instead of showing a quiet fleet', () => {
    const verdict = coverageVerdict(
      bucket({
        reportingAssets: 0,
        silentAssets: 4,
        samples: 0,
        meanNetPowerWatts: 0,
        integratedEnergyWh: 0,
        reportingCapacityWh: 0,
        silentCapacityWh: 40000,
      })
    );
    expect(verdict.tone).toBe('danger');
    expect(verdict.label).toBe('Nothing reported');
    expect(verdict.meaning).toContain('not a quiet fleet');
  });

  it('distinguishes an empty scope from a silent one', () => {
    const verdict = coverageVerdict(
      bucket({
        expectedAssets: 0,
        reportingAssets: 0,
        silentAssets: 0,
        reportingCapacityWh: 0,
        silentCapacityWh: 0,
      })
    );
    expect(verdict.label).toBe('Nothing in scope');
    expect(verdict.capacityShare).toBeNull();
  });
});

describe('describeAvailableEnergy', () => {
  it('reports stored energy as a floor when a state of charge is missing', () => {
    const described = describeAvailableEnergy(
      bucket({ socKnownAssets: 3, socUnknownAssets: 1, availableEnergyWh: 12000 })
    );
    expect(described.label).toBe('≥ 12.0 kWh');
    expect(described.tone).toBe('warning');
    expect(described.meaning).toContain('floor');
  });

  it('reports an exact figure only when every battery answered', () => {
    const described = describeAvailableEnergy(bucket());
    expect(described.label).toBe('16.0 kWh');
    expect(described.tone).toBe('good');
  });

  it('flags danger when no battery reported a state of charge', () => {
    const described = describeAvailableEnergy(
      bucket({ socKnownAssets: 0, socUnknownAssets: 4, availableEnergyWh: 0 })
    );
    expect(described.tone).toBe('danger');
    expect(described.label).toBe('≥ 0.0 kWh');
  });
});

describe('formatting', () => {
  it('keeps the generation-positive direction explicit', () => {
    expect(formatFleetKw(-8000)).toBe('8.00 kW consuming');
    expect(formatFleetKw(8000)).toBe('8.00 kW generating');
    expect(formatFleetKw(0)).toBe('0.00 kW');
    expect(formatFleetKwh(-2000)).toBe('2.00 kWh consumed');
    expect(formatFleetKwh(2000)).toBe('2.00 kWh generated');
  });
});

describe('summariseSeries', () => {
  it('never treats an unelapsed bucket as evidence', () => {
    expect(BUCKET_STATE_COPY.open.tone).toBe('warning');
    const summary = summariseSeries(
      [
        bucket(),
        bucket({
          state: 'open',
          reportingAssets: 1,
          silentAssets: 3,
          reportingCapacityWh: 10000,
          silentCapacityWh: 30000,
        }),
      ],
      0
    );
    expect(summary.closedBuckets).toBe(1);
    expect(summary.openBuckets).toBe(1);
    // The open bucket's thin coverage is not the worst *measured* coverage.
    expect(summary.worstCapacityShare).toBe(1);
    expect(summary.bucketsWithSilence).toBe(1);
  });

  it('reports buckets that were never rolled up separately from the fleet', () => {
    const summary = summariseSeries([bucket()], 11);
    expect(summary.missingBuckets).toBe(11);
    expect(summary.closedBuckets).toBe(1);
  });

  it('carries the worst measured coverage across closed buckets', () => {
    const summary = summariseSeries(
      [
        bucket(),
        bucket({
          reportingAssets: 2,
          silentAssets: 2,
          reportingCapacityWh: 20000,
          silentCapacityWh: 20000,
        }),
      ],
      0
    );
    expect(summary.worstCapacityShare).toBe(0.5);
    expect(summary.latest?.silentAssets).toBe(2);
  });
});
