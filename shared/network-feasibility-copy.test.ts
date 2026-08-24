import { describe, expect, it } from 'vitest';

import {
  FEASIBILITY_STATUS_COPY,
  isNetworkChecked,
  networkCheckCaveat,
  violationKindLabel,
  wattsLabel,
  type FeasibilityStatus,
} from './network-feasibility-copy';

const STATUSES: FeasibilityStatus[] = [
  'feasible',
  'violations',
  'model_unavailable',
  'not_converged',
  'service_unavailable',
];

describe('network feasibility copy', () => {
  it('counts only a solved, within-limits study as checked', () => {
    for (const status of STATUSES) {
      expect(isNetworkChecked(status)).toBe(status === 'feasible');
    }
  });

  it('treats a missing status as unchecked rather than as a pass', () => {
    expect(isNetworkChecked(null)).toBe(false);
    expect(isNetworkChecked(undefined)).toBe(false);
    expect(networkCheckCaveat(null)).toContain('unchecked');
    expect(networkCheckCaveat(undefined)).toContain('unchecked');
  });

  it('carries a caveat for every state except a solved pass', () => {
    expect(networkCheckCaveat('feasible')).toBeNull();
    for (const status of STATUSES.filter(candidate => candidate !== 'feasible')) {
      expect(networkCheckCaveat(status)).toContain('Network-unchecked');
    }
  });

  it('never describes a non-solving state in the good tone', () => {
    for (const status of STATUSES) {
      const tone = FEASIBILITY_STATUS_COPY[status].tone;
      if (status === 'feasible') expect(tone).toBe('good');
      else expect(tone).not.toBe('good');
    }
  });

  it('explains every state in words an operator can act on', () => {
    for (const status of STATUSES) {
      const copy = FEASIBILITY_STATUS_COPY[status];
      expect(copy.label.length).toBeGreaterThan(0);
      expect(copy.meaning.length).toBeGreaterThan(20);
    }
  });

  it('names a violation kind, and passes an unknown kind through rather than dropping it', () => {
    expect(violationKindLabel('transformer_loading')).not.toBe('transformer_loading');
    expect(violationKindLabel('something_new')).toContain('something');
  });

  it('shows an absent measurement as unknown, not as zero watts', () => {
    expect(wattsLabel(null)).toBe('—');
    expect(wattsLabel(undefined)).toBe('—');
    expect(wattsLabel(Number.NaN)).toBe('—');
    expect(wattsLabel(0)).toBe('0.0 kW');
    expect(wattsLabel(65_500)).toBe('65.5 kW');
  });
});
