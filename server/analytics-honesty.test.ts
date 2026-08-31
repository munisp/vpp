/**
 * Analytics honesty tests.
 *
 * The invariants under test: a missing database or a failed query must surface
 * as an error — never as an empty array or an all-zero metrics object that a
 * UI renders as real zeros. A successful query that legitimately returns zero
 * rows still returns [] ("no data" is not "data unavailable").
 *
 * Also pinned here: the untrained ML price model must not fabricate price
 * patterns (peak hours, best trading days, average price) from placeholder
 * default weights.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

const getDbMock = vi.fn();

vi.mock('./db', () => ({
  getDb: () => getDbMock(),
}));

// price-prediction.ts side dependencies — never touched by these tests, but
// the module imports them at load time.
vi.mock('./services/weather-api', () => ({
  getWeatherForecast: vi.fn(async () => null),
}));
vi.mock('./services/redis-cache', () => ({
  redisCache: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
}));

import * as analytics from './analytics';
import { pricePredictionService } from './ml/price-prediction';

const START = new Date('2026-07-01T00:00:00.000Z');
const END = new Date('2026-08-01T00:00:00.000Z');

/** A db whose every query chain rejects — stands in for a failed query. */
function failingDb() {
  const err = new Error('connection reset');
  const fail = () => Promise.reject(err);
  const node: any = {
    where: () => node,
    groupBy: () => node,
    orderBy: fail,
    innerJoin: () => node,
    limit: fail,
    then: (_res: any, rej: any) => fail().then(_res, rej),
  };
  return { select: () => ({ from: () => node }) };
}

describe('analytics getters fail loud', () => {
  beforeEach(() => {
    getDbMock.mockReset();
  });

  it('every getter throws INTERNAL_SERVER_ERROR when the database is unavailable', async () => {
    getDbMock.mockResolvedValue(null);

    const calls: Array<() => Promise<unknown>> = [
      () => analytics.getRevenueData(1, START, END),
      () => analytics.getEnergyFlowData(1, START, END),
      () => analytics.getTradingVolumeData(1, START, END),
      () => analytics.getUserEngagementMetrics(),
      () => analytics.getSystemStatistics(),
    ];

    for (const call of calls) {
      await expect(call()).rejects.toBeInstanceOf(TRPCError);
      await expect(call()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    }
  });

  it('a failed query throws instead of returning fabricated zeros', async () => {
    getDbMock.mockResolvedValue(failingDb());

    await expect(analytics.getRevenueData(1, START, END)).rejects.toBeInstanceOf(TRPCError);
    await expect(analytics.getEnergyFlowData(1, START, END)).rejects.toBeInstanceOf(TRPCError);
    await expect(analytics.getTradingVolumeData(1, START, END)).rejects.toBeInstanceOf(TRPCError);
    await expect(analytics.getSystemStatistics()).rejects.toBeInstanceOf(TRPCError);
    await expect(analytics.getUserEngagementMetrics()).rejects.toBeInstanceOf(TRPCError);
  });

  it('a successful query with zero rows still returns a legitimate empty array', async () => {
    const empty: any[] = [];
    const node: any = {
      where: () => node,
      groupBy: () => node,
      orderBy: () => Promise.resolve(empty),
      innerJoin: () => node,
      then: (res: any) => Promise.resolve(empty).then(res),
    };
    getDbMock.mockResolvedValue({
      select: () => ({ from: () => node }),
    });

    await expect(analytics.getRevenueData(1, START, END)).resolves.toEqual([]);
    await expect(analytics.getEnergyFlowData(1, START, END)).resolves.toEqual([]);
    await expect(analytics.getTradingVolumeData(1, START, END)).resolves.toEqual([]);
  });
});

describe('untrained price model does not fabricate patterns', () => {
  it('analyzePricePatterns returns empties + trained:false + reason when never trained', async () => {
    getDbMock.mockResolvedValue(null);

    const analysis = await pricePredictionService.analyzePricePatterns(30);

    expect(analysis.trained).toBe(false);
    expect(analysis.reason).toBeTruthy();
    expect(analysis.peakHours).toEqual([]);
    expect(analysis.offPeakHours).toEqual([]);
    expect(analysis.bestTradingDays).toEqual([]);
    expect(analysis.averagePrice).toBeNull();
    expect(analysis.priceVolatility).toBeNull();
  });
});
