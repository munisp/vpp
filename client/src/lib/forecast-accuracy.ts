/**
 * Shared vocabulary for forecast accuracy in the UI.
 *
 * Two rules the wording must keep: a forecast whose actuals never arrived is
 * shown as unmeasured rather than as a good score, and calibration is never
 * shown without the band width that produced it — a forecast that answers
 * "somewhere between 0 and 10 MW" is perfectly calibrated and useless.
 */

export type AccuracyTone = 'good' | 'warning' | 'danger' | 'neutral';

export interface AccuracySummaryRow {
  forecastType: string;
  scopeType: string;
  scopeId: number | null;
  modelVersion: string;
  scoredRuns: number;
  sampleCount: number;
  mae: number | null;
  rmse: number | null;
  mapeBp: number | null;
  bias: number | null;
  coverageBp: number | null;
  intervalWidth: number | null;
  unmeasuredRuns: number;
  lastScoredAt: string | Date | null;
}

export const FORECAST_TYPE_LABEL: Record<string, string> = {
  load: 'Load',
  solar_generation: 'Solar generation',
  wind_generation: 'Wind generation',
  net_load: 'Net load',
  price: 'Price',
  emissions: 'Grid emissions',
};

/** What the numbers were compared against, so the score is auditable. */
export const ACTUAL_SOURCE_LABEL: Record<string, string> = {
  telemetry: 'device telemetry',
  grid_monitoring: 'grid monitoring',
  market_prices: 'settled market prices',
  emissions_factors: 'published emissions factors',
};

export function formatPercent(bp: number | null | undefined): string {
  if (bp == null) return 'not measured';
  return `${(bp / 100).toFixed(1)}%`;
}

/** Signed, because a forecast that always runs low costs money in one direction. */
export function formatBias(bias: number | null | undefined, unit: string): string {
  if (bias == null) return 'not measured';
  const rounded = Math.abs(bias) < 0.05 ? 0 : bias;
  if (rounded === 0) return 'balanced';
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)} ${unit} ${rounded > 0 ? 'high' : 'low'}`;
}

export function formatMagnitude(value: number | null | undefined, unit: string): string {
  if (value == null) return 'not measured';
  return `${value.toFixed(1)} ${unit}`;
}

/** Load and generation forecasts are in watts; price and emissions are not. */
export function unitFor(forecastType: string): string {
  switch (forecastType) {
    case 'load':
    case 'solar_generation':
    case 'wind_generation':
    case 'net_load':
      return 'W';
    case 'price':
      return '/kWh';
    case 'emissions':
      return 'g/kWh';
    default:
      return '';
  }
}

/**
 * How far measured coverage sits from the advertised 80% band.
 *
 * Under-coverage is the dangerous direction: the forecast claimed more certainty
 * than it earned. Over-coverage means the band is wider than it needs to be.
 */
export function coverageVerdict(
  coverageBp: number | null,
  targetBp: number
): { label: string; tone: AccuracyTone; meaning: string } {
  if (coverageBp == null) {
    return {
      label: 'Not measured',
      tone: 'neutral',
      meaning: 'No actuals have been paired with this forecast yet.',
    };
  }

  const drift = coverageBp - targetBp;
  if (drift < -1500) {
    return {
      label: 'Overconfident',
      tone: 'danger',
      meaning: `Actuals landed inside the stated band only ${formatPercent(coverageBp)} of the time against a ${formatPercent(targetBp)} target. Dispatch commitments based on this band will be missed.`,
    };
  }
  if (drift < -500) {
    return {
      label: 'Slightly overconfident',
      tone: 'warning',
      meaning: `Coverage is ${formatPercent(coverageBp)} against a ${formatPercent(targetBp)} target; the band is narrower than the real uncertainty.`,
    };
  }
  if (drift > 1500) {
    return {
      label: 'Over-wide band',
      tone: 'warning',
      meaning: `Coverage is ${formatPercent(coverageBp)} against a ${formatPercent(targetBp)} target — well calibrated but too vague to bid on.`,
    };
  }
  return {
    label: 'Calibrated',
    tone: 'good',
    meaning: `Actuals fell inside the stated band ${formatPercent(coverageBp)} of the time, matching the ${formatPercent(targetBp)} target.`,
  };
}

/**
 * Whether a row's numbers are worth acting on at all.
 *
 * A type with two scored runs and forty unmeasured ones is not accurate; it is
 * unmeasured, and this is the check that keeps the UI from implying otherwise.
 */
export function measurementConfidence(
  row: Pick<AccuracySummaryRow, 'scoredRuns' | 'unmeasuredRuns' | 'sampleCount'>,
  minScoringSamples: number
): { label: string; tone: AccuracyTone; meaning: string } {
  const total = row.scoredRuns + row.unmeasuredRuns;
  if (row.scoredRuns === 0) {
    return {
      label: 'Unmeasured',
      tone: 'neutral',
      meaning:
        total === 0
          ? 'No forecast runs have been scored in this window.'
          : `${total} run${total === 1 ? '' : 's'} produced no usable actuals, so accuracy is unknown.`,
    };
  }
  if (row.sampleCount < minScoringSamples * 4 || row.unmeasuredRuns > row.scoredRuns) {
    return {
      label: 'Thin evidence',
      tone: 'warning',
      meaning: `Measured on ${row.sampleCount} paired point${row.sampleCount === 1 ? '' : 's'} across ${row.scoredRuns} run${row.scoredRuns === 1 ? '' : 's'}, with ${row.unmeasuredRuns} unmeasured. Treat these figures as indicative.`,
    };
  }
  return {
    label: 'Measured',
    tone: 'good',
    meaning: `Measured on ${row.sampleCount} paired points across ${row.scoredRuns} runs.`,
  };
}
