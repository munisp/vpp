import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/**
 * The optimizer ignores nothing it is sent any more, but this pair of files is
 * where a silent mismatch used to be possible: an economics key spelled one way
 * here and another way in the Python model was dropped, and the study answered
 * on a default capex nobody stated. Read both sides and compare the names.
 */
describe('optimizer economics wire format', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const serviceSource = readFileSync(join(here, 'design-study.ts'), 'utf8');
  const schemaSource = readFileSync(
    join(here, '../../services/optimizer/optimizer/design_schemas.py'),
    'utf8'
  );

  function sentEconomicsKeys(): string[] {
    const body = serviceSource.slice(
      serviceSource.indexOf('function optimizerRequest'),
      serviceSource.indexOf('const sweep:')
    );
    return [...body.matchAll(/'([a-z0-9_]+)'/g)].map(match => match[1]);
  }

  function pythonEconomicsFields(): string[] {
    const body = schemaSource.slice(
      schemaSource.indexOf('class Economics('),
      schemaSource.indexOf('class SizingSweep(')
    );
    return [...body.matchAll(/^ {4}([a-z0-9_]+):/gm)].map(match => match[1]);
  }

  it('sends only assumption names the optimizer declares', () => {
    const declared = pythonEconomicsFields();
    expect(declared).toContain('backup_capex_cents_per_kw');
    expect(declared).toContain('battery_replacement_cost_fraction');

    const sent = sentEconomicsKeys();
    expect(sent.length).toBeGreaterThan(5);
    expect(sent.filter(key => !declared.includes(key))).toEqual([]);
  });
});

describe('stored scales', () => {
  it('names the scales the columns are written at, in one place', () => {
    expect(SCALES.centsPerKwhX100).toBe(100);
    expect(SCALES.monthsPerYear).toBe(12);
    expect(SCALES.partsPerMillion).toBe(1_000_000);
  });
});
