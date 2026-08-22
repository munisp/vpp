/**
 * Trust-boundary tests for `forecasting.accuracySummary`.
 *
 * Accuracy metrics describe a site's or community's real behaviour, so they leak
 * generation profiles: asset scope was already owner-only, but community scope
 * took `scopeId` straight from the caller, letting any authenticated user read
 * another community's aggregate. Region scope stays open, matching the region
 * forecast endpoints beside it.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

interface DbRows {
  assets: Array<{ userId: number }>;
  members: Array<{ status: string }>;
}

/**
 * Stand-in for the drizzle select chain the router uses. The projection keys
 * identify the query: ownership reads `userId`, membership reads `status`.
 */
function mockDb(rows: DbRows) {
  const db = {
    select: (fields?: Record<string, unknown>) => {
      const selected = fields ? Object.keys(fields) : [];
      const result = selected.includes('status') ? rows.members : rows.assets;
      const stage: Record<string, unknown> = {
        where: () => stage,
        limit: () => stage,
        then: (resolve: (value: unknown) => void) => resolve(result),
      };
      return { from: () => stage };
    },
  };
  vi.doMock('./db', () => ({ getDb: async () => db }));
}

const summaryCalls: Array<{ scopeType: string; scopeId?: number }> = [];

function mockAccuracyService() {
  vi.doMock('./services/forecast-accuracy', () => ({
    MIN_SCORING_SAMPLES: 4,
    TARGET_COVERAGE_BP: 8000,
    getAccuracySummary: async (input: { scopeType: string; scopeId?: number }) => {
      summaryCalls.push({ scopeType: input.scopeType, scopeId: input.scopeId });
      return [];
    },
    scoreForecastRun: async () => ({}),
    scoreDueForecastRuns: async () => [],
  }));
}

function ctxFor(userId: number, role: 'user' | 'admin') {
  return { user: { id: userId, role } } as never;
}

/**
 * The forecasting service is irrelevant here and registers Prometheus
 * collectors at import time, which a per-test module reset would duplicate.
 */
function mockForecastingService() {
  vi.doMock('./services/probabilistic-forecasting', () => ({
    probabilisticForecasting: {},
  }));
}

async function callerFor(userId: number, role: 'user' | 'admin') {
  mockForecastingService();
  const { forecastingRouter } = await import('./routers/nextgen/forecasting');
  return forecastingRouter.createCaller(ctxFor(userId, role));
}

afterEach(() => {
  summaryCalls.length = 0;
  vi.resetModules();
  vi.doUnmock('./db');
  vi.doUnmock('./services/forecast-accuracy');
  vi.doUnmock('./services/probabilistic-forecasting');
});

describe('accuracySummary community scope', () => {
  it('refuses a community the caller is not a member of', async () => {
    mockDb({ assets: [], members: [] });
    mockAccuracyService();
    const caller = await callerFor(8, 'user');

    await expect(
      caller.accuracySummary({ sinceDays: 30, scopeType: 'community', scopeId: 42 })
    ).rejects.toThrow(/not an active member/);
    expect(summaryCalls).toEqual([]);
  });

  it('refuses a membership that is not active', async () => {
    mockDb({ assets: [], members: [{ status: 'pending' }] });
    mockAccuracyService();
    const caller = await callerFor(8, 'user');

    await expect(
      caller.accuracySummary({ sinceDays: 30, scopeType: 'community', scopeId: 42 })
    ).rejects.toThrow(/not an active member/);
    expect(summaryCalls).toEqual([]);
  });

  it('serves an active member', async () => {
    mockDb({ assets: [], members: [{ status: 'active' }] });
    mockAccuracyService();
    const caller = await callerFor(8, 'user');

    await caller.accuracySummary({ sinceDays: 30, scopeType: 'community', scopeId: 42 });
    expect(summaryCalls).toEqual([{ scopeType: 'community', scopeId: 42 }]);
  });

  it('rejects a community scope with no communityId rather than widening it', async () => {
    mockDb({ assets: [], members: [{ status: 'active' }] });
    mockAccuracyService();
    const caller = await callerFor(8, 'user');

    await expect(caller.accuracySummary({ sinceDays: 30, scopeType: 'community' })).rejects.toThrow(
      /needs a communityId/
    );
    expect(summaryCalls).toEqual([]);
  });

  it('lets an admin read any community', async () => {
    mockDb({ assets: [], members: [] });
    mockAccuracyService();
    const caller = await callerFor(1, 'admin');

    await caller.accuracySummary({ sinceDays: 30, scopeType: 'community', scopeId: 42 });
    expect(summaryCalls).toEqual([{ scopeType: 'community', scopeId: 42 }]);
  });
});

describe('accuracySummary asset and user scopes', () => {
  it('still refuses an asset the caller does not own', async () => {
    mockDb({ assets: [{ userId: 7 }], members: [] });
    mockAccuracyService();
    const caller = await callerFor(8, 'user');

    await expect(
      caller.accuracySummary({ sinceDays: 30, scopeType: 'asset', scopeId: 3 })
    ).rejects.toThrow(/do not own this asset/);
    expect(summaryCalls).toEqual([]);
  });

  it('forces a non-admin user scope onto the caller', async () => {
    mockDb({ assets: [], members: [] });
    mockAccuracyService();
    const caller = await callerFor(8, 'user');

    await caller.accuracySummary({ sinceDays: 30, scopeType: 'user', scopeId: 999 });
    expect(summaryCalls).toEqual([{ scopeType: 'user', scopeId: 8 }]);
  });
});
