/**
 * Regression tests for V2G dispatch. The command used to update session and
 * station rows and report success without sending anything to the charge point,
 * and compared a scaled state of charge against a real percentage so the
 * minimum-SoC floor never held. These tests pin the corrected behaviour:
 *  - a discharge is an OCPP profile with a bounded window and negative watts
 *  - session/station state only moves once the charge point accepted it
 *  - a refused or unreachable charge point reports failure
 *  - the SoC floor and the vehicle/station power ratings are enforced
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

const NOW = new Date('2026-03-01T12:00:00.000Z');

interface DbHarness {
  results: Array<{ rows: Record<string, unknown>[] }>;
  calls: number;
}

const evRow = (overrides: Record<string, unknown> = {}) => ({
  id: 7,
  user_id: 3,
  vin: 'VIN',
  battery_capacity_kwh: 600, // 60 kWh
  usable_battery_kwh: 550,
  max_charging_power_kw: 110, // 11 kW
  max_discharging_power_kw: 100, // 10 kW
  v2g_capable: true,
  v2h_capable: false,
  bidirectional_protocol: 'ccs_v2g',
  current_soc_percent: 5000, // 50%
  is_plugged_in: true,
  is_charging: true,
  min_soc_percent: 2000, // 20%
  target_soc_percent: 8000,
  status: 'active',
  ...overrides,
});

const sessionRow = (overrides: Record<string, unknown> = {}) => ({
  id: 42,
  ev_id: 7,
  station_id: 5,
  user_id: 3,
  session_id: 'ocpp:CP-1:1:1772366400000',
  status: 'charging',
  metadata: JSON.stringify({ connectorId: 1, idTag: 'TAG' }),
  ...overrides,
});

const stationRow = (overrides: Record<string, unknown> = {}) => ({
  id: 5,
  user_id: 3,
  station_id: 'CP-1',
  name: 'Home charger',
  connector_type: 'type2',
  max_power_kw: 220, // 22 kW
  v2g_capable: true,
  ocpp_version: '1.6',
  ocpp_endpoint: null,
  status: 'charging',
  last_heartbeat: null,
  ...overrides,
});

/** Answers the service's queries in order and counts write statements. */
async function mockDb(results: Array<Record<string, unknown>[]>): Promise<DbHarness> {
  const harness: DbHarness = { results: results.map(rows => ({ rows })), calls: 0 };
  vi.doMock('./db', () => ({
    getDb: vi.fn(async () => ({
      execute: vi.fn(async () => {
        harness.calls += 1;
        return harness.results.shift() ?? { rows: [] };
      }),
    })),
  }));
  return harness;
}

interface DeliveryHarness {
  dispatches: Array<Record<string, unknown>>;
  revocations: Array<Record<string, unknown>>;
  delivered: boolean;
  status: string;
  reason?: string;
  revokeError?: Error;
}

async function mockDelivery(state: Partial<DeliveryHarness> = {}): Promise<DeliveryHarness> {
  const h: DeliveryHarness = {
    dispatches: [],
    revocations: [],
    delivered: true,
    status: 'Accepted',
    ...state,
  };
  vi.doMock('./services/control-delivery', () => ({
    dispatchChargingPlan: vi.fn(async (input: Record<string, unknown>) => {
      h.dispatches.push(input);
      const seconds = Number(input.validForSeconds);
      return {
        delivered: h.delivered,
        status: h.delivered ? h.status : 'rejected',
        assignmentId: 11,
        validFrom: NOW,
        validTo: new Date(NOW.getTime() + seconds * 1000),
        fallbackPolicy: input.fallbackPolicy,
        fallbackLimitWatts: null,
        reason: h.reason,
      };
    }),
    revokeControl: vi.fn(async (input: Record<string, unknown>) => {
      h.revocations.push(input);
      if (h.revokeError) throw h.revokeError;
      return { revoked: true, status: 'Accepted', assignmentId: 11 };
    }),
  }));
  return h;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('./db');
  vi.doUnmock('./services/control-delivery');
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

// Collaborators the V2G path does not use, stubbed so re-importing the service
// per test does not re-register Prometheus metrics or pull in the optimizer.
vi.mock('./integration/kafka-publisher', () => ({ kafkaPublisher: { publishEVSession: vi.fn() } }));
vi.mock('./services/settlement-ledger', () => ({ settlementLedger: {} }));
vi.mock('./services/optimization-engine', () => ({ optimizationEngine: {} }));
vi.mock('./ml/price-prediction', () => ({ pricePredictionService: {} }));

async function service() {
  const { evCharging } = await import('./services/ev-charging');
  return evCharging;
}

describe('dispatchV2G', () => {
  it('sends a bounded negative-watt profile and only then marks the session discharging', async () => {
    const db = await mockDb([[evRow()], [sessionRow()], [stationRow()]]);
    const delivery = await mockDelivery();
    const result = await (await service()).dispatchV2G(7, {
      action: 'start_discharge',
      powerKw: 7,
      durationMinutes: 30,
    });

    expect(result.success).toBe(true);
    expect(delivery.dispatches).toHaveLength(1);
    expect(delivery.dispatches[0]).toMatchObject({
      chargePointId: 'CP-1',
      connectorId: 1,
      transactionId: 42,
      validForSeconds: 1800,
      fallbackPolicy: 'resume_local',
      source: 'v2g_schedule',
      evId: 7,
      userId: 3,
    });
    expect(delivery.dispatches[0].periods).toEqual([
      { startPeriodSeconds: 0, limitWatts: -7000 },
    ]);
    expect(result.validTo?.toISOString()).toBe(new Date(NOW.getTime() + 1800_000).toISOString());
    // 3 reads + the session and station updates
    expect(db.calls).toBe(5);
  });

  it('clamps the discharge to the lower of the vehicle and station ratings', async () => {
    await mockDb([[evRow()], [sessionRow()], [stationRow()]]);
    const delivery = await mockDelivery();
    const result = await (await service()).dispatchV2G(7, {
      action: 'start_discharge',
      powerKw: 50,
      durationMinutes: 15,
    });

    expect(result.dischargeKw).toBe(10);
    expect(delivery.dispatches[0].periods).toEqual([
      { startPeriodSeconds: 0, limitWatts: -10000 },
    ]);
  });

  it('refuses a discharge that does not say when it stops', async () => {
    const db = await mockDb([[evRow()], [sessionRow()], [stationRow()]]);
    const delivery = await mockDelivery();
    const result = await (await service()).dispatchV2G(7, { action: 'start_discharge' });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/durationMinutes is required/);
    expect(delivery.dispatches).toHaveLength(0);
    expect(db.calls).toBe(3);
  });

  it('enforces the minimum state of charge on real percentages', async () => {
    await mockDb([[evRow({ current_soc_percent: 1500 })], [sessionRow()], [stationRow()]]);
    const delivery = await mockDelivery();
    const result = await (await service()).dispatchV2G(7, {
      action: 'start_discharge',
      durationMinutes: 30,
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/SoC \(15%\) at or below minimum \(20%\)/);
    expect(delivery.dispatches).toHaveLength(0);
  });

  it('reports failure and leaves state untouched when the charge point refuses', async () => {
    const db = await mockDb([[evRow()], [sessionRow()], [stationRow()]]);
    const delivery = await mockDelivery({
      delivered: false,
      reason: 'charge point did not accept the command',
    });
    const result = await (await service()).dispatchV2G(7, {
      action: 'start_discharge',
      durationMinutes: 30,
    });

    expect(result.success).toBe(false);
    expect(result.delivery).toBe('rejected');
    expect(result.assignmentId).toBe(11);
    expect(delivery.dispatches).toHaveLength(1);
    // Reads only: no session or station row claims a discharge is running.
    expect(db.calls).toBe(3);
  });

  it('refuses a station that does not speak OCPP 1.6', async () => {
    await mockDb([[evRow()], [sessionRow()], [stationRow({ ocpp_version: null })]]);
    const delivery = await mockDelivery();
    const result = await (await service()).dispatchV2G(7, {
      action: 'start_discharge',
      durationMinutes: 30,
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/OCPP none/);
    expect(delivery.dispatches).toHaveLength(0);
  });

  it('refuses a session with no recorded OCPP connector', async () => {
    await mockDb([[evRow()], [sessionRow({ metadata: null })], [stationRow()]]);
    const delivery = await mockDelivery();
    const result = await (await service()).dispatchV2G(7, {
      action: 'start_discharge',
      durationMinutes: 30,
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/records no OCPP connector/);
    expect(delivery.dispatches).toHaveLength(0);
  });

  it('clears the profile to stop a discharge', async () => {
    const db = await mockDb([[evRow()], [sessionRow({ status: 'discharging' })], [stationRow()]]);
    const delivery = await mockDelivery();
    const result = await (await service()).dispatchV2G(7, { action: 'stop_discharge' });

    expect(result.success).toBe(true);
    expect(delivery.revocations[0]).toMatchObject({ chargePointId: 'CP-1', connectorId: 1 });
    expect(db.calls).toBe(5);
  });

  it('keeps the session discharging when the stop command fails', async () => {
    const db = await mockDb([[evRow()], [sessionRow({ status: 'discharging' })], [stationRow()]]);
    await mockDelivery({ revokeError: new Error('charge point is not connected') });
    const result = await (await service()).dispatchV2G(7, { action: 'stop_discharge' });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/could not be stopped/);
    expect(db.calls).toBe(3);
  });
});
