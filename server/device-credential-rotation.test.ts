/**
 * Tests for `devices.rotateCredential`.
 *
 * A device credential is shown once and stored only as a hash, so re-registering
 * a device is refused: it would be the one way to make the platform reissue a
 * secret for hardware someone else may already hold. That left an operator who
 * lost a credential with no route at all, so rotation is now explicit — keyed by
 * the device identifier the operator knows, not the database row id.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

interface StoredDevice {
  id: number;
  assetId: number;
  deviceId: string;
  mqttClientId: string;
  mqttUsername: string;
  mqttPasswordHash: string;
}

const updates: Array<{ id: number; values: Record<string, unknown> }> = [];
const logs: Array<Record<string, unknown>> = [];

function mockDevicesDb(device: StoredDevice | undefined) {
  vi.doMock('./devices-db', () => ({
    getDeviceByDeviceId: async (deviceId: string) =>
      device && device.deviceId === deviceId ? device : undefined,
    updateDevice: async (id: number, values: Record<string, unknown>) => {
      updates.push({ id, values });
    },
    createDeviceLog: async (entry: Record<string, unknown>) => {
      logs.push(entry);
    },
  }));
}

async function rotate(device: StoredDevice | undefined, deviceId: string) {
  mockDevicesDb(device);
  const { devicesRouter } = await import('./routers/devices');
  const caller = devicesRouter.createCaller({ user: { id: 1, role: 'admin' } } as never);
  return caller.rotateCredential({ deviceId });
}

const EXISTING: StoredDevice = {
  id: 12,
  assetId: 3,
  deviceId: 'meter-abc',
  mqttClientId: 'device-3-1000',
  mqttUsername: 'meter-abc',
  mqttPasswordHash: 'old-hash',
};

beforeEach(() => {
  vi.doMock('./_core/mqtt', () => ({ mqttService: { publish: async () => undefined } }));
});

afterEach(() => {
  updates.length = 0;
  logs.length = 0;
  vi.resetModules();
  vi.doUnmock('./devices-db');
  vi.doUnmock('./_core/mqtt');
});

describe('devices.rotateCredential', () => {
  it('issues a new secret and replaces the stored hash', async () => {
    const result = await rotate(EXISTING, 'meter-abc');

    expect(result.deviceId).toBe(12);
    expect(result.mqttCredentials.username).toBe('meter-abc');
    expect(result.mqttCredentials.password).toMatch(/\S/);
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe(12);
    expect(updates[0].values.mqttPasswordHash).not.toBe('old-hash');
    expect(updates[0].values.mqttPasswordHash).not.toBe(result.mqttCredentials.password);
  });

  it('never returns the credential it replaced', async () => {
    const result = await rotate(EXISTING, 'meter-abc');

    expect(result.mqttCredentials.password).not.toBe('old-hash');
    expect(result.mqttCredentials.clientId).not.toBe(EXISTING.mqttClientId);
  });

  it('records the rotation for audit', async () => {
    await rotate(EXISTING, 'meter-abc');

    expect(logs).toHaveLength(1);
    expect(logs[0].deviceId).toBe(12);
    expect(String(logs[0].message)).toMatch(/rotated/i);
  });

  it('refuses to mint a credential for a device that is not registered', async () => {
    await expect(rotate(EXISTING, 'meter-unknown')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(updates).toHaveLength(0);
  });

  it('rotating twice yields different secrets', async () => {
    const first = await rotate(EXISTING, 'meter-abc');
    vi.resetModules();
    const second = await rotate(EXISTING, 'meter-abc');

    expect(second.mqttCredentials.password).not.toBe(first.mqttCredentials.password);
  });
});

describe('TRPCError shape', () => {
  it('is the error type the journey fixtures branch on', () => {
    expect(new TRPCError({ code: 'CONFLICT' }).code).toBe('CONFLICT');
  });
});
