import { describe, expect, it } from 'vitest';

import {
  describeAdjustment,
  formatNetKw,
  formatNetKwh,
  planVerdict,
  summariseResponses,
} from './price-signal';

describe('describeAdjustment', () => {
  it('asks for less consumption when the price rises', () => {
    expect(describeAdjustment(3.5).label).toBe('+3.50¢ — use less');
  });

  it('asks for more consumption when the price falls', () => {
    const result = describeAdjustment(-2.25);
    expect(result.label).toBe('-2.25¢ — use more');
    expect(result.tone).toBe('good');
  });

  it('does not dress a rounding-level adjustment as a nudge', () => {
    expect(describeAdjustment(0.001).label).toBe('No nudge');
  });
});

describe('formatNetKw', () => {
  it('names the direction rather than relying on a sign', () => {
    expect(formatNetKw(4200)).toBe('4.20 kW import');
    expect(formatNetKw(-4200)).toBe('4.20 kW export');
  });

  it('renders a missing value as unknown, not zero', () => {
    expect(formatNetKw(null)).toBe('—');
    expect(formatNetKw(0)).toBe('0.00 kW');
  });
});

describe('formatNetKwh', () => {
  it('distinguishes imported from exported energy', () => {
    expect(formatNetKwh(1500)).toBe('1.50 kWh imported');
    expect(formatNetKwh(-1500)).toBe('1.50 kWh exported');
    expect(formatNetKwh(null)).toBe('—');
  });
});

describe('planVerdict', () => {
  it('reports a cap-only interval as having no target', () => {
    expect(planVerdict(null, 12000).label).toBe('Cap only');
  });

  it('accepts a plan within two percent of the requested profile', () => {
    expect(planVerdict(100000, 101000).tone).toBe('good');
  });

  it('escalates as the plan drifts from the profile', () => {
    expect(planVerdict(100000, 108000).tone).toBe('warning');
    expect(planVerdict(100000, 130000).tone).toBe('danger');
  });

  it('says which side of the target the fleet plans to sit on', () => {
    expect(planVerdict(100000, 80000).label).toContain('below');
    expect(planVerdict(100000, 130000).label).toContain('above');
  });

  it('does not call a small absolute miss on a near-zero target on target', () => {
    // 2% of a 50 W target is 1 W; the 1 kW floor keeps the verdict honest.
    expect(planVerdict(50, 5050).tone).toBe('danger');
  });
});

describe('summariseResponses', () => {
  const sites = [
    { response: 'followed' as const, plannedNetWh: 1000, actualNetWh: 1050 },
    { response: 'deviated' as const, plannedNetWh: 2000, actualNetWh: 400 },
    { response: 'no_telemetry' as const, plannedNetWh: 3000, actualNetWh: null },
    { response: 'unmeasured' as const, plannedNetWh: 4000, actualNetWh: null },
  ];

  it('counts each outcome separately', () => {
    const summary = summariseResponses(sites);
    expect(summary).toMatchObject({
      followed: 1,
      deviated: 1,
      noTelemetry: 1,
      unmeasured: 1,
    });
  });

  it('excludes unmeasured sites from both sides of the energy comparison', () => {
    const summary = summariseResponses(sites);
    expect(summary.measuredPlannedWh).toBe(3000);
    expect(summary.measuredActualWh).toBe(1450);
  });

  it('reports zero measured energy when nothing was metered', () => {
    const summary = summariseResponses([
      { response: 'no_telemetry', plannedNetWh: 9000, actualNetWh: null },
    ]);
    expect(summary.measuredPlannedWh).toBe(0);
    expect(summary.measuredActualWh).toBe(0);
    expect(summary.noTelemetry).toBe(1);
  });
});
