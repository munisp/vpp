/**
 * Locational flexibility is a paid promise about a *place*, so the tests pin the
 * three things that make it real rather than plausible:
 *  - an asset whose link to the node nobody verified is never awarded
 *  - an award is capped by the asset's own rating, and clearing that runs out of
 *    eligible capacity is `short`, not `cleared`
 *  - delivery is measured against the asset's own baseline; too few real samples
 *    is `unverified` — neither delivery nor breach — and cannot be settled, and
 *    a partial delivery is paid on what was measured, never on the award
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface DbState {
  /** Row sets returned by `db.select()...`, in call order. */
  selectQueue: unknown[][];
  /** Row sets returned by `db.execute()`, in call order. */
  executeQueue: Record<string, unknown>[][];
  inserted: Array<{ table: string; values: Record<string, unknown> }>;
  updated: Array<Record<string, unknown>>;
  /** Every statement passed to `db.execute()`, so claim/release calls are visible. */
  executed: unknown[];
  returningId: number;
}

class SelectQuery {
  constructor(private readonly rows: unknown[]) {}
  from(): SelectQuery {
    return this;
  }
  where(): SelectQuery {
    return this;
  }
  orderBy(): SelectQuery {
    return this;
  }
  limit(): SelectQuery {
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

function tableNameOf(table: unknown): string {
  const symbols = Object.getOwnPropertySymbols(table as object);
  for (const symbol of symbols) {
    if (String(symbol).includes('Name')) {
      const value = (table as Record<symbol, unknown>)[symbol];
      if (typeof value === 'string') return value;
    }
  }
  return 'unknown';
}

function mockDb(available = true) {
  const db = {
    select: () => new SelectQuery(state.selectQueue.shift() ?? []),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        const record = { table: tableNameOf(table), values };
        const result = {
          returning: async () => {
            state.inserted.push(record);
            return [{ id: state.returningId }];
          },
          onConflictDoUpdate: async () => {
            state.inserted.push(record);
          },
          then<TResult>(onFulfilled: (value: unknown) => TResult) {
            state.inserted.push(record);
            return Promise.resolve(undefined).then(onFulfilled);
          },
        };
        return result;
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          state.updated.push(values);
        },
      }),
    }),
    execute: async (statement: unknown) => {
      state.executed.push(statement);
      return { rows: state.executeQueue.shift() ?? [] };
    },
  };
  vi.doMock('./db', () => ({ getDb: async () => (available ? db : null) }));
}

const ledgerEvents: Array<Record<string, unknown>> = [];

function mockLedger(failure?: string) {
  vi.doMock('./services/settlement-ledger', () => ({
    settlementLedger: {
      createEvent: async (input: Record<string, unknown>) => {
        if (failure) throw new Error(failure);
        ledgerEvents.push(input);
        return { id: 9001 };
      },
    },
  }));
}

/**
 * Settlement is guarded by meter-telemetry evidence. These tests exercise the
 * clearing and settlement arithmetic, so the guard is mocked available here and
 * its refusal is covered where the refusal itself is the subject.
 */
function mockDegraded(refusal?: string) {
  vi.doMock('./services/degraded-operation', async () => {
    const actual =
      await vi.importActual<typeof import('./services/degraded-operation')>(
        './services/degraded-operation'
      );
    return {
      ...actual,
      requireCapability: async (capability: string) => {
        if (refusal) throw new actual.DegradedOperationError(capability, ['meter_telemetry'], refusal);
        return { posture: 'available' as const, missing: [], evidenceLimit: null };
      },
    };
  });
}

beforeEach(() => {
  vi.resetModules();
  ledgerEvents.length = 0;
  state = {
    selectQueue: [],
    executeQueue: [],
    inserted: [],
    updated: [],
    executed: [],
    returningId: 1,
  };
  mockLedger();
  mockDegraded();
});

afterEach(() => {
  vi.doUnmock('./db');
  vi.doUnmock('./services/settlement-ledger');
  vi.doUnmock('./services/degraded-operation');
  vi.restoreAllMocks();
});

describe('reductionWatts', () => {
  it('reads a reduction in the direction the operator asked for', async () => {
    const { reductionWatts } = await import('./services/locational-flexibility');
    // Telemetry is generation-positive, so reducing import means power rose.
    expect(reductionWatts('import_reduction', -4000, -1500)).toBe(2500);
    expect(reductionWatts('import_reduction', -1500, -4000)).toBe(-2500);
    // Reducing export means generation-positive power fell.
    expect(reductionWatts('export_reduction', 5000, 1000)).toBe(4000);
    expect(reductionWatts('export_reduction', 1000, 5000)).toBe(-4000);
  });
});

describe('unverifiedMeasurementReason', () => {
  it('names the missing evidence instead of assuming delivery', async () => {
    const { unverifiedMeasurementReason } = await import('./services/locational-flexibility');
    expect(
      unverifiedMeasurementReason({ measuredSamples: 0, baselineSamples: 40, baselineDays: 8 })
    ).toMatch(/telemetry samples in the delivery window/);
    expect(
      unverifiedMeasurementReason({ measuredSamples: 12, baselineSamples: 2, baselineDays: 1 })
    ).toMatch(/baseline samples/);
    expect(
      unverifiedMeasurementReason({ measuredSamples: 12, baselineSamples: 40, baselineDays: 2 })
    ).toMatch(/comparable days/);
    expect(
      unverifiedMeasurementReason({ measuredSamples: 12, baselineSamples: 40, baselineDays: 8 })
    ).toBeNull();
  });
});

describe('ineligibilityReason', () => {
  it('refuses to sell relief at a node the asset may not be behind', async () => {
    const { ineligibilityReason } = await import('./services/locational-flexibility');
    const base = {
      assetStatus: 'active',
      linkedNodeId: 5,
      requirementNodeId: 5,
      linkSource: 'operator_declared' as const,
      price: 1000,
      priceCap: 1500,
    };
    expect(ineligibilityReason(base)).toBeNull();
    expect(ineligibilityReason({ ...base, linkSource: 'unverified' })).toMatch(/unverified/);
    expect(ineligibilityReason({ ...base, linkedNodeId: null })).toMatch(/no longer linked/);
    expect(ineligibilityReason({ ...base, linkedNodeId: 7 })).toMatch(/moved to node 7/);
    expect(ineligibilityReason({ ...base, assetStatus: 'fault' })).toMatch(/is fault/);
    expect(ineligibilityReason({ ...base, price: 2000 })).toMatch(/above the operator's cap/);
  });
});

describe('submitOffer', () => {
  const requirement = {
    id: 3,
    nodeId: 5,
    status: 'open',
    startsAt: new Date('2026-05-01T18:00:00.000Z'),
    endsAt: new Date('2026-05-01T19:00:00.000Z'),
    priceCapCentsPerKwh: 2000,
  };
  const now = new Date('2026-05-01T09:00:00.000Z');

  it('stores an offer within the asset rating for a linked asset', async () => {
    mockDb();
    state.selectQueue = [
      [requirement],
      [{ id: 11, userId: 42, capacity: 5000, status: 'active' }],
      [{ nodeId: 5, linkSource: 'utility_verified' }],
    ];
    state.returningId = 77;
    const { submitOffer } = await import('./services/locational-flexibility');
    const offerId = await submitOffer(
      { requirementId: 3, assetId: 11, offeredPowerW: 4000, priceCentsPerKwh: 1200 },
      42,
      now
    );
    expect(offerId).toBe(77);
    expect(state.inserted[0].values).toMatchObject({
      offeredPowerW: 4000,
      linkSource: 'utility_verified',
      userId: 42,
    });
  });

  it('refuses an offer larger than the asset can deliver', async () => {
    mockDb();
    state.selectQueue = [
      [requirement],
      [{ id: 11, userId: 42, capacity: 3000, status: 'active' }],
    ];
    const { submitOffer, LocationalFlexibilityError } = await import(
      './services/locational-flexibility'
    );
    await expect(
      submitOffer(
        { requirementId: 3, assetId: 11, offeredPowerW: 9000, priceCentsPerKwh: 1200 },
        42,
        now
      )
    ).rejects.toThrow(LocationalFlexibilityError);
  });

  it("refuses another owner's asset", async () => {
    mockDb();
    state.selectQueue = [
      [requirement],
      [{ id: 11, userId: 99, capacity: 5000, status: 'active' }],
    ];
    const { submitOffer } = await import('./services/locational-flexibility');
    await expect(
      submitOffer(
        { requirementId: 3, assetId: 11, offeredPowerW: 1000, priceCentsPerKwh: 1200 },
        42,
        now
      )
    ).rejects.toThrow(/another owner/);
  });

  it('refuses an asset that is not linked to the requirement node', async () => {
    mockDb();
    state.selectQueue = [
      [requirement],
      [{ id: 11, userId: 42, capacity: 5000, status: 'active' }],
      [{ nodeId: 8, linkSource: 'utility_verified' }],
    ];
    const { submitOffer } = await import('./services/locational-flexibility');
    await expect(
      submitOffer(
        { requirementId: 3, assetId: 11, offeredPowerW: 1000, priceCentsPerKwh: 1200 },
        42,
        now
      )
    ).rejects.toThrow(/not linked to node 5/);
  });

  it('closes offers once the delivery window has started', async () => {
    mockDb();
    state.selectQueue = [[requirement]];
    const { submitOffer } = await import('./services/locational-flexibility');
    await expect(
      submitOffer(
        { requirementId: 3, assetId: 11, offeredPowerW: 1000, priceCentsPerKwh: 1200 },
        42,
        new Date('2026-05-01T18:30:00.000Z')
      )
    ).rejects.toThrow(/already started/);
  });
});

describe('clearRequirement', () => {
  function offerRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 1,
      asset_id: 11,
      user_id: 42,
      offered_power_w: 5000,
      price_cents_per_kwh: 1000,
      link_source: 'operator_declared',
      asset_capacity: 5000,
      asset_status: 'active',
      linked_node_id: 5,
      current_link_source: 'operator_declared',
      ...overrides,
    };
  }

  it('fills in merit order and trims the marginal award to the need', async () => {
    mockDb();
    state.selectQueue = [
      [{ id: 3, nodeId: 5, status: 'open', requiredPowerW: 7000, priceCapCentsPerKwh: 2000 }],
    ];
    state.executeQueue = [
      [
        offerRow({ id: 1, price_cents_per_kwh: 900 }),
        offerRow({ id: 2, asset_id: 12, price_cents_per_kwh: 1100 }),
        offerRow({ id: 3, asset_id: 13, price_cents_per_kwh: 1900 }),
      ],
    ];
    const { clearRequirement } = await import('./services/locational-flexibility');
    const result = await clearRequirement(3);
    expect(result.status).toBe('cleared');
    expect(result.clearedPowerW).toBe(7000);
    expect(result.awards.map(a => [a.offerId, a.awardedPowerW])).toEqual([
      [1, 5000],
      [2, 2000],
    ]);
    expect(result.clearingPriceCentsPerKwh).toBe(1100);
    expect(result.notAwarded).toEqual([3]);
  });

  it('caps an award by the asset rating as it stands at clearing', async () => {
    mockDb();
    state.selectQueue = [
      [{ id: 3, nodeId: 5, status: 'open', requiredPowerW: 9000, priceCapCentsPerKwh: 2000 }],
    ];
    state.executeQueue = [[offerRow({ offered_power_w: 9000, asset_capacity: 4000 })]];
    const { clearRequirement } = await import('./services/locational-flexibility');
    const result = await clearRequirement(3);
    expect(result.awards[0].awardedPowerW).toBe(4000);
    expect(result.status).toBe('short');
    expect(result.clearedPowerW).toBe(4000);
  });

  it('records an unverified node link as ineligible with its reason', async () => {
    mockDb();
    state.selectQueue = [
      [{ id: 3, nodeId: 5, status: 'open', requiredPowerW: 5000, priceCapCentsPerKwh: 2000 }],
    ];
    state.executeQueue = [
      [offerRow({ link_source: 'unverified', current_link_source: 'unverified' })],
    ];
    const { clearRequirement } = await import('./services/locational-flexibility');
    const result = await clearRequirement(3);
    expect(result.awards).toEqual([]);
    expect(result.status).toBe('short');
    expect(result.ineligible[0].reason).toMatch(/unverified/);
    expect(state.updated.some(u => u.status === 'ineligible')).toBe(true);
  });

  it('refuses to clear a requirement twice', async () => {
    mockDb();
    state.selectQueue = [
      [{ id: 3, nodeId: 5, status: 'cleared', requiredPowerW: 5000, priceCapCentsPerKwh: 2000 }],
    ];
    const { clearRequirement } = await import('./services/locational-flexibility');
    await expect(clearRequirement(3)).rejects.toThrow(/already cleared/);
  });
});

describe('measureAward', () => {
  const awardRow = {
    id: 8,
    asset_id: 11,
    awarded_power_w: 3000,
    price_cents_per_kwh: 1200,
    direction: 'import_reduction',
    starts_at: '2026-05-01T18:00:00.000Z',
    ends_at: '2026-05-01T19:00:00.000Z',
  };
  const after = new Date('2026-05-01T19:05:00.000Z');

  it('refuses to grade a window that has not elapsed', async () => {
    mockDb();
    state.executeQueue = [[awardRow]];
    const { measureAward } = await import('./services/locational-flexibility');
    await expect(measureAward(8, new Date('2026-05-01T18:30:00.000Z'))).rejects.toThrow(
      /has not elapsed/
    );
  });

  it('reports unverified when the baseline has too little real history', async () => {
    mockDb();
    state.executeQueue = [
      [awardRow],
      [
        {
          measured_samples: 12,
          measured_power: -1000,
          baseline_samples: 2,
          baseline_days: 1,
          baseline_power: -4000,
        },
      ],
    ];
    const { measureAward } = await import('./services/locational-flexibility');
    const result = await measureAward(8, after);
    expect(result.deliveryStatus).toBe('unverified');
    expect(result.deliveredEnergyWh).toBeNull();
    expect(result.earnedAmount).toBeNull();
    expect(result.unverifiedReason).toMatch(/baseline samples/);
  });

  it('reports unverified when the asset was silent through the window', async () => {
    mockDb();
    state.executeQueue = [
      [awardRow],
      [
        {
          measured_samples: 0,
          measured_power: null,
          baseline_samples: 40,
          baseline_days: 9,
          baseline_power: -4000,
        },
      ],
    ];
    const { measureAward } = await import('./services/locational-flexibility');
    const result = await measureAward(8, after);
    expect(result.deliveryStatus).toBe('unverified');
    expect(result.measuredPowerW).toBeNull();
    expect(result.unverifiedReason).toMatch(/delivery window/);
  });

  it('credits a full delivery at the awarded block, not more', async () => {
    mockDb();
    state.executeQueue = [
      [awardRow],
      [
        {
          measured_samples: 12,
          measured_power: -100,
          baseline_samples: 40,
          baseline_days: 9,
          baseline_power: -4500,
        },
      ],
    ];
    const { measureAward } = await import('./services/locational-flexibility');
    const result = await measureAward(8, after);
    expect(result.deliveredPowerW).toBe(4400);
    expect(result.creditedPowerW).toBe(3000);
    // One hour at 3 kW credited, paid at 1200 (cents/kWh x100) => 36 units.
    expect(result.deliveredEnergyWh).toBe(3000);
    expect(result.earnedAmount).toBe(36);
    expect(result.deliveryStatus).toBe('delivered');
  });

  it('credits a sub-hour window for the time it actually ran', async () => {
    mockDb();
    state.executeQueue = [
      [
        {
          ...awardRow,
          starts_at: '2026-05-01T18:00:00.000Z',
          ends_at: '2026-05-01T18:01:30.000Z',
        },
      ],
      [
        {
          measured_samples: 12,
          measured_power: -1500,
          baseline_samples: 40,
          baseline_days: 9,
          baseline_power: -4500,
        },
      ],
    ];
    const { measureAward } = await import('./services/locational-flexibility');
    const result = await measureAward(8, after);
    // 3 kW credited for 90 seconds is 75 Wh. Rounding the window to minutes
    // would have paid two minutes (100 Wh) or, for a shorter window, nothing.
    expect(result.creditedPowerW).toBe(3000);
    expect(result.deliveredEnergyWh).toBe(75);
  });

  it('pays a short delivery on what was measured', async () => {
    mockDb();
    state.executeQueue = [
      [awardRow],
      [
        {
          measured_samples: 12,
          measured_power: -3000,
          baseline_samples: 40,
          baseline_days: 9,
          baseline_power: -4500,
        },
      ],
    ];
    const { measureAward } = await import('./services/locational-flexibility');
    const result = await measureAward(8, after);
    expect(result.deliveryStatus).toBe('partial');
    expect(result.creditedPowerW).toBe(1500);
    expect(result.deliveredEnergyWh).toBe(1500);
    expect(result.earnedAmount).toBe(18);
  });

  it('reports no delivery when the asset moved the wrong way', async () => {
    mockDb();
    state.executeQueue = [
      [awardRow],
      [
        {
          measured_samples: 12,
          measured_power: -6000,
          baseline_samples: 40,
          baseline_days: 9,
          baseline_power: -4500,
        },
      ],
    ];
    const { measureAward } = await import('./services/locational-flexibility');
    const result = await measureAward(8, after);
    expect(result.deliveryStatus).toBe('not_delivered');
    expect(result.deliveredPowerW).toBe(0);
    expect(result.deliveredEnergyWh).toBe(0);
  });

  it('persists the measurement provenance beside the verdict', async () => {
    mockDb();
    state.executeQueue = [
      [awardRow],
      [
        {
          measured_samples: 12,
          measured_power: -100,
          baseline_samples: 40,
          baseline_days: 9,
          baseline_power: -4500,
        },
      ],
    ];
    const { measureAward, BASELINE_METHOD } = await import('./services/locational-flexibility');
    await measureAward(8, after);
    const persisted = state.updated[0];
    expect(persisted.deliveryStatus).toBe('delivered');
    expect(persisted.measurement).toMatchObject({
      baselineMethod: BASELINE_METHOD,
      baselineDays: 9,
      creditedPowerW: 3000,
      durationMinutes: 60,
    });
  });
});

describe('settleAward', () => {
  function settleRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 8,
      user_id: 42,
      asset_id: 11,
      requirement_id: 3,
      delivery_status: 'partial',
      delivered_energy_wh: 1500,
      delivered_power_w: 1500,
      awarded_power_w: 3000,
      price_cents_per_kwh: 1200,
      settlement_event_id: null,
      currency: 'TZS',
      direction: 'import_reduction',
      starts_at: '2026-05-01T18:00:00.000Z',
      ends_at: '2026-05-01T19:00:00.000Z',
      ...overrides,
    };
  }

  it('settles measured delivery into the ledger with its measurement method', async () => {
    mockDb();
    // Award row, then the claim update winning its row.
    state.executeQueue = [[settleRow()], [{ id: 8 }]];
    const { settleAward, BASELINE_METHOD } = await import('./services/locational-flexibility');
    const result = await settleAward(8);
    expect(result).toEqual({ awardId: 8, settlementEventId: 9001, amount: 18 });
    expect(ledgerEvents[0]).toMatchObject({
      eventType: 'service_delivered',
      sourceType: 'flexibility_award',
      sourceId: 8,
      energyWh: 1500,
      grossAmount: 18,
      netAmount: 18,
      measurementMethod: 'baseline_comparison',
      baselineMethod: BASELINE_METHOD,
    });
    expect(state.updated[0]).toMatchObject({ settlementEventId: 9001 });
  });

  it('refuses to pay an unverified award', async () => {
    mockDb();
    state.executeQueue = [[settleRow({ delivery_status: 'unverified', delivered_energy_wh: null })]];
    const { settleAward } = await import('./services/locational-flexibility');
    await expect(settleAward(8)).rejects.toThrow(/only measured delivery can be settled/);
    expect(ledgerEvents).toEqual([]);
  });

  it('refuses to pay a not-delivered award', async () => {
    mockDb();
    state.executeQueue = [[settleRow({ delivery_status: 'not_delivered', delivered_energy_wh: 0 })]];
    const { settleAward } = await import('./services/locational-flexibility');
    await expect(settleAward(8)).rejects.toThrow(/only measured delivery can be settled/);
    expect(ledgerEvents).toEqual([]);
  });

  it('pays nothing while the meter path is unobservable', async () => {
    mockDegraded('meter_telemetry is unknown');
    mockDb();
    state.executeQueue = [[settleRow()]];
    const { settleAward } = await import('./services/locational-flexibility');
    await expect(settleAward(8)).rejects.toThrow(/meter_telemetry is unknown/);
    expect(ledgerEvents).toEqual([]);
    // Refused before the claim, so the award stays settleable once the meter
    // path is observed again.
    expect(state.updated).toEqual([]);
  });

  it('refuses to record a settlement that credits no money', async () => {
    mockDb();
    // 37 Wh at 30 (0.3 of a cent per kWh) rounds to nothing: a settled award
    // crediting zero is indistinguishable from a paid delivery.
    state.executeQueue = [
      [settleRow({ delivered_energy_wh: 37, delivered_power_w: 2200, price_cents_per_kwh: 30 })],
    ];
    const { settleAward } = await import('./services/locational-flexibility');
    await expect(settleAward(8)).rejects.toThrow(/credits no whole cent/);
    expect(ledgerEvents).toEqual([]);
    expect(state.updated).toEqual([]);
  });

  it('refuses to settle the same award twice', async () => {
    mockDb();
    state.executeQueue = [[settleRow({ settlement_event_id: 4242 })]];
    const { settleAward } = await import('./services/locational-flexibility');
    await expect(settleAward(8)).rejects.toThrow(/already settled as event 4242/);
    expect(ledgerEvents).toEqual([]);
  });

  it('pays nothing when a concurrent settlement already claimed the award', async () => {
    mockDb();
    // Both callers read an unsettled award; only one claim update matches a row,
    // so the loser must stop before writing a paid ledger event.
    state.executeQueue = [[settleRow()], []];
    const { settleAward } = await import('./services/locational-flexibility');
    await expect(settleAward(8)).rejects.toThrow(/already being settled/);
    expect(ledgerEvents).toEqual([]);
    expect(state.updated).toEqual([]);
  });

  it('releases its claim when the ledger write fails', async () => {
    mockLedger('ledger unavailable');
    mockDb();
    state.executeQueue = [[settleRow()], [{ id: 8 }], []];
    const { settleAward } = await import('./services/locational-flexibility');
    await expect(settleAward(8)).rejects.toThrow(/ledger unavailable/);
    expect(ledgerEvents).toEqual([]);
    // Read, claim, release: the award is settleable again rather than stuck as
    // settled with no payment behind it.
    expect(state.executed).toHaveLength(3);
    expect(state.updated).toEqual([]);
  });
});

describe('database outage', () => {
  it('raises instead of reporting an empty market', async () => {
    mockDb(false);
    const { listNodeHeadroom, listRequirements, LocationalFlexibilityError } = await import(
      './services/locational-flexibility'
    );
    await expect(listNodeHeadroom()).rejects.toThrow(LocationalFlexibilityError);
    await expect(listRequirements({})).rejects.toThrow(/Database not available/);
  });
});

describe('clockTimeOf', () => {
  it('reads the UTC clock time the baseline compares on', async () => {
    const { clockTimeOf } = await import('./services/locational-flexibility');
    expect(clockTimeOf(new Date('2026-05-01T18:30:15.000Z'))).toBe('18:30:15');
  });
});
