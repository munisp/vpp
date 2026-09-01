/**
 * Pinning tests for the optimization-engine audit fixes:
 *
 *  - Price/emissions indexing was hardcoded to 15-minute dispatch
 *    (`points[Math.floor(i/4)]`) while price/emissions forecasts are hourly.
 *    The hourly row is floor(i * intervalMinutes / 60); these tests pin the
 *    correct row for 30-minute and 5-minute dispatch.
 *  - The heuristic path could export a battery straight through its SoC
 *    reserve because the reserve only zeroed export AT minSoc instead of
 *    budgeting the energy above it. These tests pin the clamp.
 *  - One battery below soc_min used to 422 the entire fleet (the solver
 *    validates initial_soc against soc_min request-wide). Now the low
 *    battery is constrained in place (soc_min raised to its SoC) and only an
 *    empty fleet fails loud.
 *  - SoC 0 (a truly empty battery) was treated as "unmeasured" by a
 *    truthiness check. Now only null/undefined means unmeasured.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

interface AssetFixture {
  assetId: number;
  assetType: string;
  capacity: number; // Wh for batteries
  eligibility: { eligible: boolean; availablePowerExport: number; availablePowerImport: number };
  currentPower: number;
  currentSoc: number | null;
}

function battery(overrides: Partial<AssetFixture> = {}): AssetFixture {
  return {
    assetId: 1,
    assetType: 'battery',
    capacity: 10_000,
    eligibility: { eligible: true, availablePowerExport: 5000, availablePowerImport: 5000 },
    currentPower: 0,
    currentSoc: 50,
    ...overrides,
  };
}

function hourlyPrices(p50s: number[]) {
  return {
    forecastAvailable: true,
    points: p50s.map((p50, i) => ({
      timestamp: new Date(Date.UTC(2026, 2, 1, i)),
      values: { p10: p50 - 5, p50, p90: p50 + 5, mean: p50, confidence: 80 },
    })),
  };
}

async function freshEngine() {
  // kafka-publisher registers Prometheus metrics at module scope; with
  // resetModules between tests a second real import would re-register and
  // throw. The engine only publishes analytics through it, so stub it out.
  vi.doMock('./integration/kafka-publisher', () => ({
    kafkaPublisher: { publishOptimizationRun: vi.fn(async () => undefined) },
  }));
  const { optimizationEngine } = await import('./services/optimization-engine');
  return optimizationEngine as any;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('./db');
  vi.doUnmock('./services/der-capabilities');
  vi.doUnmock('./services/milp-dispatch');
  vi.doUnmock('./services/degraded-operation');
  vi.doUnmock('./integration/kafka-publisher');
});

describe('hourly price/emissions indexing at non-15-minute resolutions', () => {
  it('maps 30-minute dispatch intervals to the correct hourly price row', async () => {
    const engine = await freshEngine();
    const forecasts = { price: hourlyPrices([100, 200, 300]) };

    // 30-minute intervals: 0,1 → hour 0; 2,3 → hour 1; 4,5 → hour 2.
    for (const [interval, expected] of [
      [0, 100], [1, 100], [2, 200], [3, 200], [4, 300], [5, 300],
    ] as const) {
      const ctx = engine.getIntervalContext(new Date(), forecasts, interval, 30);
      expect(ctx.priceForecast.p50).toBe(expected);
      expect(ctx.priceForecastEstimated).toBe(false);
    }
  });

  it('maps 5-minute dispatch intervals to the correct hourly price row', async () => {
    const engine = await freshEngine();
    const forecasts = { price: hourlyPrices([100, 200]) };

    // 5-minute intervals: 0-11 → hour 0; 12-23 → hour 1.
    expect(engine.getIntervalContext(new Date(), forecasts, 0, 5).priceForecast.p50).toBe(100);
    expect(engine.getIntervalContext(new Date(), forecasts, 11, 5).priceForecast.p50).toBe(100);
    expect(engine.getIntervalContext(new Date(), forecasts, 12, 5).priceForecast.p50).toBe(200);
    expect(engine.getIntervalContext(new Date(), forecasts, 23, 5).priceForecast.p50).toBe(200);
  });

  it('keeps the established 15-minute mapping intact', async () => {
    const engine = await freshEngine();
    const forecasts = { price: hourlyPrices([100, 200]) };

    expect(engine.getIntervalContext(new Date(), forecasts, 3, 15).priceForecast.p50).toBe(100);
    expect(engine.getIntervalContext(new Date(), forecasts, 4, 15).priceForecast.p50).toBe(200);
  });

  it('indexes hourly emissions rows identically', async () => {
    const engine = await freshEngine();
    const forecasts = {
      emissions: {
        forecastAvailable: true,
        points: [350, 500].map((p50, i) => ({
          timestamp: new Date(Date.UTC(2026, 2, 1, i)),
          values: { p10: p50, p50, p90: p50, mean: p50, confidence: 80 },
        })),
      },
    };
    // 30-minute intervals: 3 → 1.5 h → hourly row 1; 1 → 0.5 h → hourly row 0.
    expect(engine.getIntervalContext(new Date(), forecasts, 3, 30).emissionsForecast.p50).toBe(500);
    expect(engine.getIntervalContext(new Date(), forecasts, 1, 30).emissionsForecast.p50).toBe(350);
  });
});

describe('heuristic battery export respects the SoC reserve', () => {
  const start = new Date(Date.UTC(2026, 2, 1, 12));
  const end = new Date(Date.UTC(2026, 2, 1, 13));
  const highPriceContext = {
    timestamp: start,
    loadForecast: { p10: 0, p50: 0, p90: 0, mean: 0, confidence: 80 },
    // 100 > 45 * 1.2, so maximize_revenue wants full export.
    priceForecast: { p10: 100, p50: 100, p90: 100, mean: 100, confidence: 80 },
    emissionsForecast: { p10: 400, p50: 400, p90: 400, mean: 400, confidence: 80 },
    priceForecastEstimated: false,
    emissionsForecastEstimated: false,
  };

  it('a battery at minSoc + ε exports ~0 (below the 100W dispatch threshold)', async () => {
    const engine = await freshEngine();
    const asset = battery({ currentSoc: 20.5 });
    const sp = engine.optimizeAssetInterval(
      'maximize_revenue', asset, highPriceContext, start, end, 60, 20.5,
      { minSocReserve: 20 }
    );
    // 0.5% of 10 kWh = 50 Wh over an hour = 50 W: below the 100 W minimum
    // dispatch threshold, so no export setpoint is issued.
    expect(sp).toBeNull();
  });

  it('clamps export to exactly the energy above the reserve', async () => {
    const engine = await freshEngine();
    const asset = battery({ currentSoc: 50 });
    const sp = engine.optimizeAssetInterval(
      'maximize_revenue', asset, highPriceContext, start, end, 60, 50,
      { minSocReserve: 20 }
    );
    expect(sp).not.toBeNull();
    // (50% - 20%) of 10_000 Wh = 3000 Wh over 1 h = 3000 W, not the 5000 W
    // nameplate the objective asked for.
    expect(sp.targetPowerWatts).toBe(3000);
    // End-of-interval SoC lands exactly on the reserve, never below it.
    const endSoc = 50 - ((sp.targetPowerWatts * 60) / 60 / asset.capacity) * 100;
    expect(endSoc).toBe(20);
  });

  it('never breaches the reserve across a multi-interval horizon', async () => {
    const engine = await freshEngine();
    const request = {
      scope: {},
      objective: 'maximize_revenue',
      horizonHours: 4,
      intervalMinutes: 60,
      constraints: { minSocReserve: 20 },
    };
    const forecasts = { price: hourlyPrices([100, 100, 100, 100]) };
    const warnings: string[] = [];

    const setpoints = await engine.runOptimization(
      request, [battery({ currentSoc: 50 })], forecasts, new Map(), start, 4, 60, warnings
    );

    // Only the first interval can export: 3000 Wh drains the battery exactly
    // to the 20% reserve; every later interval must produce no export.
    expect(setpoints).toHaveLength(1);
    expect(setpoints[0].targetPowerWatts).toBe(3000);
    const totalExportWh = setpoints.reduce(
      (sum: number, sp: any) => sum + (sp.targetPowerWatts * 60) / 60, 0
    );
    const finalSoc = 50 - (totalExportWh / 10_000) * 100;
    expect(finalSoc).toBeGreaterThanOrEqual(20);
  });
});

describe('fleet optimization with a battery below its reserve', () => {
  async function mockMilp() {
    const captured: any[] = [];
    const actual = await vi.importActual<any>('./services/milp-dispatch');
    vi.doMock('./services/milp-dispatch', () => ({
      ...actual,
      assertMilpOptimizerConfigured: vi.fn(),
      isMilpOptimizerConfigured: vi.fn(() => true),
      solveMilpDispatch: vi.fn(async (req: any) => {
        captured.push(req);
        return { solver: 'test-solver', intervals: [] };
      }),
      checkPlanAgainstNetwork: vi.fn(async () => ({
        status: 'no_study',
        checked: false,
        reason: 'test harness',
      })),
    }));
    const actualDegraded = await vi.importActual<any>('./services/degraded-operation');
    vi.doMock('./services/degraded-operation', () => ({
      ...actualDegraded,
      requireCapability: vi.fn(async () => ({
        posture: 'available',
        missing: [],
        evidenceLimit: null,
      })),
    }));
    return captured;
  }

  const milpRequest = {
    scope: { userId: 1 },
    objective: 'minimize_cost',
    horizonHours: 2,
    intervalMinutes: 60,
    constraints: { minSocReserve: 20 },
  };
  const milpStart = new Date(Date.UTC(2026, 2, 1, 12));

  it('constrains the low battery in place and optimizes the rest (no fleet-wide 422)', async () => {
    const captured = await mockMilp();
    const engine = await freshEngine();
    const warnings: string[] = [];

    const result = await engine.runMilpOptimization(
      milpRequest,
      [battery({ assetId: 1, currentSoc: 50 }), battery({ assetId: 2, currentSoc: 5 })],
      {},
      milpStart,
      2,
      60,
      warnings
    );

    // The solver was reached — one low battery did not sink the fleet.
    expect(captured).toHaveLength(1);
    expect(result.solver).toBe('test-solver');
    const assets = captured[0].site.assets;
    expect(assets).toHaveLength(2);
    const healthy = assets.find((a: any) => a.asset_id === '1');
    const low = assets.find((a: any) => a.asset_id === '2');
    expect(healthy.battery.soc_min_percent).toBe(20);
    // The low battery: soc_min raised to its current SoC — it can charge but
    // not discharge until it is back above the reserve.
    expect(low.battery.soc_min_percent).toBe(5);
    expect(low.battery.initial_soc_percent).toBe(5);
    // The per-asset adjustment is recorded.
    expect(
      warnings.some(w => w.includes('Asset 2') && w.includes('below the 20% reserve'))
    ).toBe(true);
  });

  it('fails loud only when NO dispatchable assets remain', async () => {
    const captured = await mockMilp();
    const engine = await freshEngine();
    const warnings: string[] = [];

    await expect(
      engine.runMilpOptimization(
        milpRequest,
        [battery({ assetId: 1, currentSoc: null })], // unmeasured SoC: excluded
        {},
        milpStart,
        2,
        60,
        warnings
      )
    ).rejects.toThrow(/no dispatchable assets remain/);
    expect(captured).toHaveLength(0); // the solver was never asked
    expect(warnings.some(w => w.includes('no measured state of charge'))).toBe(true);
  });

  it('a battery measured at 0% SoC stays in the fleet, constrained to charge-only', async () => {
    const captured = await mockMilp();
    const engine = await freshEngine();
    const warnings: string[] = [];

    await engine.runMilpOptimization(
      milpRequest,
      [battery({ assetId: 3, currentSoc: 0 })],
      {},
      milpStart,
      2,
      60,
      warnings
    );

    expect(captured).toHaveLength(1);
    const asset = captured[0].site.assets[0];
    expect(asset.battery.initial_soc_percent).toBe(0);
    expect(asset.battery.soc_min_percent).toBe(0);
    expect(warnings.some(w => w.includes('Asset 3'))).toBe(true);
  });
});

describe('SoC 0 is a measurement, not a missing value', () => {
  it('loads a battery with stateOfCharge 0 as currentSoc 0, not null', async () => {
    vi.doMock('./db', () => ({
      getDb: vi.fn(async () => ({
        execute: vi
          .fn()
          // Asset scope query
          .mockResolvedValueOnce({
            rows: [{ id: 7, userId: 1, assetType: 'battery', capacity: 10_000, status: 'active' }],
          })
          // Latest telemetry: a truly empty battery.
          .mockResolvedValueOnce({ rows: [{ power: 0, stateOfCharge: 0 }] }),
      })),
    }));
    vi.doMock('./services/der-capabilities', () => ({
      derCapabilities: {
        calculateEligibility: vi.fn(async () => ({
          eligible: true,
          availablePowerExport: 2000,
          availablePowerImport: 2000,
        })),
      },
    }));
    const engine = await freshEngine();

    const { assets } = await engine.getAssetsForOptimization({
      scope: { assetIds: [7] },
      objective: 'minimize_cost',
      horizonHours: 1,
      intervalMinutes: 60,
    });

    expect(assets).toHaveLength(1);
    expect(assets[0].currentSoc).toBe(0); // not null: 0% is a real reading
  });
});
