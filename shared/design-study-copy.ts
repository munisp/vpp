/**
 * One vocabulary for design studies, shared by the PWA and the mobile app.
 *
 * A design study is read by people about to commit capital, so the distinction
 * that matters is between "this is what the engine concluded from these inputs"
 * and "nothing was concluded". Only `optimal` carries a sizing; the other three
 * exist so a refusal is legible instead of being rendered as an empty result,
 * and so nobody reads a missing number as a zero cost.
 */

export type DesignStudyStatus =
  | 'optimal'
  | 'no_feasible_candidate'
  | 'service_unavailable'
  | 'refused';

export type ProfileSource = 'metered' | 'declared' | 'sourced' | 'synthetic';

export type Tone = 'good' | 'warning' | 'bad' | 'neutral';

export interface StatusCopy {
  label: string;
  tone: Tone;
  /** What a reader may conclude from this status — and what they may not. */
  meaning: string;
}

export const DESIGN_STATUS_COPY: Record<DesignStudyStatus, StatusCopy> = {
  optimal: {
    label: 'Sized',
    tone: 'good',
    meaning:
      'One candidate met the unserved-energy limit at the lowest levelised cost. The sizing, cost and payback below follow from the frozen assumptions on this version and nothing else.',
  },
  no_feasible_candidate: {
    label: 'Nothing met the limit',
    tone: 'warning',
    meaning:
      'Every candidate left more energy unserved than the study allowed, so there is no recommendation. The candidates are still listed with how far off each one was.',
  },
  service_unavailable: {
    label: 'Not run',
    tone: 'warning',
    meaning:
      'The sizing engine could not be reached, so no study was run. This is not a finding about the site.',
  },
  refused: {
    label: 'Refused',
    tone: 'bad',
    meaning:
      'The study was not run because an input it cannot invent was missing — most often a load profile for a site that is neither metered nor declared.',
  },
};

export const PROFILE_SOURCE_COPY: Record<ProfileSource, StatusCopy> = {
  metered: {
    label: 'Metered',
    tone: 'good',
    meaning: 'Read from this site\u2019s own telemetry over the window named beside it.',
  },
  declared: {
    label: 'Declared',
    tone: 'neutral',
    meaning:
      'Stated by the developer, agency or community. The study is exactly as good as this declaration.',
  },
  sourced: {
    label: 'Sourced',
    tone: 'neutral',
    meaning:
      'Taken from a named external dataset — a resource database or a published profile — not measured here.',
  },
  synthetic: {
    label: 'Synthetic',
    tone: 'warning',
    meaning:
      'Generated, not observed. Usable to compare options against each other; not evidence of what this site will do.',
  },
};

export function centsPerKwhLabel(x100: number | null): string {
  if (x100 === null) return 'not costed';
  return `${(x100 / 100).toFixed(1)}c/kWh`;
}

export function paybackLabel(months: number | null): string {
  if (months === null) return 'no payback';
  if (months < 24) return `${months} months`;
  return `${(months / 12).toFixed(1)} years`;
}

export function wattsLabel(watts: number | null): string {
  if (watts === null) return '—';
  if (Math.abs(watts) >= 1_000_000) return `${(watts / 1_000_000).toFixed(2)} MW`;
  if (Math.abs(watts) >= 1_000) return `${(watts / 1_000).toFixed(1)} kW`;
  return `${Math.round(watts)} W`;
}

export function wattHoursLabel(wh: number | null): string {
  if (wh === null) return '—';
  if (Math.abs(wh) >= 1_000_000) return `${(wh / 1_000_000).toFixed(2)} MWh`;
  if (Math.abs(wh) >= 1_000) return `${(wh / 1_000).toFixed(1)} kWh`;
  return `${Math.round(wh)} Wh`;
}

export function unmetLabel(ppm: number | null): string {
  if (ppm === null) return 'not assessed';
  return `${(ppm / 10_000).toFixed(2)}% unserved`;
}

export function moneyLabel(cents: number | null, currency = ''): string {
  if (cents === null) return 'not costed';
  const major = cents / 100;
  if (Math.abs(major) >= 1_000_000) return `${currency}${(major / 1_000_000).toFixed(2)}m`;
  if (Math.abs(major) >= 1_000) return `${currency}${(major / 1_000).toFixed(1)}k`;
  return `${currency}${major.toFixed(0)}`;
}
