/**
 * The UI copy is part of the safety story here: an award is a promise, and the
 * screen must never let it read as measured delivery, nor let a window nobody
 * could measure read as non-performance.
 */

import { describe, expect, it } from 'vitest';

import {
  canSettle,
  clearedShare,
  describeAwardEvidence,
  describeNodeCapacity,
  describeRequirementCoverage,
  formatPrice,
} from './locational-flexibility';

describe('clearedShare', () => {
  it('measures awarded capacity against the requirement, not against delivery', () => {
    expect(clearedShare({ requiredPowerW: 12000, clearedPowerW: 8000 })).toBeCloseTo(0.667, 3);
    expect(clearedShare({ requiredPowerW: 0, clearedPowerW: 0 })).toBeNull();
  });
});

describe('describeRequirementCoverage', () => {
  it('calls a short clearing short instead of dressing it as cleared', () => {
    const verdict = describeRequirementCoverage({
      status: 'short',
      requiredPowerW: 12000,
      clearedPowerW: 8000,
      awards: 2,
      unverifiedAwards: 0,
      ineligibleOffers: 1,
    });
    expect(verdict.tone).toBe('danger');
    expect(verdict.label).toContain('67%');
    expect(verdict.meaning).toContain('8.00 kW of 12.00 kW');
    expect(verdict.meaning).toContain('1 offer could not be awarded');
  });

  it('separates unproven relief from missing relief', () => {
    const verdict = describeRequirementCoverage({
      status: 'cleared',
      requiredPowerW: 8000,
      clearedPowerW: 8000,
      awards: 2,
      unverifiedAwards: 1,
      ineligibleOffers: 0,
    });
    expect(verdict.tone).toBe('warning');
    expect(verdict.meaning).toContain('1 of 2 awards has no measurable delivery');
  });
});

describe('describeAwardEvidence', () => {
  it('never shows an unmeasured award as delivery', () => {
    const verdict = describeAwardEvidence({
      deliveryStatus: 'unmeasured',
      awardedPowerW: 4000,
      deliveredPowerW: null,
      deliveredEnergyWh: null,
      measuredSamples: 0,
      unverifiedReason: null,
      settled: false,
    });
    expect(verdict.label).toBe('Not measured yet');
    expect(verdict.meaning).toContain('never evidence');
  });

  it('names the missing telemetry behind an unverified window', () => {
    const verdict = describeAwardEvidence({
      deliveryStatus: 'unverified',
      awardedPowerW: 4000,
      deliveredPowerW: null,
      deliveredEnergyWh: null,
      measuredSamples: 0,
      unverifiedReason: 'Only 0 telemetry samples in the delivery window (need 2)',
      settled: false,
    });
    expect(verdict.tone).toBe('danger');
    expect(verdict.meaning).toContain('neither performance nor breach');
    expect(verdict.meaning).toContain('Only 0 telemetry samples');
  });

  it('states the measured figure next to the award for a partial delivery', () => {
    const verdict = describeAwardEvidence({
      deliveryStatus: 'partial',
      awardedPowerW: 4000,
      deliveredPowerW: 1500,
      deliveredEnergyWh: 1500,
      measuredSamples: 4,
      unverifiedReason: null,
      settled: true,
    });
    expect(verdict.label).toBe('Partial · settled');
    expect(verdict.meaning).toContain('Measured 1.50 kW against an award of 4.00 kW');
    expect(verdict.meaning).toContain('credited 1.50 kWh');
  });
});

describe('canSettle', () => {
  it('offers settlement only for measured delivery, and only once', () => {
    expect(canSettle({ deliveryStatus: 'delivered', settled: false })).toBe(true);
    expect(canSettle({ deliveryStatus: 'partial', settled: false })).toBe(true);
    expect(canSettle({ deliveryStatus: 'delivered', settled: true })).toBe(false);
    expect(canSettle({ deliveryStatus: 'unverified', settled: false })).toBe(false);
    expect(canSettle({ deliveryStatus: 'not_delivered', settled: false })).toBe(false);
    expect(canSettle({ deliveryStatus: 'unmeasured', settled: false })).toBe(false);
  });
});

describe('describeNodeCapacity', () => {
  it('keeps unverified capacity out of the sellable figure', () => {
    const verdict = describeNodeCapacity({
      awardableRatedW: 9000,
      unverifiedRatedW: 6000,
      linkedAssets: 3,
      unverifiedAssets: 1,
    });
    expect(verdict.label).toBe('9.00 kW');
    expect(verdict.tone).toBe('warning');
    expect(verdict.meaning).toContain('Nameplate ratings, not measured availability');
    expect(verdict.meaning).toContain('6.00 kW sits behind 1 unverified link');
  });
});

describe('formatPrice', () => {
  it('unscales the stored price', () => {
    expect(formatPrice(1200, 'TZS')).toBe('12.00 TZS/kWh');
  });
});
