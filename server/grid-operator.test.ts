/**
 * Grid-operator endpoints serve external operators and the admin UI, so the
 * failure modes pinned here are all about fabricated confidence:
 *  - an empty grid_monitoring table is reported as unavailable, never as a
 *    plausible "normal" 50 Hz / 230 V / 450 MW reading
 *  - a missing market price is priceType 'unavailable' with a null price,
 *    never a time-of-day guess labelled 'realtime'
 *  - thin history yields an empty forecast with insufficientHistory: true,
 *    never a time-of-day pattern with an invented confidence
 *  - capacity is null: nothing in the schema measures it
 *  - an asset with unknown state of charge is excluded with a reason, never
 *    counted at an assumed 50%
 *  - a request with no region and no resolvable user profile fails with a
 *    named no_region error instead of a hardcoded 'TZ-DAR'
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Schema = typeof import('../drizzle/schema');

/** Re-imported after every module reset; rows are keyed by table identity. */
let schema: Schema;

interface DbState {
  rows: Map<unknown, unknown[]>;
  failOn?: unknown;
}

class Query {
  constructor(
    private readonly table: unknown,
    private readonly rows: unknown[]
  ) {}
  where(): Query {
    return this;
  }
  orderBy(): Query {
    return this;
  }
  groupBy(): Query {
    return this;
  }
  limit(): Query {
    return this;
  }
  then<TResult>(
    onFulfilled: (value: unknown[]) => TResult,
    onRejected?: (reason: unknown) => TResult
  ): Promise<TResult> {
    if (state.failOn === this.table) {
      return Promise.reject(new Error('connection reset')).then(onFulfilled, onRejected);
    }
    return Promise.resolve(this.rows).then(onFulfilled, onRejected);
  }
}

let state: DbState;

function mockDb() {
  const db = {
    select: () => ({ from: (table: unknown) => new Query(table, state.rows.get(table) ?? []) }),
  };
  vi.doMock('./db', () => ({ getDb: async () => db }));
}

function mockNoDb() {
  vi.doMock('./db', () => ({ getDb: async () => null }));
}

let createdDREvents: unknown[] = [];

function mockDrDb() {
  vi.doMock('./dr-db', () => ({
    createDREvent: async (event: unknown) => {
      createdDREvents.push(event);
      return { id: 1 };
    },
  }));
}

beforeEach(async () => {
  vi.resetModules();
  schema = await import('../drizzle/schema');
  createdDREvents = [];
  state = { rows: new Map() };
  mockDrDb();
});

afterEach(() => {
  vi.doUnmock('./db');
  vi.doUnmock('./dr-db');
});

const REGION = 'TZ-DAR';

function gridRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    timestamp: new Date('2026-03-01T12:00:00.000Z'),
    totalLoad: 450_000,
    peakLoad: 500_000,
    averageLoad: 400_000,
    totalGeneration: 470_000,
    renewableGeneration: 100_000,
    renewablePercentage: 21,
    frequency: 4990, // Hz * 100
    voltage: 231,
    gridStatus: 'stressed',
    spotPrice: null,
    ...overrides,
  };
}

describe('getGridStatus', () => {
  it('reports unavailable with a reason when grid_monitoring is empty, instead of fabricating a normal reading', async () => {
    mockDb();
    state.rows.set(schema.gridMonitoring, []);

    const { gridOperatorService } = await import('./integration/grid-operator');
    const status = await gridOperatorService.getGridStatus(REGION);

    expect(status.available).toBe(false);
    expect(status.status).toBe('unavailable');
    expect(status.reason).toContain('no grid monitoring data');
    expect(status.frequency).toBeNull();
    expect(status.voltage).toBeNull();
    expect(status.load).toBeNull();
    expect(status.capacity).toBeNull();
    expect(status.utilization).toBeNull();
    expect(status.timestamp).toBeNull();
  });

  it('reports unavailable when the query fails rather than falling back to defaults', async () => {
    mockDb();
    state.failOn = schema.gridMonitoring;

    const { gridOperatorService } = await import('./integration/grid-operator');
    const status = await gridOperatorService.getGridStatus(REGION);

    expect(status.available).toBe(false);
    expect(status.reason).toContain('connection reset');
    expect(status.frequency).toBeNull();
  });

  it('reports unavailable when the database itself is unavailable', async () => {
    mockNoDb();

    const { gridOperatorService } = await import('./integration/grid-operator');
    const status = await gridOperatorService.getGridStatus(REGION);

    expect(status.available).toBe(false);
    expect(status.reason).toContain('database unavailable');
  });

  it('reports real row values, maps the recorded grid status, and nulls the unmeasured capacity', async () => {
    mockDb();
    state.rows.set(schema.gridMonitoring, [gridRow()]);

    const { gridOperatorService } = await import('./integration/grid-operator');
    const status = await gridOperatorService.getGridStatus(REGION);

    expect(status.available).toBe(true);
    expect(status.frequency).toBe(49.9);
    expect(status.voltage).toBe(231);
    expect(status.load).toBe(450_000);
    expect(status.status).toBe('warning'); // stored 'stressed', mapped, not re-derived
    // No capacity source exists in the schema; it is null with a reason,
    // not generation x 1.2.
    expect(status.capacity).toBeNull();
    expect(status.utilization).toBeNull();
    expect(status.reason).toContain('capacity');
    expect(status.region).toBe(REGION);
  });

  it('throws a named no_region error when neither region nor user profile resolves one', async () => {
    mockDb();
    state.rows.set(schema.gridMonitoring, [gridRow()]);

    const { gridOperatorService, GridOperatorError } = await import(
      './integration/grid-operator'
    );
    const failure = gridOperatorService.getGridStatus();
    await expect(failure).rejects.toBeInstanceOf(GridOperatorError);
    await expect(failure).rejects.toThrow(/no_region/);
  });

  it('resolves the region from a real user profile country when no region is passed', async () => {
    mockDb();
    state.rows.set(schema.gridMonitoring, [gridRow()]);
    state.rows.set(schema.users, [{ country: 'nigeria' }]);

    const { gridOperatorService } = await import('./integration/grid-operator');
    const status = await gridOperatorService.getGridStatus(undefined, 42);

    expect(status.region).toBe('NG-LAGOS');
    expect(status.available).toBe(true);
  });
});

describe('getPricingSignal', () => {
  function priceRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 1,
      country: 'tanzania',
      priceType: 'peak',
      price: 62,
      timestamp: new Date(Date.now() - 600_000),
      validUntil: new Date(Date.now() + 600_000),
      metadata: null,
      createdAt: new Date(),
      ...overrides,
    };
  }

  it('returns priceType unavailable with a null price when no current market price exists', async () => {
    mockDb();
    state.rows.set(schema.marketPrices, []);

    const { gridOperatorService } = await import('./integration/grid-operator');
    const signal = await gridOperatorService.getPricingSignal(REGION);

    expect(signal.available).toBe(false);
    expect(signal.priceType).toBe('unavailable');
    expect(signal.price).toBeNull();
    expect(signal.currency).toBeNull();
    expect(signal.validUntil).toBeNull();
    expect(signal.reason).toBeTruthy();
  });

  it('returns the real stored price type, never a computed guess labelled realtime', async () => {
    mockDb();
    state.rows.set(schema.marketPrices, [priceRow()]);

    const { gridOperatorService } = await import('./integration/grid-operator');
    const signal = await gridOperatorService.getPricingSignal(REGION);

    expect(signal.available).toBe(true);
    expect(signal.priceType).toBe('peak'); // the stored enum value
    expect(signal.price).toBe(62);
    expect(signal.currency).toBe('TZS');
  });

  it('does not silently query the tanzanian feed for an unmapped region', async () => {
    mockDb();
    state.rows.set(schema.marketPrices, [priceRow()]);

    const { gridOperatorService } = await import('./integration/grid-operator');
    const signal = await gridOperatorService.getPricingSignal('XX-NOWHERE');

    expect(signal.available).toBe(false);
    expect(signal.priceType).toBe('unavailable');
    expect(signal.reason).toContain('XX-NOWHERE');
  });

  it('throws no_region when no region can be resolved', async () => {
    mockDb();
    const { gridOperatorService, GridOperatorError } = await import(
      './integration/grid-operator'
    );
    const failure = gridOperatorService.getPricingSignal();
    await expect(failure).rejects.toBeInstanceOf(GridOperatorError);
    await expect(failure).rejects.toThrow(/no_region/);
  });
});

describe('getGridForecast', () => {
  it('returns an empty forecast with insufficientHistory when there is no history', async () => {
    mockDb();
    state.rows.set(schema.gridMonitoring, []);

    const { gridOperatorService } = await import('./integration/grid-operator');
    const result = await gridOperatorService.getGridForecast(24, REGION);

    expect(result.insufficientHistory).toBe(true);
    expect(result.forecasts).toEqual([]);
    expect(result.reason).toContain('insufficient_history');
    expect(result.region).toBe(REGION);
  });

  it('refuses to average a handful of records into something that looks measured', async () => {
    mockDb();
    state.rows.set(schema.gridMonitoring, [gridRow(), gridRow({ id: 2 })]);

    const { gridOperatorService } = await import('./integration/grid-operator');
    const result = await gridOperatorService.getGridForecast(24, REGION);

    expect(result.insufficientHistory).toBe(true);
    expect(result.forecasts).toEqual([]);
  });

  it('forecasts only hours covered by real samples, with null capacity', async () => {
    mockDb();
    // 48 real records, all at the same hour of day as one hour ahead of now.
    const targetHour = new Date(Date.now() + 3600_000).getHours();
    const rows = Array.from({ length: 48 }, (_, i) =>
      gridRow({
        id: i + 1,
        // Local-time constructor: forecast hours are grouped by local hour of day.
        timestamp: new Date(2026, 1, 1 + (i % 6), targetHour, 0, 0),
        totalLoad: 400_000 + i * 1000,
      })
    );
    state.rows.set(schema.gridMonitoring, rows);

    const { gridOperatorService } = await import('./integration/grid-operator');
    const result = await gridOperatorService.getGridForecast(24, REGION);

    expect(result.insufficientHistory).toBe(false);
    // Only the one sampled hour-of-day is forecast; no fabricated patterns
    // fill the other 23 hours.
    expect(result.forecasts.length).toBeGreaterThan(0);
    for (const point of result.forecasts) {
      expect(point.forecastTime.getHours()).toBe(targetHour);
      expect(point.predictedLoad).toBeGreaterThan(0);
      expect(point.predictedCapacity).toBeNull();
      expect(point.predictedUtilization).toBeNull();
    }
  });

  it('throws no_region when no region can be resolved', async () => {
    mockDb();
    const { gridOperatorService, GridOperatorError } = await import(
      './integration/grid-operator'
    );
    const failure = gridOperatorService.getGridForecast(24);
    await expect(failure).rejects.toBeInstanceOf(GridOperatorError);
    await expect(failure).rejects.toThrow(/no_region/);
  });
});

describe('getVPPCapacity', () => {
  const asset = { id: 7, userId: 1, assetType: 'battery', capacity: 10_000, status: 'active' };

  it('excludes an asset whose state of charge is unknown instead of assuming 50%', async () => {
    mockDb();
    state.rows.set(schema.assets, [asset]);
    state.rows.set(schema.telemetry, [
      { assetId: 7, timestamp: new Date(), stateOfCharge: null, power: 0 },
    ]);

    const { gridOperatorService } = await import('./integration/grid-operator');
    const capacity = await gridOperatorService.getVPPCapacity(REGION);

    expect(capacity.availableCapacity).toBe(0);
    expect(capacity.excluded).toHaveLength(1);
    expect(capacity.excluded[0].assetId).toBe(7);
    expect(capacity.excluded[0].reason).toContain('state of charge');
    // Nameplate capacity still counts: that part is real.
    expect(capacity.totalCapacity).toBe(10);
  });

  it('excludes an asset with no telemetry at all', async () => {
    mockDb();
    state.rows.set(schema.assets, [asset]);
    state.rows.set(schema.telemetry, []);

    const { gridOperatorService } = await import('./integration/grid-operator');
    const capacity = await gridOperatorService.getVPPCapacity(REGION);

    expect(capacity.availableCapacity).toBe(0);
    expect(capacity.activeAssets).toBe(0);
    expect(capacity.excluded[0]).toMatchObject({ assetId: 7 });
    expect(capacity.excluded[0].reason).toContain('no telemetry');
  });

  it('counts only measured state of charge toward available capacity', async () => {
    mockDb();
    state.rows.set(schema.assets, [asset]);
    state.rows.set(schema.telemetry, [
      { assetId: 7, timestamp: new Date(), stateOfCharge: 8000, power: 0 }, // 80.00%
    ]);

    const { gridOperatorService } = await import('./integration/grid-operator');
    const capacity = await gridOperatorService.getVPPCapacity(REGION);

    expect(capacity.excluded).toEqual([]);
    expect(capacity.activeAssets).toBe(1);
    expect(capacity.availableCapacity).toBe(8); // 80% of 10 kW
  });

  it('throws a named no_region error when no region can be resolved', async () => {
    mockDb();
    const { gridOperatorService, GridOperatorError } = await import(
      './integration/grid-operator'
    );
    const failure = gridOperatorService.getVPPCapacity();
    await expect(failure).rejects.toBeInstanceOf(GridOperatorError);
    await expect(failure).rejects.toThrow(/no_region/);
  });

  it('fails loud when the database is unavailable instead of reporting zero assets', async () => {
    mockNoDb();
    const { gridOperatorService, GridOperatorError } = await import(
      './integration/grid-operator'
    );
    await expect(gridOperatorService.getVPPCapacity(REGION)).rejects.toBeInstanceOf(
      GridOperatorError
    );
  });
});

describe('getVPPPerformance', () => {
  it('fails loud when the database is unavailable instead of reporting fabricated zeros', async () => {
    mockNoDb();
    const { gridOperatorService, GridOperatorError } = await import(
      './integration/grid-operator'
    );
    await expect(gridOperatorService.getVPPPerformance(24)).rejects.toBeInstanceOf(
      GridOperatorError
    );
  });
});

describe('triggerDREvent', () => {
  it('refuses to attribute an event to an invented operator id', async () => {
    mockDb();
    delete process.env.GRID_OPERATOR_ID;

    const { gridOperatorService } = await import('./integration/grid-operator');
    const result = await gridOperatorService.triggerDREvent({
      reason: 'test',
      severity: 'low',
      targetReduction: 100,
      duration: 1,
      compensationRate: 50,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('GRID_OPERATOR_ID');
    expect(createdDREvents).toEqual([]);
  });
});
