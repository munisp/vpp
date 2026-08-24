/**
 * Tests for `tradingStrategies.backtest`.
 *
 * The route used to return `successRate: 0` and "Backtest completed
 * successfully" when it had looked at no history at all, so a strategy nobody
 * could evaluate rendered in both apps as one measured to be worthless. A
 * backtest now says what history it considered and whether anything was
 * measured, and states a rate only when there was something to rate.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

interface Trade {
  id: number;
  tradeType: 'export' | 'import';
  energy: number;
  price: number;
  totalAmount: number;
  status: string;
  createdAt: Date;
}

const updates: Array<Record<string, unknown>> = [];

/**
 * Stand-in for the drizzle chain the route uses: it loads the caller's strategy
 * and then the user's trades over the period, and writes the result back.
 */
function mockDb(strategy: Record<string, unknown> | undefined, trades: Trade[]) {
  let selects = 0;
  const db = {
    select: () => {
      const isStrategyRead = selects++ === 0;
      const rows: unknown[] = isStrategyRead ? (strategy ? [strategy] : []) : trades;
      const stage: Record<string, unknown> = {
        where: () => stage,
        limit: () => stage,
        orderBy: () => stage,
        then: (resolve: (value: unknown) => void) => resolve(rows),
      };
      return { from: () => stage };
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return { where: async () => undefined };
      },
    }),
  };
  vi.doMock('./db', () => ({ getDb: async () => db }));
}

function tradeAt(overrides: Partial<Trade> = {}): Trade {
  return {
    id: 1,
    tradeType: 'export',
    energy: 5_000,
    price: 4_000,
    totalAmount: 20_000,
    status: 'executed',
    createdAt: new Date('2026-08-20T10:00:00Z'),
    ...overrides,
  };
}

async function backtest(strategy: Record<string, unknown> | undefined, trades: Trade[]) {
  mockDb(strategy, trades);
  const { tradingStrategiesRouter } = await import('./routers/tradingStrategies');
  const caller = tradingStrategiesRouter.createCaller({
    user: { id: 7, role: 'user' },
  } as never);
  return caller.backtest({ id: 1, period: '30d' });
}

afterEach(() => {
  updates.length = 0;
  vi.resetModules();
  vi.doUnmock('./db');
});

describe('tradingStrategies.backtest', () => {
  it('states no rate and no measurement when there is no recorded history', async () => {
    const result = await backtest({ id: 1, userId: 7, conditions: {} }, []);

    expect(result.results.tradesConsidered).toBe(0);
    expect(result.results.simulatedTrades).toBe(0);
    expect(result.results.successRate).toBeNull();
    expect(result.results.measured).toBe(false);
    expect(result.message).toMatch(/has not been backtested against anything/);
  });

  it('separates "nothing matched" from "measured 0%"', async () => {
    const result = await backtest(
      { id: 1, userId: 7, conditions: { priceThresholds: { minExportPrice: 500 } } },
      [tradeAt({ price: 100 })]
    );

    expect(result.results.tradesConsidered).toBe(1);
    expect(result.results.simulatedTrades).toBe(0);
    expect(result.results.successRate).toBeNull();
    expect(result.results.measured).toBe(false);
    expect(result.message).toMatch(/met this strategy's conditions/);
  });

  it('reports the rate it measured, over the trades it matched', async () => {
    const result = await backtest({ id: 1, userId: 7, conditions: {} }, [
      tradeAt({ id: 1, status: 'executed' }),
      tradeAt({ id: 2, status: 'failed' }),
    ]);

    expect(result.results.tradesConsidered).toBe(2);
    expect(result.results.simulatedTrades).toBe(2);
    expect(result.results.successRate).toBe(50);
    expect(result.results.measured).toBe(true);
    expect(result.message).toMatch(/Backtested against 2 of 2/);
  });

  it('persists the same unmeasured verdict it returns', async () => {
    await backtest({ id: 1, userId: 7, conditions: {} }, []);

    expect(updates).toHaveLength(1);
    const stored = updates[0].backtestResults as { successRate: number | null; measured: boolean };
    expect(stored.successRate).toBeNull();
    expect(stored.measured).toBe(false);
  });

  it('refuses to backtest a strategy the caller does not own', async () => {
    await expect(backtest(undefined, [])).rejects.toThrow();
  });
});
