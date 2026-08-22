/**
 * P2P trade dispatch used to publish a bare `energy_transfer` MQTT command: no
 * validity window, no fallback, and a trade metadata status of `dispatched` that
 * read like device confirmation. These tests pin the bounded behaviour:
 *  - the trade's energy becomes a bounded export setpoint with a fallback
 *  - a broker publish is recorded as broker_queued, never as delivered energy
 *  - a rate the asset cannot sustain is refused instead of dispatched
 *  - a broker that is down leaves escrow held and the trade marked dispatch_failed
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

interface AssetRow {
  id: number;
  capacity: number;
  serialNumber: string | null;
  metadata: string | null;
}

const tradeUpdates: Array<Record<string, unknown>> = [];

function mockDb(rows: AssetRow[]) {
  const db = {
    select: () => ({ from: () => ({ where: async () => rows }) }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          tradeUpdates.push(values);
        },
      }),
    }),
  };
  vi.doMock('./db', () => ({ getDb: async () => db }));
}

interface DispatchCall {
  deviceId: string;
  setpointWatts: number;
  validForSeconds?: number;
  fallbackPolicy: string;
  source: string;
  sourceId?: number;
  assetId?: number;
  userId?: number;
}

const dispatches: DispatchCall[] = [];

function mockDelivery(published: boolean) {
  vi.doMock('./services/control-delivery', () => ({
    dispatchDeviceSetpoint: async (input: DispatchCall) => {
      dispatches.push(input);
      const validFrom = new Date('2026-03-01T12:00:00.000Z');
      return {
        published,
        status: published ? 'broker_queued' : 'unconfirmed',
        assignmentId: 42,
        validFrom,
        validTo: new Date(validFrom.getTime() + (input.validForSeconds ?? 0) * 1000),
        fallbackPolicy: input.fallbackPolicy,
        fallbackLimitWatts: null,
        reason: published ? undefined : 'MQTT client not connected',
      };
    },
  }));
}

function mockBroker(connected: boolean) {
  vi.doMock('./integration/mqtt-broker', () => ({
    mqttBrokerService: {
      isConnected: () => connected,
      connect: async () => {
        if (!connected) throw new Error('connect refused');
      },
    },
  }));
}

const activeAsset: AssetRow = {
  id: 5,
  capacity: 5000,
  serialNumber: 'DEV-SELLER',
  metadata: null,
};

const originalMaxValidity = process.env.GRID_CONTROL_MAX_VALIDITY_SECONDS;

beforeEach(() => {
  tradeUpdates.length = 0;
  dispatches.length = 0;
  process.env.P2P_TRANSFER_WINDOW_SECONDS = '3600';
});

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('./db');
  vi.doUnmock('./services/control-delivery');
  vi.doUnmock('./integration/mqtt-broker');
  delete process.env.P2P_TRANSFER_WINDOW_SECONDS;
  if (originalMaxValidity === undefined) {
    delete process.env.GRID_CONTROL_MAX_VALIDITY_SECONDS;
  } else {
    process.env.GRID_CONTROL_MAX_VALIDITY_SECONDS = originalMaxValidity;
  }
});

describe('executeEnergyTransfer', () => {
  it('dispatches the trade as a bounded export setpoint with a fallback', async () => {
    mockDb([activeAsset]);
    mockDelivery(true);
    mockBroker(true);
    const { executeEnergyTransfer } = await import('./workflows/p2p-transfer-dispatch');

    const result = await executeEnergyTransfer({
      tradeId: 11,
      sellerId: 7,
      buyerId: 8,
      energyAmount: 2000,
    });

    expect(result.success).toBe(true);
    expect(dispatches).toEqual([
      {
        deviceId: 'DEV-SELLER',
        setpointWatts: 2000, // 2000 Wh over one hour
        validForSeconds: 3600,
        fallbackPolicy: 'resume_local',
        source: 'p2p_trade',
        sourceId: 11,
        assetId: 5,
        userId: 7,
      },
    ]);
  });

  it('records a broker publish as unconfirmed by the device and keeps the trade pending', async () => {
    mockDb([activeAsset]);
    mockDelivery(true);
    mockBroker(true);
    const { executeEnergyTransfer } = await import('./workflows/p2p-transfer-dispatch');

    await executeEnergyTransfer({ tradeId: 11, sellerId: 7, buyerId: 8, energyAmount: 2000 });

    const update = tradeUpdates.at(-1);
    expect(update?.status).toBe('pending');
    const metadata = JSON.parse(String(update?.metadata));
    expect(metadata.transferStatus).toBe('broker_queued');
    expect(metadata.controlAssignmentId).toBe(42);
    expect(metadata.fallbackPolicy).toBe('resume_local');
  });

  it('refuses an export rate the asset is not rated for', async () => {
    mockDb([{ ...activeAsset, capacity: 1000 }]);
    mockDelivery(true);
    mockBroker(true);
    const { executeEnergyTransfer } = await import('./workflows/p2p-transfer-dispatch');

    const result = await executeEnergyTransfer({
      tradeId: 11,
      sellerId: 7,
      buyerId: 8,
      energyAmount: 4000,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/is rated 1000/);
    expect(dispatches).toEqual([]);
    expect(JSON.parse(String(tradeUpdates.at(-1)?.metadata)).transferStatus).toBe('dispatch_failed');
  });

  it('does not claim a transfer when the setpoint was not published', async () => {
    mockDb([activeAsset]);
    mockDelivery(false);
    mockBroker(true);
    const { executeEnergyTransfer } = await import('./workflows/p2p-transfer-dispatch');

    const result = await executeEnergyTransfer({
      tradeId: 11,
      sellerId: 7,
      buyerId: 8,
      energyAmount: 2000,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unconfirmed/);
    const metadata = JSON.parse(String(tradeUpdates.at(-1)?.metadata));
    expect(metadata.transferStatus).toBe('dispatch_failed');
  });

  it('holds escrow when the broker is unreachable', async () => {
    mockDb([activeAsset]);
    mockDelivery(true);
    mockBroker(false);
    const { executeEnergyTransfer } = await import('./workflows/p2p-transfer-dispatch');

    const result = await executeEnergyTransfer({
      tradeId: 11,
      sellerId: 7,
      buyerId: 8,
      energyAmount: 2000,
    });

    expect(result.success).toBe(false);
    expect(dispatches).toEqual([]);
    expect(tradeUpdates.at(-1)?.status).toBe('pending');
  });

  it('rejects a transfer window longer than the platform control bound', async () => {
    process.env.P2P_TRANSFER_WINDOW_SECONDS = '7200';
    mockDb([activeAsset]);
    mockDelivery(true);
    mockBroker(true);
    const { executeEnergyTransfer } = await import('./workflows/p2p-transfer-dispatch');

    await expect(
      executeEnergyTransfer({ tradeId: 11, sellerId: 7, buyerId: 8, energyAmount: 2000 })
    ).rejects.toThrow(/exceeds GRID_CONTROL_MAX_VALIDITY_SECONDS/);
    expect(dispatches).toEqual([]);
  });

  it('defaults the window to the deployment control bound, not the built-in maximum', async () => {
    delete process.env.P2P_TRANSFER_WINDOW_SECONDS;
    process.env.GRID_CONTROL_MAX_VALIDITY_SECONDS = '1800';
    mockDb([activeAsset]);
    mockDelivery(true);
    mockBroker(true);
    const { executeEnergyTransfer } = await import('./workflows/p2p-transfer-dispatch');

    const result = await executeEnergyTransfer({
      tradeId: 11,
      sellerId: 7,
      buyerId: 8,
      energyAmount: 2000,
    });

    expect(result.success).toBe(true);
    expect(dispatches[0]).toMatchObject({
      validForSeconds: 1800,
      setpointWatts: 4000, // 2000 Wh compressed into half an hour
    });
  });
});
