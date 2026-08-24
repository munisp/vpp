import { describe, expect, it } from 'vitest';

import { SCALES, inputDigest } from './design-study';

/**
 * The digest is what makes "two studies with identical inputs produce identical
 * outputs" checkable after the fact: it is taken over the frozen request, so if
 * two versions share a digest and disagree on their numbers, the engine is at
 * fault rather than the assumptions. These tests hold the two properties the
 * rest of the audit trail leans on — key order must not matter, and no input a
 * lender would ask about may fall outside the hash.
 */

const request = {
  interval_minutes: 60,
  load: { source: 'declared', load_w: [1000, 2000], reference: 'survey' },
  economics: { discount_rate_percent: 12, project_years: 20 },
  backup: { kind: 'genset', energy_cost_cents_per_kwh: 80 },
  sweep: { pv_kw: [0, 10], battery_kwh: [0, 20] },
  max_unmet_fraction: 0.05,
};

describe('design study input digest', () => {
  it('is stable across key order, so a rewritten client does not look like a new study', () => {
    const reordered = {
      max_unmet_fraction: 0.05,
      sweep: { battery_kwh: [0, 20], pv_kw: [0, 10] },
      backup: { energy_cost_cents_per_kwh: 80, kind: 'genset' },
      economics: { project_years: 20, discount_rate_percent: 12 },
      load: { reference: 'survey', load_w: [1000, 2000], source: 'declared' },
      interval_minutes: 60,
    };

    expect(inputDigest(reordered)).toBe(inputDigest(request));
  });

  it('keeps series order significant, because a profile is not a set of numbers', () => {
    const reversed = {
      ...request,
      load: { ...request.load, load_w: [2000, 1000] },
    };

    expect(inputDigest(reversed)).not.toBe(inputDigest(request));
  });

  it('changes when the diesel price changes, so a new price is a new study version', () => {
    const dearerFuel = {
      ...request,
      backup: { ...request.backup, energy_cost_cents_per_kwh: 120 },
    };

    expect(inputDigest(dearerFuel)).not.toBe(inputDigest(request));
  });

  it('distinguishes a stated assumption from an absent one', () => {
    const withTariff = { ...request, tariff_cents_per_kwh: 60 };
    const withoutTariff = { ...request, tariff_cents_per_kwh: null };

    expect(inputDigest(withTariff)).not.toBe(inputDigest(withoutTariff));
    expect(inputDigest(withoutTariff)).not.toBe(inputDigest(request));
  });

  it('is a sha-256 hex digest, so it can be quoted in a report', () => {
    expect(inputDigest(request)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('stored scales', () => {
  it('names the scales the columns are written at, in one place', () => {
    expect(SCALES.centsPerKwhX100).toBe(100);
    expect(SCALES.monthsPerYear).toBe(12);
    expect(SCALES.partsPerMillion).toBe(1_000_000);
  });
});
