/**
 * A rolling fleet aggregate is what an aggregator shows a grid operator, so the
 * dangerous failure is a confident number over a fleet that half went dark.
 * These tests pin the boundaries:
 *  - silence is reported as silent assets and unseen rated capacity, never
 *    folded into the measured power
 *  - a battery with no reported state of charge contributes no available energy
 *  - a bucket whose window has not elapsed is `open`, not evidence
 *  - a database outage raises, it does not render as an empty fleet
 *  - buckets never rolled up are reported missing instead of back-filled
 *  - scopes are resolved to their own membership, never to the whole fleet
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Inserted {
  values: Record<string, unknown>;
  conflict: unknown;
}

interface DbState {
  selectRows: unknown[];
  inserted: Inserted[];
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
  then<TResult>(
    onFulfilled: (value: unknown[]) => TResult,
    onRejected?: (reason: unknown) => TResult
  ): Promise<TResult> {
    return Promise.resolve(this.rows).then(onFulfilled, onRejected);
  }
}

let state: DbState;

function mockDb(available = true) {
  const db = {
    select: () => ({ from: () => new Query(state.selectRows) }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: async (conflict: unknown) => {
          state.inserted.push({ values, conflict });
        },
      }),
    }),
    execute: async (query: unknown) => state.execute(query),
  };
  vi.doMock('./db', () => ({ getDb: async () => (available ? db : null) }));
}

/** One row of the shape computeFleetWindow's aggregate query returns. */
function aggregateRow(overrides: Record<string, unknown> = {}) {
  return {
    expected_assets: 4,
    reporting_assets: 4,
    silent_assets: 0,
    samples: 40,
    mean_power: -8000,
    reporting_capacity_wh: 40000,
    silent_capacity_wh: 0,
    soc_known_assets: 2,
    soc_unknown_assets: 0,
    available_energy_wh: 12000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  state = {
    selectRows: [],
    inserted: [],
    execute: async () => ({ rows: [aggregateRow()] }),
  };
});

afterEach(() => {
  vi.doUnmock('./db');
  vi.restoreAllMocks();
});

describe('bucketStartFor', () => {
  it('floors onto a shared grid so every scope lines up', async () => {
    const { bucketStartFor } = await import('./services/fleet-telemetry');
    expect(bucketStartFor(new Date('2026-03-01T10:07:31.500Z'), 15).toISOString()).toBe(
      '2026-03-01T10:00:00.000Z'
    );
    expect(bucketStartFor(new Date('2026-03-01T10:52:00.000Z'), 15).toISOString()).toBe(
      '2026-03-01T10:45:00.000Z'
    );
  });

  it('rejects a bucket size that is not whole minutes', async () => {
    const { bucketStartFor, FleetTelemetryError } = await import('./services/fleet-telemetry');
    expect(() => bucketStartFor(new Date(), 7.5)).toThrow(FleetTelemetryError);
    expect(() => bucketStartFor(new Date(), 0)).toThrow(/positive whole number/);
  });
});

describe('scopeKeyOf', () => {
  it('keys each scope distinctly and refuses an underspecified one', async () => {
    const { scopeKeyOf } = await import('./services/fleet-telemetry');
    expect(scopeKeyOf({ scopeType: 'fleet' })).toBe('fleet');
    expect(scopeKeyOf({ scopeType: 'community', scopeId: 12 })).toBe('community:12');
    expect(scopeKeyOf({ scopeType: 'region', region: 'TZ-DAR' })).toBe('region:TZ-DAR');
    expect(() => scopeKeyOf({ scopeType: 'community' })).toThrow(/community id/);
    expect(() => scopeKeyOf({ scopeType: 'region' })).toThrow(/region code/);
  });
});

describe('computeFleetWindow', () => {
  it('integrates the measured mean power over the bucket', async () => {
    mockDb();
    // 8 kW of generation across the reporting assets for a quarter hour.
    state.execute = async () => ({ rows: [aggregateRow({ mean_power: -8000 })] });

    const { computeFleetWindow } = await import('./services/fleet-telemetry');
    const window = await computeFleetWindow(
      { scopeType: 'fleet' },
      new Date('2026-03-01T10:00:00.000Z'),
      15
    );

    expect(window.meanNetPowerWatts).toBe(-8000);
    expect(window.integratedEnergyWh).toBe(-2000);
    expect(window.state).toBe('closed');
    expect(window.scopeKey).toBe('fleet');
  });

  it('reports silent assets and their unseen capacity instead of hiding them', async () => {
    mockDb();
    state.execute = async () => ({
      rows: [
        aggregateRow({
          expected_assets: 10,
          reporting_assets: 4,
          silent_assets: 6,
          reporting_capacity_wh: 40000,
          silent_capacity_wh: 60000,
        }),
      ],
    });

    const { computeFleetWindow } = await import('./services/fleet-telemetry');
    const window = await computeFleetWindow(
      { scopeType: 'fleet' },
      new Date('2026-03-01T10:00:00.000Z'),
      15
    );

    expect(window.expectedAssets).toBe(10);
    expect(window.reportingAssets).toBe(4);
    expect(window.silentAssets).toBe(6);
    // The measured power stands on its own; the blind spot is stated, not filled.
    expect(window.meanNetPowerWatts).toBe(-8000);
    expect(window.silentCapacityWh).toBe(60000);
  });

  it('counts no available energy for a battery with an unknown state of charge', async () => {
    mockDb();
    state.execute = async () => ({
      rows: [
        aggregateRow({ soc_known_assets: 1, soc_unknown_assets: 3, available_energy_wh: 4500 }),
      ],
    });

    const { computeFleetWindow } = await import('./services/fleet-telemetry');
    const window = await computeFleetWindow(
      { scopeType: 'fleet' },
      new Date('2026-03-01T10:00:00.000Z'),
      15
    );

    expect(window.socKnownAssets).toBe(1);
    expect(window.socUnknownAssets).toBe(3);
    expect(window.availableEnergyWh).toBe(4500);
  });

  it('marks a bucket whose window has not elapsed as open', async () => {
    mockDb();
    const { computeFleetWindow, bucketStartFor } = await import('./services/fleet-telemetry');
    const window = await computeFleetWindow({ scopeType: 'fleet' }, bucketStartFor(new Date(), 15), 15);
    expect(window.state).toBe('open');
  });

  it('restricts a community scope to that community, not the whole fleet', async () => {
    mockDb();
    const queries: string[] = [];
    state.execute = async (query: unknown) => {
      queries.push(JSON.stringify(query));
      return { rows: [aggregateRow()] };
    };

    const { computeFleetWindow } = await import('./services/fleet-telemetry');
    await computeFleetWindow(
      { scopeType: 'community', scopeId: 12 },
      new Date('2026-03-01T10:00:00.000Z'),
      15
    );

    const sql = queries.join(' ');
    expect(sql).toContain('community_members');
    expect(sql).toContain('12');
  });

  it('raises when the database is unavailable rather than reporting an empty fleet', async () => {
    mockDb(false);
    const { computeFleetWindow, FleetTelemetryError } = await import('./services/fleet-telemetry');
    await expect(
      computeFleetWindow({ scopeType: 'fleet' }, new Date('2026-03-01T10:00:00.000Z'), 15)
    ).rejects.toThrow(FleetTelemetryError);
  });

  it('raises when the aggregate query returns nothing', async () => {
    mockDb();
    state.execute = async () => ({ rows: [] });
    const { computeFleetWindow } = await import('./services/fleet-telemetry');
    await expect(
      computeFleetWindow({ scopeType: 'fleet' }, new Date('2026-03-01T10:00:00.000Z'), 15)
    ).rejects.toThrow(/no row/);
  });
});

describe('rollUpFleetWindows', () => {
  it('persists one row per bucket, oldest first, upserting on the scope key', async () => {
    mockDb();
    const { rollUpFleetWindows } = await import('./services/fleet-telemetry');
    const written = await rollUpFleetWindows(
      { scopeType: 'fleet' },
      { bucketMinutes: 15, buckets: 3, now: new Date('2026-03-01T10:07:00.000Z') }
    );

    expect(written).toHaveLength(3);
    expect(state.inserted).toHaveLength(3);
    expect(written.map(w => w.bucketStartsAt.toISOString())).toEqual([
      '2026-03-01T09:30:00.000Z',
      '2026-03-01T09:45:00.000Z',
      '2026-03-01T10:00:00.000Z',
    ]);
    // The bucket containing `now` has not elapsed, so it is stored open.
    expect(written[2].state).toBe('open');
    expect(state.inserted[0].conflict).toBeTruthy();
  });

  it('refuses a non-positive bucket count', async () => {
    mockDb();
    const { rollUpFleetWindows } = await import('./services/fleet-telemetry');
    await expect(
      rollUpFleetWindows({ scopeType: 'fleet' }, { bucketMinutes: 15, buckets: 0 })
    ).rejects.toThrow(/buckets must be positive/);
  });
});

describe('getRollingFleetTelemetry', () => {
  it('reports buckets that were never rolled up as missing', async () => {
    mockDb();
    state.selectRows = [
      {
        scopeKey: 'fleet',
        bucketStartsAt: new Date('2026-03-01T10:00:00.000Z'),
        bucketMinutes: 15,
        state: 'closed' as const,
        meanNetPowerWatts: -8000,
        integratedEnergyWh: -2000,
        expectedAssets: 10,
        reportingAssets: 4,
        silentAssets: 6,
        samples: 40,
        reportingCapacityWh: 40000,
        silentCapacityWh: 60000,
        socKnownAssets: 2,
        socUnknownAssets: 2,
        availableEnergyWh: 9000,
        computedAt: new Date('2026-03-01T10:16:00.000Z'),
      },
    ];

    const { getRollingFleetTelemetry } = await import('./services/fleet-telemetry');
    const series = await getRollingFleetTelemetry(
      { scopeType: 'fleet' },
      { bucketMinutes: 15, buckets: 4, now: new Date('2026-03-01T10:20:00.000Z') }
    );

    expect(series.buckets).toHaveLength(1);
    expect(series.missingBuckets).toBe(3);
    expect(series.buckets[0].silentCapacityWh).toBe(60000);
  });

  it('raises when the database is unavailable', async () => {
    mockDb(false);
    const { getRollingFleetTelemetry, FleetTelemetryError } = await import(
      './services/fleet-telemetry'
    );
    await expect(
      getRollingFleetTelemetry({ scopeType: 'fleet' }, { bucketMinutes: 15, buckets: 4 })
    ).rejects.toThrow(FleetTelemetryError);
  });
});

describe('startFleetTelemetryRollup', () => {
  const saved = process.env.FLEET_TELEMETRY_ROLLUP_MS;

  afterEach(async () => {
    const { stopFleetTelemetryRollup } = await import('./services/fleet-telemetry');
    stopFleetTelemetryRollup();
    if (saved === undefined) delete process.env.FLEET_TELEMETRY_ROLLUP_MS;
    else process.env.FLEET_TELEMETRY_ROLLUP_MS = saved;
  });

  it('stays off unless the interval is configured', async () => {
    delete process.env.FLEET_TELEMETRY_ROLLUP_MS;
    const { startFleetTelemetryRollup } = await import('./services/fleet-telemetry');
    expect(startFleetTelemetryRollup()).toBe(false);
  });

  it('refuses an interval that would hammer the database', async () => {
    process.env.FLEET_TELEMETRY_ROLLUP_MS = '250';
    const { startFleetTelemetryRollup } = await import('./services/fleet-telemetry');
    expect(() => startFleetTelemetryRollup()).toThrow(/at least 1000/);
  });

  it('starts once when configured', async () => {
    process.env.FLEET_TELEMETRY_ROLLUP_MS = '60000';
    const { startFleetTelemetryRollup } = await import('./services/fleet-telemetry');
    expect(startFleetTelemetryRollup()).toBe(true);
    expect(startFleetTelemetryRollup()).toBe(true);
  });
});
