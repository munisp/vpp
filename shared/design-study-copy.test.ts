import { describe, expect, it } from 'vitest';

import {
  DESIGN_STATUS_COPY,
  PROFILE_SOURCE_COPY,
  centsPerKwhLabel,
  moneyLabel,
  paybackLabel,
  unmetLabel,
  wattHoursLabel,
  wattsLabel,
  type DesignStudyStatus,
  type ProfileSource,
} from './design-study-copy';

const STATUSES: DesignStudyStatus[] = [
  'optimal',
  'no_feasible_candidate',
  'service_unavailable',
  'refused',
];

const SOURCES: ProfileSource[] = ['metered', 'declared', 'sourced', 'synthetic'];

describe('design study copy', () => {
  it('reads well only for the one status that carries a sizing', () => {
    for (const status of STATUSES) {
      const tone = DESIGN_STATUS_COPY[status].tone;
      if (status === 'optimal') expect(tone).toBe('good');
      else expect(tone).not.toBe('good');
    }
  });

  it('says of every status what a reader may conclude from it', () => {
    for (const status of STATUSES) {
      const copy = DESIGN_STATUS_COPY[status];
      expect(copy.label.length).toBeGreaterThan(0);
      expect(copy.meaning.length).toBeGreaterThan(40);
    }
  });

  it('never describes generated demand as observed', () => {
    expect(PROFILE_SOURCE_COPY.synthetic.tone).toBe('warning');
    expect(PROFILE_SOURCE_COPY.synthetic.meaning).toMatch(/not observed/i);
    expect(PROFILE_SOURCE_COPY.metered.tone).toBe('good');
    for (const source of SOURCES) {
      expect(PROFILE_SOURCE_COPY[source].meaning.length).toBeGreaterThan(20);
    }
  });

  it('renders a missing figure as missing, never as zero', () => {
    expect(centsPerKwhLabel(null)).toBe('not costed');
    expect(paybackLabel(null)).toBe('no payback');
    expect(unmetLabel(null)).toBe('not assessed');
    expect(moneyLabel(null)).toBe('not costed');
    expect(wattsLabel(null)).toBe('—');
    expect(wattHoursLabel(null)).toBe('—');

    expect(centsPerKwhLabel(0)).toBe('0.0c/kWh');
    expect(paybackLabel(0)).toBe('0 months');
    expect(unmetLabel(0)).toBe('0.00% unserved');
    expect(wattsLabel(0)).toBe('0 W');
  });

  it('scales the stored integers back to the units they were entered in', () => {
    expect(centsPerKwhLabel(4250)).toBe('42.5c/kWh');
    expect(paybackLabel(18)).toBe('18 months');
    expect(paybackLabel(54)).toBe('4.5 years');
    expect(unmetLabel(12_500)).toBe('1.25% unserved');
    expect(wattsLabel(45_000)).toBe('45.0 kW');
    expect(wattsLabel(2_500_000)).toBe('2.50 MW');
    expect(wattHoursLabel(120_000)).toBe('120.0 kWh');
    expect(moneyLabel(123_456_700)).toBe('1.23m');
  });
});
