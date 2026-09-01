/**
 * Pinning tests for the forecasting audit fixes:
 *  - M8: SeasonalModel extrapolates its trend from the END of the fitted
 *    history (index historyLength + horizonIndex). Fitting on indices 0..n-1
 *    and then evaluating the trend at horizonIndex reported the already-seen
 *    past as the forecast.
 *  - M9: countryForRegion maps only the regions the platform operates in
 *    (NG/TZ) and fails loudly on anything else instead of silently defaulting
 *    to one country's market prices.
 */

import { describe, it, expect } from 'vitest';
import { SeasonalModel, countryForRegion, type HistoricalDataPoint } from './services/probabilistic-forecasting';

/**
 * Weekly-spaced history (same hour, same day-of-week) with value == index, so
 * the trend is exactly value = i and the seasonal terms collapse to the mean.
 */
function linearHistory(n: number): HistoricalDataPoint[] {
  const sunday = Date.UTC(2024, 0, 7, 10, 0, 0); // a Sunday, 10:00 UTC
  return Array.from({ length: n }, (_, i) => ({
    timestamp: new Date(sunday + i * 7 * 24 * 60 * 60 * 1000),
    value: i,
  }));
}

describe('SeasonalModel trend extrapolation (M8)', () => {
  it('projects the trend forward from the end of the history, not from index 0', () => {
    const n = 100;
    const model = new SeasonalModel();
    model.fit(linearHistory(n));

    // At horizonIndex 200 the trend weight is 0.5. Fixed behaviour evaluates
    // the (exact) trend at index n + 200 = 300 -> 300; the seasonal part is the
    // history mean 49.5. The buggy behaviour evaluated it at index 200 -> 200.
    const forecastTime = new Date(Date.UTC(2024, 0, 7, 10, 0, 0) + (n + 200) * 7 * 24 * 60 * 60 * 1000);
    const q = model.predict(forecastTime, 200);

    expect(q.p50).toBeCloseTo(0.5 * 49.5 + 0.5 * 300, 6); // 174.75
    expect(q.p50).not.toBeCloseTo(0.5 * 49.5 + 0.5 * 200, 3); // not the past-as-future value
  });

  it('a longer history moves the same horizon index further into the future', () => {
    const short = new SeasonalModel();
    short.fit(linearHistory(50));
    const long = new SeasonalModel();
    long.fit(linearHistory(100));

    // Same horizon index: the model fitted on more history extrapolates from
    // further along the same trend (value = index), so it predicts higher.
    const t = new Date(Date.UTC(2026, 0, 4, 10, 0, 0)); // a Sunday, 10:00 UTC
    expect(long.predict(t, 200).p50).toBeGreaterThan(short.predict(t, 200).p50);
  });
});

describe('countryForRegion (M9)', () => {
  it('maps the operating regions explicitly', () => {
    expect(countryForRegion('NG')).toBe('nigeria');
    expect(countryForRegion('ng')).toBe('nigeria');
    expect(countryForRegion('Nigeria')).toBe('nigeria');
    expect(countryForRegion('TZ')).toBe('tanzania');
    expect(countryForRegion('TZ-Dar')).toBe('tanzania');
  });

  it('throws unsupported_region for an unknown region instead of defaulting', () => {
    expect(() => countryForRegion('KE')).toThrow(/unsupported_region/);
    expect(() => countryForRegion('')).toThrow(/unsupported_region/);
    expect(() => countryForRegion('XX-nowhere')).toThrow(/unsupported_region/);
  });
});
