/**
 * Trust-boundary tests for the two generic device-command paths.
 *
 *  - `iotDevices.*` was keyed purely on a caller-supplied assetId/deviceId, so any
 *    authenticated user could read another tenant's telemetry or command another
 *    tenant's hardware. Ownership is now proven for every asset-keyed call.
 *  - `devices.sendCommand` could publish a bare `set_power`, which bypasses the
 *    bounded control path and leaves a setpoint no sweeper ever retires.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { assets, devices } from '../drizzle/schema';

interface DbRows {
  assets: Array<{ userId: number }>;
  devices: Array<{ assetId: number; enabled: boolean }>;
}

/**
 * Minimal stand-in for the drizzle select chain these routers use. The projection
 * keys identify the query: ownership reads `userId`, device lookup reads
 * `assetId`/`enabled`. (Table identity cannot be used here — the router imports
 * the schema through a reset module registry.)
 */
function mockDb(rows: DbRows) {
  const db = {
    select: (fields?: Record<string, unknown>) => {
      const selected = fields ? Object.keys(fields) : [];
      const result = selected.includes('userId')
        ? rows.assets
        : selected.includes('assetId')
          ? rows.devices
          : []; // unprojected selects are the telemetry reads
      // Every stage is chainable and awaitable: these routers variously end on
      // .limit(), .orderBy() or the .where() itself.
      const stage: Record<string, unknown> = {
        where: () => stage,
        orderBy: () => stage,
        limit: () => stage,
        then: (resolve: (rows: unknown) => void) => resolve(result),
      };
      return { from: () => stage };
    },
  };
  vi.doMock('./db', () => ({ getDb: async () => db }));
}

const published: Array<{ deviceId: string; command: string }> = [];

function mockBroker(connected = true) {
  vi.doMock('./integration/mqtt-broker', () => ({
    mqttBrokerService: {
      isConnected: () => connected,
      publishCommand: async (deviceId: string, command: string) => {
        published.push({ deviceId, command });
      },
    },
  }));
}

function ctxFor(userId: number, role: 'user' | 'admin') {
  return { user: { id: userId, role } } as never;
}

afterEach(() => {
  published.length = 0;
  vi.resetModules();
  vi.doUnmock('./db');
  vi.doUnmock('./integration/mqtt-broker');
});

describe('iotDevices telemetry tenancy', () => {
  it('refuses telemetry for an asset the caller does not own', async () => {
    mockDb({ assets: [{ userId: 7 }], devices: [] });
    mockBroker();
    const { iotDevicesRouter } = await import('./routers/iot-devices');
    const caller = iotDevicesRouter.createCaller(ctxFor(8, 'user'));

    await expect(caller.getLatestTelemetry({ assetId: 1, limit: 10 })).rejects.toThrow(
      /do not own this asset/
    );
    await expect(caller.getTelemetryStats({ assetId: 1, hours: 24 })).rejects.toThrow(
      /do not own this asset/
    );
    await expect(caller.getDeviceHealth({ assetId: 1 })).rejects.toThrow(/do not own this asset/);
  });

  it('serves telemetry to the owner', async () => {
    mockDb({ assets: [{ userId: 7 }], devices: [] });
    mockBroker();
    const { iotDevicesRouter } = await import('./routers/iot-devices');
    const caller = iotDevicesRouter.createCaller(ctxFor(7, 'user'));

    await expect(caller.getLatestTelemetry({ assetId: 1, limit: 10 })).resolves.toEqual([]);
  });

  it('distinguishes a missing asset from one owned by someone else', async () => {
    mockDb({ assets: [], devices: [] });
    mockBroker();
    const { iotDevicesRouter } = await import('./routers/iot-devices');
    const caller = iotDevicesRouter.createCaller(ctxFor(7, 'user'));

    await expect(caller.getLatestTelemetry({ assetId: 99, limit: 10 })).rejects.toThrow(
      /Asset not found/
    );
  });
});

describe('iotDevices.sendCommand', () => {
  it('will not command a device belonging to another tenant', async () => {
    mockDb({ assets: [{ userId: 7 }], devices: [{ assetId: 1, enabled: true }] });
    mockBroker();
    const { iotDevicesRouter } = await import('./routers/iot-devices');
    const caller = iotDevicesRouter.createCaller(ctxFor(8, 'user'));

    await expect(caller.sendCommand({ deviceId: 'DEV-1', command: 'stop' })).rejects.toThrow(
      /do not own this asset/
    );
    expect(published).toEqual([]);
  });

  it('refuses an unregistered device id instead of publishing to it', async () => {
    mockDb({ assets: [{ userId: 7 }], devices: [] });
    mockBroker();
    const { iotDevicesRouter } = await import('./routers/iot-devices');
    const caller = iotDevicesRouter.createCaller(ctxFor(7, 'user'));

    await expect(caller.sendCommand({ deviceId: 'GHOST', command: 'stop' })).rejects.toThrow(
      /not registered/
    );
    expect(published).toEqual([]);
  });

  it('reports a broker publish as unconfirmed by the device, not as success', async () => {
    mockDb({ assets: [{ userId: 7 }], devices: [{ assetId: 1, enabled: true }] });
    mockBroker();
    const { iotDevicesRouter } = await import('./routers/iot-devices');
    const caller = iotDevicesRouter.createCaller(ctxFor(7, 'user'));

    const result = await caller.sendCommand({ deviceId: 'DEV-1', command: 'stop' });
    expect(result).toMatchObject({ published: true, delivery: 'broker_queued' });
    expect(result.message).toMatch(/unconfirmed/i);
    expect(published).toEqual([{ deviceId: 'DEV-1', command: 'stop' }]);
  });

  it('fails loudly when the broker is down rather than claiming the command went out', async () => {
    mockDb({ assets: [{ userId: 7 }], devices: [{ assetId: 1, enabled: true }] });
    mockBroker(false);
    const { iotDevicesRouter } = await import('./routers/iot-devices');
    const caller = iotDevicesRouter.createCaller(ctxFor(7, 'user'));

    await expect(caller.sendCommand({ deviceId: 'DEV-1', command: 'stop' })).rejects.toThrow(
      /broker not connected/
    );
  });

  it('refuses a disabled device', async () => {
    mockDb({ assets: [{ userId: 7 }], devices: [{ assetId: 1, enabled: false }] });
    mockBroker();
    const { iotDevicesRouter } = await import('./routers/iot-devices');
    const caller = iotDevicesRouter.createCaller(ctxFor(7, 'user'));

    await expect(caller.sendCommand({ deviceId: 'DEV-1', command: 'stop' })).rejects.toThrow(
      /disabled/
    );
    expect(published).toEqual([]);
  });
});

describe('devices.sendCommand setpoint guard', () => {
  it('rejects power-affecting commands so they cannot skip the bounded control path', async () => {
    mockDb({ assets: [{ userId: 7 }], devices: [{ assetId: 1, enabled: true }] });
    mockBroker();
    const { devicesRouter } = await import('./routers/devices');
    const caller = devicesRouter.createCaller(ctxFor(1, 'admin'));

    for (const command of ['set_power', 'discharge', 'curtail', 'clear_setpoint']) {
      await expect(caller.sendCommand({ deviceId: 1, command })).rejects.toThrow(
        /must be dispatched through controlWindows/
      );
    }
    expect(published).toEqual([]);
  });
});

describe('devices schema', () => {
  it('keys devices to an owning asset, which is what ownership checks rely on', () => {
    expect(devices.assetId).toBeDefined();
    expect(assets.userId).toBeDefined();
  });
});
