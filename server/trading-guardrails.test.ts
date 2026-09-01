/**
 * Pinning tests for M7: a strategy's own guardrails are enforced as step 5 of
 * the automated trading workflow, BEFORE any trade is created. A breach
 * refuses loudly and is recorded as a user-visible alert; without the fix the
 * workflow traded straight past the strategy row's limits.
 *
 * Two levels are pinned:
 *  - the activities themselves (limit breach, inactive strategy, alert record)
 *  - the workflow wiring: guardrail refusal stops orchestration before
 *    createAutomatedTradeActivity runs, and the refusal is recorded.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

type Row = Record<string, unknown>;

/* ------------------------- activity level ------------------------- */

function mockDbForActivity(opts: { strategy: Row | null; alertInserts?: Row[] }) {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (opts.strategy ? [opts.strategy] : []) }),
      }),
    }),
    insert: () => ({
      values: async (values: Row) => {
        opts.alertInserts?.push(values);
      },
    }),
  };
  vi.doMock('./db', () => ({ getDb: async () => db }));
}

describe('checkStrategyGuardrailsActivity', () => {
  it('refuses a trade above the strategy max trade size', async () => {
    mockDbForActivity({
      strategy: {
        id: 5,
        userId: 7,
        name: 'Cautious',
        isActive: true,
        conditions: { energyLimits: { maxTradeSize: 5 } },
      },
    });
    const { tradingActivities } = await import('./workflows/trading-activities');

    const result = await tradingActivities.checkStrategyGuardrailsActivity({
      strategyId: 5,
      userId: 7,
      tradeType: 'export',
      energyKWh: 10,
      priceCentsPerKwh: 100,
      atIso: new Date().toISOString(),
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/exceeds the strategy's maximum trade size of 5 kWh/);
  });

  it('refuses when the strategy is inactive, and when it does not exist', async () => {
    mockDbForActivity({
      strategy: { id: 5, userId: 7, name: 'Off', isActive: false, conditions: {} },
    });
    const { tradingActivities } = await import('./workflows/trading-activities');
    const base = {
      strategyId: 5,
      userId: 7,
      tradeType: 'export' as const,
      energyKWh: 1,
      priceCentsPerKwh: 100,
      atIso: new Date().toISOString(),
    };
    expect((await tradingActivities.checkStrategyGuardrailsActivity(base)).allowed).toBe(false);

    vi.resetModules();
    vi.doUnmock('./db');
    mockDbForActivity({ strategy: null });
    const fresh = await import('./workflows/trading-activities');
    expect((await fresh.tradingActivities.checkStrategyGuardrailsActivity(base)).allowed).toBe(false);
  });

  it('allows a trade inside every guardrail', async () => {
    mockDbForActivity({
      strategy: {
        id: 5,
        userId: 7,
        name: 'Cautious',
        isActive: true,
        conditions: {
          energyLimits: { minTradeSize: 1, maxTradeSize: 20 },
          priceThresholds: { minExportPrice: 50, maxExportPrice: 200 },
        },
      },
    });
    const { tradingActivities } = await import('./workflows/trading-activities');
    const result = await tradingActivities.checkStrategyGuardrailsActivity({
      strategyId: 5,
      userId: 7,
      tradeType: 'export',
      energyKWh: 10,
      priceCentsPerKwh: 100,
      atIso: new Date().toISOString(),
    });
    expect(result).toEqual({ allowed: true });
  });
});

describe('recordGuardrailRefusalActivity', () => {
  it('records the refusal as a user-visible warning alert', async () => {
    const alertInserts: Row[] = [];
    mockDbForActivity({ strategy: null, alertInserts });
    const { tradingActivities } = await import('./workflows/trading-activities');

    const result = await tradingActivities.recordGuardrailRefusalActivity({
      userId: 7,
      strategyId: 5,
      reason: 'too big',
      energyKWh: 10,
      priceCentsPerKwh: 100,
    });

    expect(result.success).toBe(true);
    expect(alertInserts).toHaveLength(1);
    expect(alertInserts[0]).toMatchObject({
      userId: 7,
      alertType: 'trading',
      severity: 'warning',
      title: 'Strategy guardrail refusal',
    });
    expect(alertInserts[0].message).toMatch(/too big/);
  });
});

/* ------------------------- workflow wiring ------------------------ */

interface WorkflowStubs {
  guardrails: { allowed: boolean; reason?: string };
  refusalCalls: Row[];
  createdTrades: Row[];
}

async function runWorkflow(stubs: WorkflowStubs) {
  vi.doMock('@temporalio/workflow', () => ({
    proxyActivities: () => ({
      getAvailableEnergyActivity: async () => ({ availableEnergyKwh: 10 }),
      getCurrentMarketPriceActivity: async () => ({ priceCentsPerKwh: 100 }),
      getTradingPreferencesActivity: async () => null,
      checkStrategyGuardrailsActivity: async () => stubs.guardrails,
      recordGuardrailRefusalActivity: async (input: Row) => {
        stubs.refusalCalls.push(input);
        return { success: true };
      },
      createAutomatedTradeActivity: async (input: Row) => {
        stubs.createdTrades.push(input);
        return { tradeId: 77 };
      },
      verifyAssetDeliveryActivity: async () => ({ verified: true, observedAvgPowerW: 5000 }),
      markAutomatedTradeExecutedActivity: async () => ({ success: true }),
      markAutomatedTradeFailedActivity: async () => ({ success: true }),
    }),
    sleep: async () => undefined,
  }));
  const { automatedTradingWorkflow } = await import('./workflows/trading-workflow');
  return automatedTradingWorkflow({
    userId: 7,
    assetId: 3,
    strategy: 'sell_excess',
    strategyId: 5,
  });
}

describe('automatedTradingWorkflow guardrail step (M7)', () => {
  it('a guardrail breach stops the workflow before any trade is created', async () => {
    const stubs: WorkflowStubs = {
      guardrails: { allowed: false, reason: 'Trade of 10 kWh exceeds the strategy\'s maximum trade size of 5 kWh' },
      refusalCalls: [],
      createdTrades: [],
    };
    const result = await runWorkflow(stubs);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Guardrail refusal: Trade of 10 kWh exceeds/);
    expect(result.tradesExecuted).toBe(0);
    // The refusal is surfaced to the user, not silently swallowed.
    expect(stubs.refusalCalls).toHaveLength(1);
    expect(stubs.refusalCalls[0]).toMatchObject({ userId: 7, strategyId: 5, energyKWh: 10 });
    // No trade row exists for a refused trade.
    expect(stubs.createdTrades).toHaveLength(0);
  });

  it('a strategy inside its guardrails trades normally', async () => {
    const stubs: WorkflowStubs = {
      guardrails: { allowed: true },
      refusalCalls: [],
      createdTrades: [],
    };
    const result = await runWorkflow(stubs);

    expect(result.success).toBe(true);
    expect(result.tradesExecuted).toBe(1);
    expect(stubs.createdTrades).toHaveLength(1);
    expect(stubs.createdTrades[0]).toMatchObject({ userId: 7, strategyId: 5, tradeType: 'export' });
    expect(stubs.refusalCalls).toHaveLength(0);
  });
});

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('./db');
  vi.doUnmock('@temporalio/workflow');
});
