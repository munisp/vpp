/**
 * Forecast accuracy was never measured: every run stored null MAE/RMSE/MAPE while
 * advertising a confidence derived from the model's own residuals. These tests pin
 * the scoring semantics that replace it:
 *  - the P50 is scored against actuals, with bias kept separate from magnitude
 *  - P10-P90 coverage is measured so a stated uncertainty can be checked
 *  - a forecast time is only paired with an actual from the same interval
 *  - too few actuals is recorded as insufficient_actuals, never scored anyway
 *  - a zero actual is excluded from MAPE instead of counting as a 100% error
 */

import { describe, it, expect } from 'vitest';
import {
  MIN_SCORING_SAMPLES,
  ForecastScoringError,
  actualSourceFor,
  computeMetrics,
  pairWithActuals,
  type ScoredPair,
} from './services/forecast-accuracy';

function at(minutes: number): Date {
  return new Date(Date.UTC(2026, 2, 1, 12, minutes, 0));
}

function pair(actual: number, p50: number, p10 = p50 - 10, p90 = p50 + 10): ScoredPair {
  return { timestamp: at(0), actual, p10, p50, p90 };
}

describe('computeMetrics', () => {
  it('separates magnitude of error from direction', () => {
    // Errors of +20 and -20: accurate on average, wrong every time.
    const metrics = computeMetrics([pair(100, 120), pair(100, 80)]);

    expect(metrics.mae).toBe(20);
    expect(metrics.bias).toBe(0);
    expect(metrics.rmse).toBe(20);
  });

  it('reports a forecast that consistently runs high as positive bias', () => {
    const metrics = computeMetrics([pair(100, 130), pair(200, 230)]);

    expect(metrics.bias).toBe(30);
    expect(metrics.mae).toBe(30);
  });

  it('measures how often the actual fell inside the advertised band', () => {
    const metrics = computeMetrics([
      pair(100, 100), // inside 90-110
      pair(100, 100),
      pair(100, 100),
      pair(500, 100), // far outside
    ]);

    // Three of four inside an 80% band: 7500bp against a 8000bp target.
    expect(metrics.coverageBp).toBe(7500);
    expect(metrics.intervalWidth).toBe(20);
  });

  it('excludes zero actuals from MAPE instead of dividing by them', () => {
    // A night-time solar interval forecast at 0 is not a 100% error.
    const metrics = computeMetrics([pair(0, 0), pair(100, 110)]);

    expect(metrics.mapeBp).toBe(1000); // 10% over the one measurable pair
    expect(metrics.mae).toBe(5); // both pairs still count towards absolute error
  });

  it('reports no MAPE at all when every actual was zero', () => {
    const metrics = computeMetrics([pair(0, 5), pair(0, 5)]);

    expect(metrics.mapeBp).toBeNull();
    expect(metrics.mae).toBe(5);
  });

  it('refuses to compute metrics over an empty series', () => {
    expect(() => computeMetrics([])).toThrow(ForecastScoringError);
  });
});

describe('pairWithActuals', () => {
  const values = [
    { timestamp: at(0), p10: 90, p50: 100, p90: 110 },
    { timestamp: at(15), p10: 90, p50: 100, p90: 110 },
  ];

  it('matches each forecast time to the nearest actual in its own interval', () => {
    const pairs = pairWithActuals(
      values,
      [
        { timestamp: at(2), value: 120 },
        { timestamp: at(14), value: 130 },
      ],
      15
    );

    expect(pairs.map((p) => p.actual)).toEqual([120, 130]);
  });

  it('drops an actual from a different interval rather than scoring against it', () => {
    // 10 minutes away exceeds half of a 15-minute interval.
    const pairs = pairWithActuals(values, [{ timestamp: at(10), value: 120 }], 15);

    expect(pairs.map((p) => p.timestamp.toISOString())).toEqual([at(15).toISOString()]);
  });

  it('pairs nothing when no actuals arrived', () => {
    expect(pairWithActuals(values, [], 15)).toEqual([]);
  });

  it('needs more than a couple of pairs before a score means anything', () => {
    const pairs = pairWithActuals(values, [{ timestamp: at(0), value: 120 }], 15);

    expect(pairs.length).toBeLessThan(MIN_SCORING_SAMPLES);
  });
});

describe('actualSourceFor', () => {
  it('scores site load against telemetry and regional load against grid monitoring', () => {
    expect(actualSourceFor('load', 'asset')).toBe('telemetry');
    expect(actualSourceFor('load', 'region')).toBe('grid_monitoring');
  });

  it('scores prices and emissions against their own series', () => {
    expect(actualSourceFor('price', 'region')).toBe('market_prices');
    expect(actualSourceFor('emissions', 'region')).toBe('emissions_factors');
  });

  it('refuses a forecast type with no actuals series instead of picking one', () => {
    expect(() => actualSourceFor('customer_satisfaction', 'region')).toThrow(
      /No actuals series is defined/
    );
  });
});
