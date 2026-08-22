/**
 * Price-signal dispatch pays sites for a shape instead of commanding them, so
 * the failure modes are all about mistaking one fact for another. These tests
 * pin the boundaries:
 *  - a site with no measured history is excluded, never given an assumed load
 *  - a coordination that misses its own target is stored and refused publication
 *  - a broker publish is recorded as broker_queued, never as a site response
 *  - a window is not scored before it closes, and no telemetry scores as
 *    no_telemetry rather than as compliance
 *  - metered net import is the negation of generation-positive telemetry
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PriceSignalSchema = typeof import('../drizzle/price-signal-schema');

/**
 * Resolved after every module reset: the service under test imports its own
 * fresh copy of the schema, and the fake database keys rows by table identity.
 */
let tbl: PriceSignalSchema;

interface Inserted {
  table: unknown;
  values: unknown;
}

interface Updated {
  table: unknown;
  values: Record<string, unknown>;
}

interface DbState {
  rows: Map<unknown, unknown[]>;
  inserted: Inserted[];
  updated: Updated[];
  execute: (query: unknown) => Promise<{ rows: Record<string, unknown>[] }>;
}

class Query {
  constructor(private readonly rows: unknown[]) {}
  where(): Query {
    return this;
  }
  orderBy(): Query {
    return this;
  }
  limit(): Query {
    return this;
  }
  then<TResult>(
    onFulfilled: (value: unknown[]) => TResult,
    onRejected?: (reason: unknown) => TResult
  ): Promise<TResult> {
    return Promise.resolve(this.rows).then(onFulfilled, onRejected);
  }
}

let state: DbState;

function mockDb() {
  const db = {
    select: () => ({ from: (table: unknown) => new Query(state.rows.get(table) ?? []) }),
    insert: (table: unknown) => ({
      values: async (values: unknown) => {
        state.inserted.push({ table, values });
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          state.updated.push({ table, values });
        },
      }),
    }),
    execute: async (query: unknown) => state.execute(query),
  };
  vi.doMock('./db', () => ({ getDb: async () => db }));
}

interface SitePlan {
  netW: number[];
  billCents: number;
}

let coordinationCalls: unknown[] = [];

function mockOptimizer(options: {
  converged: boolean;
  aggregateNetW: number[];
  targetDeviationW: number[] | null;
  plans: SitePlan[];
  status?: string;
}) {
  vi.doMock('./services/milp-dispatch', async () => {
    const actual =
      await vi.importActual<typeof import('./services/milp-dispatch')>('./services/milp-dispatch');
    return {
      ...actual,
      solveCoordination: async (request: unknown) => {
        coordinationCalls.push(request);
        return {
          status: options.status ?? 'optimal',
          solver: 'HiGHS',
          iterations: options.converged ? 7 : 50,
          max_violation_w: options.converged ? 0 : 4200,
          converged: options.converged,
          shadow_prices_cents_per_kwh: options.aggregateNetW.map(() => 2.5),
          aggregate_net_w: options.aggregateNetW,
          target_deviation_w: options.targetDeviationW,
          sites: options.plans.map(plan => ({
            status: 'optimal',
            solver: 'HiGHS',
            objective: 'minimize_cost',
            intervals: plan.netW.map((watts, index) => ({
              index,
              grid_import_w: watts > 0 ? watts : 0,
              grid_export_w: watts < 0 ? -watts : 0,
              assets: [],
            })),
            totals: { objective_value_cents: plan.billCents },
            diagnostics: {},
          })),
          diagnostics: {},
        };
      },
    };
  });
}

/**
 * Always mocked, in every test: importing the real forecasting service pulls in
 * the Kafka publisher, whose Prometheus counters cannot be registered twice
 * across the module resets these tests rely on.
 */
function mockForecasting(options: {
  priceCentsPerKwh: number[];
  loadByUser: Record<number, number[]>;
}) {
  const points = (values: number[]) =>
    values.map((value, index) => ({
      timestamp: new Date(Date.UTC(2026, 2, 1, index)),
      values: { p10: value, p50: value, p90: value, mean: value, confidence: 80 },
    }));

  vi.doMock('./services/probabilistic-forecasting', () => ({
    probabilisticForecasting: {
      forecastPrice: async () => ({ points: points(options.priceCentsPerKwh) }),
      forecastLoad: async (scope: { userId?: number }) => ({
        points: points(options.loadByUser[scope.userId ?? 0] ?? []),
      }),
    },
  }));
}

let publishedSignals: Array<{ siteRef: string; payload: Record<string, unknown> }> = [];

function mockBroker(succeedFor: (siteRef: string) => boolean) {
  vi.doMock('./integration/mqtt-broker', () => ({
    mqttBrokerService: {
      publishSiteSignal: async (siteRef: string, payload: Record<string, unknown>) => {
        if (!succeedFor(siteRef)) throw new Error('MQTT client not connected');
        publishedSignals.push({ siteRef, payload });
      },
    },
  }));
}

const HOUR = 60;

beforeEach(async () => {
  vi.resetModules();
  tbl = await import('../drizzle/price-signal-schema');
  coordinationCalls = [];
  publishedSignals = [];
  state = {
    rows: new Map(),
    inserted: [],
    updated: [],
    execute: async () => ({ rows: [] }),
  };
  mockForecasting({ priceCentsPerKwh: [], loadByUser: {} });
});

afterEach(() => {
  vi.doUnmock('./db');
  vi.doUnmock('./services/milp-dispatch');
  vi.doUnmock('./services/probabilistic-forecasting');
  vi.doUnmock('./integration/mqtt-broker');
});

describe('buildFleetSites', () => {
  const baseInput = {
    horizon: 2,
    intervalMinutes: HOUR,
    siteImportLimitW: 8000,
    siteExportLimitW: 5000,
    scopeType: 'fleet' as const,
  };

  it('excludes a site whose load is unknown instead of assuming one', async () => {
    mockDb();
    mockForecasting({
      priceCentsPerKwh: [12, 18],
      loadByUser: { 1: [1000, 1200], 2: [900, 900] },
    });
    state.rows.set(await assetsTable(), []);
    state.execute = async () => ({ rows: [{ user_id: 1, samples: 500 }] });

    const { buildFleetSites } = await import('./services/price-signal');
    const result = await buildFleetSites({ ...baseInput, userIds: [1, 2] });

    expect(result.sites.map(site => site.siteRef)).toEqual(['user-1']);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]).toMatchObject({ siteRef: 'user-2', userId: 2 });
    expect(result.excluded[0].reason).toContain('0 telemetry samples');
  });

  it('excludes a site whose forecast load is flat zero', async () => {
    mockDb();
    mockForecasting({ priceCentsPerKwh: [12, 18], loadByUser: { 1: [0, 0] } });
    state.rows.set(await assetsTable(), []);
    state.execute = async () => ({ rows: [{ user_id: 1, samples: 500 }] });

    const { buildFleetSites, PriceSignalError } = await import('./services/price-signal');
    await expect(buildFleetSites({ ...baseInput, userIds: [1] })).rejects.toBeInstanceOf(
      PriceSignalError
    );
  });

  it('prices the horizon from the price forecast it actually covers', async () => {
    mockDb();
    mockForecasting({ priceCentsPerKwh: [12], loadByUser: { 1: [1000, 1000] } });
    state.rows.set(await assetsTable(), []);
    state.execute = async () => ({ rows: [{ user_id: 1, samples: 500 }] });

    const { buildFleetSites } = await import('./services/price-signal');
    await expect(buildFleetSites({ ...baseInput, userIds: [1] })).rejects.toThrow(
      /covers 1 of 2 intervals/
    );
  });
});

async function assetsTable() {
  const schema = await import('../drizzle/schema');
  return schema.assets;
}

describe('coordinateFleetSignal', () => {
  const site = {
    siteRef: 'user-1',
    userId: 1,
    request: {
      interval_minutes: HOUR,
      site: {
        site_id: 'user-1',
        assets: [],
        load_w: [1000, 1000],
        max_import_w: 8000,
        max_export_w: 5000,
      },
      prices: { import_cents_per_kwh: [12, 18], export_cents_per_kwh: [12, 18] },
      objective: 'minimize_cost' as const,
    },
  };

  const input = {
    sites: [site],
    intervalMinutes: HOUR,
    startsAt: new Date('2026-03-01T00:00:00.000Z'),
    targetNetW: [1000, 800],
    sharedImportLimitW: [8000, 8000],
    baseImportPricesCentsPerKwh: [12, 18],
    scopeType: 'fleet' as const,
  };

  it('stores a signal that reached its target as a publishable draft', async () => {
    mockDb();
    mockOptimizer({
      converged: true,
      aggregateNetW: [1000, 800],
      targetDeviationW: [0, 0],
      plans: [{ netW: [1000, 800], billCents: 340 }],
    });

    const { coordinateFleetSignal } = await import('./services/price-signal');
    const result = await coordinateFleetSignal(input);

    expect(result.converged).toBe(true);
    const signalInsert = state.inserted.find(row => row.table === tbl.priceSignals);
    expect(signalInsert?.values).toMatchObject({ status: 'draft', maxDeviationWatts: 0 });

    const siteInsert = state.inserted.find(row => row.table === tbl.priceSignalSites);
    const siteValues = (siteInsert?.values as Array<Record<string, unknown>>)[0];
    // 1000 W then 800 W across two one-hour intervals.
    expect(siteValues.plannedNetWh).toBe(1800);
    expect(siteValues.plannedBillCents).toBe(340);
  });

  it('records the worst residual when the fleet never reaches the target', async () => {
    mockDb();
    mockOptimizer({
      converged: false,
      aggregateNetW: [5200, 800],
      targetDeviationW: [4200, 0],
      plans: [{ netW: [5200, 800], billCents: 900 }],
    });

    const { coordinateFleetSignal } = await import('./services/price-signal');
    const result = await coordinateFleetSignal(input);

    expect(result.converged).toBe(false);
    const signalInsert = state.inserted.find(row => row.table === tbl.priceSignals);
    expect(signalInsert?.values).toMatchObject({
      status: 'not_converged',
      maxDeviationWatts: 4200,
    });
  });

  it('refuses a coordination that cannot say how far off target it is', async () => {
    mockDb();
    mockOptimizer({
      converged: true,
      aggregateNetW: [1000, 800],
      targetDeviationW: null,
      plans: [{ netW: [1000, 800], billCents: 340 }],
    });

    const { coordinateFleetSignal } = await import('./services/price-signal');
    await expect(coordinateFleetSignal(input)).rejects.toThrow(/no target deviation/);
  });

  it('stores the signed coordination price at the readers\u2019 scale', async () => {
    mockDb();
    mockOptimizer({
      converged: true,
      aggregateNetW: [1000, 800],
      targetDeviationW: [0, 0],
      plans: [{ netW: [1000, 800], billCents: 340 }],
    });

    const { coordinateFleetSignal } = await import('./services/price-signal');
    await coordinateFleetSignal(input);

    const intervalInsert = state.inserted.find(row => row.table === tbl.priceSignalIntervals);
    const values = intervalInsert?.values as Array<Record<string, unknown>>;
    // 2.5 cents/kWh, stored as hundredths like every other price column.
    expect(values[0]).toMatchObject({ signalAdjustmentValue: 250, baseImportPriceValue: 1200 });
  });
});

describe('publishFleetSignal', () => {
  const storedSignal = {
    signalId: 'psig-1',
    status: 'draft' as const,
    intervalMinutes: HOUR,
    startsAt: new Date('2026-03-01T00:00:00.000Z'),
    endsAt: new Date('2026-03-01T02:00:00.000Z'),
    maxDeviationWatts: 0,
    publishedAt: null,
  };

  const storedIntervals = [
    {
      intervalIndex: 0,
      startsAt: new Date('2026-03-01T00:00:00.000Z'),
      baseImportPriceValue: 1200,
      signalAdjustmentValue: 250,
    },
  ];

  it('records a broker publish as queued, not as a site response', async () => {
    mockDb();
    mockBroker(() => true);
    state.rows.set(tbl.priceSignals, [storedSignal]);
    state.rows.set(tbl.priceSignalIntervals, storedIntervals);
    state.rows.set(tbl.priceSignalSites, [{ id: 9, siteRef: 'user-1', userId: 1 }]);

    const { publishFleetSignal } = await import('./services/price-signal');
    const result = await publishFleetSignal('psig-1');

    expect(result).toEqual({ queued: 1, failed: 0 });
    const siteUpdate = state.updated.find(row => row.table === tbl.priceSignalSites);
    expect(siteUpdate?.values).toMatchObject({ delivery: 'broker_queued' });
    expect(siteUpdate?.values.response).toBeUndefined();
    // The site is told the total price it pays, not the platform's internals.
    expect(publishedSignals[0].payload.schedule).toEqual([
      {
        starts_at: '2026-03-01T00:00:00.000Z',
        import_cents_per_kwh: 14.5,
        signal_cents_per_kwh: 2.5,
      },
    ]);
  });

  it('keeps a failed send visible with its reason', async () => {
    mockDb();
    mockBroker(() => false);
    state.rows.set(tbl.priceSignals, [storedSignal]);
    state.rows.set(tbl.priceSignalIntervals, storedIntervals);
    state.rows.set(tbl.priceSignalSites, [{ id: 9, siteRef: 'user-1', userId: 1 }]);

    const { publishFleetSignal } = await import('./services/price-signal');
    const result = await publishFleetSignal('psig-1');

    expect(result).toEqual({ queued: 0, failed: 1 });
    const siteUpdate = state.updated.find(row => row.table === tbl.priceSignalSites);
    expect(siteUpdate?.values).toMatchObject({
      delivery: 'failed',
      deliveryDetail: 'MQTT client not connected',
    });
    // Nothing was offered, so the signal is not published.
    expect(state.updated.some(row => row.table === tbl.priceSignals)).toBe(false);
  });

  it('refuses to publish a signal that missed its own target', async () => {
    mockDb();
    mockBroker(() => true);
    state.rows.set(tbl.priceSignals, [
      { ...storedSignal, status: 'not_converged', maxDeviationWatts: 4200 },
    ]);

    const { publishFleetSignal } = await import('./services/price-signal');
    await expect(publishFleetSignal('psig-1')).rejects.toThrow(/missed its own target by 4200 W/);
    expect(publishedSignals).toHaveLength(0);
  });
});

describe('scoreFleetSignalResponse', () => {
  const publishedSignal = {
    signalId: 'psig-1',
    status: 'published' as const,
    intervalMinutes: HOUR,
    startsAt: new Date('2026-03-01T00:00:00.000Z'),
    endsAt: new Date('2026-03-01T02:00:00.000Z'),
    maxDeviationWatts: 0,
    publishedAt: new Date('2026-02-28T23:00:00.000Z'),
    solver: 'HiGHS',
    iterations: 7,
    scopeType: 'fleet',
    scopeId: null,
    region: null,
    scoredAt: null,
  };

  function siteRow(plannedNetWh: number) {
    return { id: 9, siteRef: 'user-1', userId: 1, plannedNetWh };
  }

  it('will not score a window that has not closed', async () => {
    mockDb();
    state.rows.set(tbl.priceSignals, [
      { ...publishedSignal, endsAt: new Date(Date.now() + 3_600_000) },
    ]);

    const { scoreFleetSignalResponse } = await import('./services/price-signal');
    await expect(scoreFleetSignalResponse('psig-1')).rejects.toThrow(/partial window/);
  });

  it('will not score a signal that was never offered', async () => {
    mockDb();
    state.rows.set(tbl.priceSignals, [{ ...publishedSignal, publishedAt: null }]);

    const { scoreFleetSignalResponse } = await import('./services/price-signal');
    await expect(scoreFleetSignalResponse('psig-1')).rejects.toThrow(/never published/);
  });

  it('scores an empty window as missing evidence, not compliance', async () => {
    mockDb();
    state.rows.set(tbl.priceSignals, [publishedSignal]);
    state.rows.set(tbl.priceSignalSites, [siteRow(1800)]);
    state.rows.set(tbl.priceSignalIntervals, []);
    state.execute = async () => ({ rows: [{ samples: 0, site_mean_power: 0 }] });

    const { scoreFleetSignalResponse } = await import('./services/price-signal');
    await scoreFleetSignalResponse('psig-1');

    const siteUpdate = state.updated.find(row => row.table === tbl.priceSignalSites);
    expect(siteUpdate?.values).toMatchObject({
      response: 'no_telemetry',
      actualNetWh: null,
      telemetrySamples: 0,
    });
  });

  it('reads generation-positive telemetry as net import when comparing with the plan', async () => {
    mockDb();
    state.rows.set(tbl.priceSignals, [publishedSignal]);
    state.rows.set(tbl.priceSignalSites, [siteRow(1800)]);
    state.rows.set(tbl.priceSignalIntervals, []);
    // Site mean of -900 W of generation, i.e. 900 W of import, over two hours.
    state.execute = async () => ({ rows: [{ samples: 4, site_mean_power: -900 }] });

    const { scoreFleetSignalResponse } = await import('./services/price-signal');
    await scoreFleetSignalResponse('psig-1');

    const siteUpdate = state.updated.find(row => row.table === tbl.priceSignalSites);
    expect(siteUpdate?.values).toMatchObject({
      response: 'followed',
      actualNetWh: 1800,
      telemetrySamples: 4,
    });
  });

  it('marks a site that ran something other than its plan as deviated', async () => {
    mockDb();
    state.rows.set(tbl.priceSignals, [publishedSignal]);
    state.rows.set(tbl.priceSignalSites, [siteRow(1800)]);
    state.rows.set(tbl.priceSignalIntervals, []);
    state.execute = async () => ({ rows: [{ samples: 4, site_mean_power: -3600 }] });

    const { scoreFleetSignalResponse } = await import('./services/price-signal');
    await scoreFleetSignalResponse('psig-1');

    const siteUpdate = state.updated.find(row => row.table === tbl.priceSignalSites);
    expect(siteUpdate?.values).toMatchObject({ response: 'deviated', actualNetWh: 7200 });
  });

  it('sums the site power across its assets rather than averaging the rows', async () => {
    mockDb();
    state.rows.set(tbl.priceSignals, [publishedSignal]);
    state.rows.set(tbl.priceSignalSites, [siteRow(1800)]);
    state.rows.set(tbl.priceSignalIntervals, []);
    // Two assets, three samples each: the SQL groups by asset and sums the
    // per-asset means, so a site importing 900 W through two meters is scored
    // on 900 W and not on the 450 W a row-wise average would report.
    const queries: string[] = [];
    state.execute = async (query: unknown) => {
      queries.push(JSON.stringify(query));
      return { rows: [{ samples: 6, site_mean_power: -900 }] };
    };

    const { scoreFleetSignalResponse } = await import('./services/price-signal');
    await scoreFleetSignalResponse('psig-1');

    expect(queries.join(' ')).toContain('GROUP BY');
    const siteUpdate = state.updated.find(row => row.table === tbl.priceSignalSites);
    expect(siteUpdate?.values).toMatchObject({
      response: 'followed',
      actualNetWh: 1800,
      telemetrySamples: 6,
    });
  });
});
