/**
 * Regression tests for the grid protocol boundary:
 *  - protocol services must be authenticated with a fresh HMAC signature
 *  - Modbus readings only reach settlement-relevant columns when their unit
 *    matches the column
 *  - charge point commands fail loudly when the protocol service is missing,
 *    rejects the command, or does not answer
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createHmac } from 'crypto';

const SECRET = 'k'.repeat(32);
const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

function sign(timestamp: string, body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(timestamp).update('.').update(body).digest('hex');
}

describe('verifyGridSignature', () => {
  beforeEach(() => {
    process.env.GRID_PROTOCOL_SHARED_SECRET = SECRET;
  });

  it('accepts a correctly signed body', async () => {
    const { verifyGridSignature } = await import('./services/grid-protocol-ingest');
    const body = Buffer.from('{"charge_point_id":"CP-1"}');
    const timestamp = '1700000000';
    expect(() =>
      verifyGridSignature(body, timestamp, sign(timestamp, body.toString()), 1700000000)
    ).not.toThrow();
  });

  it('rejects a body that was modified after signing', async () => {
    const { verifyGridSignature } = await import('./services/grid-protocol-ingest');
    const timestamp = '1700000000';
    const signature = sign(timestamp, '{"charge_point_id":"CP-1"}');
    expect(() =>
      verifyGridSignature(
        Buffer.from('{"charge_point_id":"CP-2"}'),
        timestamp,
        signature,
        1700000000
      )
    ).toThrow(/does not match/);
  });

  it('rejects replays outside the freshness window', async () => {
    const { verifyGridSignature, SIGNATURE_MAX_AGE_SECONDS } = await import(
      './services/grid-protocol-ingest'
    );
    const body = Buffer.from('{}');
    const timestamp = '1700000000';
    expect(() =>
      verifyGridSignature(
        body,
        timestamp,
        sign(timestamp, '{}'),
        1700000000 + SIGNATURE_MAX_AGE_SECONDS + 1
      )
    ).toThrow(/outside the accepted window/);
  });

  it('rejects unsigned requests', async () => {
    const { verifyGridSignature } = await import('./services/grid-protocol-ingest');
    expect(() => verifyGridSignature(Buffer.from('{}'), undefined, undefined)).toThrow(
      /missing x-grid-timestamp/
    );
  });

  it('refuses to run without a strong shared secret', async () => {
    process.env.GRID_PROTOCOL_SHARED_SECRET = 'too-short';
    const { verifyGridSignature } = await import('./services/grid-protocol-ingest');
    const timestamp = '1700000000';
    expect(() =>
      verifyGridSignature(Buffer.from('{}'), timestamp, sign(timestamp, '{}'), 1700000000)
    ).toThrow(/at least 32 characters/);
  });
});

describe('Modbus reading mapping', () => {
  it('maps registers to telemetry columns in the platform units', async () => {
    const { __testables } = await import('./services/grid-protocol-ingest');
    const mapped = __testables.mapReadings([
      { device_id: 'd1', name: 'active_power', value: -3500, unit: 'W', address: 1, timestamp_ms: 0 },
      { device_id: 'd1', name: 'total_energy', value: 12345, unit: 'Wh', address: 3, timestamp_ms: 0 },
      { device_id: 'd1', name: 'voltage_l1', value: 233.4, unit: 'V', address: 5, timestamp_ms: 0 },
      { device_id: 'd1', name: 'frequency', value: 49.98, unit: 'Hz', address: 7, timestamp_ms: 0 },
      { device_id: 'd1', name: 'battery_soc', value: 63.5, unit: '%', address: 9, timestamp_ms: 0 },
    ]);

    // Export/discharge stays negative: sign carries the direction of the flow.
    expect(mapped.power).toBe(-3500);
    expect(mapped.energy).toBe(12345);
    expect(mapped.voltage).toBe(233400);
    expect(mapped.frequency).toBe(49980);
    expect(mapped.stateOfCharge).toBe(6350);
  });

  it('does not coerce an unrelated register into a settlement column', async () => {
    const { __testables } = await import('./services/grid-protocol-ingest');
    const mapped = __testables.mapReadings([
      { device_id: 'd1', name: 'inverter_state', value: 3, unit: 'enum', address: 11, timestamp_ms: 0 },
      { device_id: 'd1', name: 'fan_speed', value: 900, unit: 'rpm', address: 12, timestamp_ms: 0 },
    ]);
    expect(mapped).toEqual({});
  });
});

describe('OCPP SoC samples', () => {
  it('stores state of charge as the plain percentage the sessions table expects', async () => {
    const { __testables } = await import('./services/grid-protocol-ingest');
    expect(__testables.toSocPercent(63.5)).toBe(64);
    expect(__testables.toSocPercent(0)).toBe(0);
    expect(__testables.toSocPercent(100)).toBe(100);
  });

  it('rejects a sample that is not a percentage', async () => {
    const { __testables } = await import('./services/grid-protocol-ingest');
    expect(() => __testables.toSocPercent(6350)).toThrow(/not a percentage/);
    expect(() => __testables.toSocPercent(-1)).toThrow(/not a percentage/);
  });
});

describe('grid command client', () => {
  beforeEach(() => {
    process.env.GRID_PROTOCOL_SHARED_SECRET = SECRET;
    process.env.GRID_PROTOCOL_SERVICE_URL = 'http://grid.internal:8080';
    process.env.GRID_PROTOCOL_TIMEOUT_MS = '5000';
  });

  it('refuses to command hardware when the service is not configured', async () => {
    delete process.env.GRID_PROTOCOL_SERVICE_URL;
    const { gridServiceConfig } = await import('./services/grid-commands');
    expect(() => gridServiceConfig()).toThrow(/GRID_PROTOCOL_SERVICE_URL/);
  });

  it('sends OCPP charging profiles with negative V2G limits intact', async () => {
    const { setChargingProfile } = await import('./services/grid-commands');
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const timestamp = String((init.headers as Record<string, string>)['x-grid-timestamp']);
      expect((init.headers as Record<string, string>)['x-grid-signature']).toBe(
        sign(timestamp, String(init.body))
      );
      expect(body.charge_point_id).toBe('CP-7');
      expect(body.request.csChargingProfiles.chargingSchedule.chargingRateUnit).toBe('W');
      expect(
        body.request.csChargingProfiles.chargingSchedule.chargingSchedulePeriod[1].limit
      ).toBe(-7000);
      return new Response(JSON.stringify({ status: 'Accepted' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await setChargingProfile({
      chargePointId: 'CP-7',
      connectorId: 1,
      chargingProfileId: 42,
      purpose: 'TxProfile',
      stackLevel: 1,
      periods: [
        { startPeriodSeconds: 0, limitWatts: 11000 },
        { startPeriodSeconds: 900, limitWatts: -7000 },
      ],
    });
    expect(result.status).toBe('Accepted');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('treats a rejected command as a failure, not a dispatch', async () => {
    const { setChargingProfile, GridCommandError } = await import('./services/grid-commands');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 'Rejected' }), { status: 409 }))
    );
    await expect(
      setChargingProfile({
        chargePointId: 'CP-7',
        connectorId: 1,
        chargingProfileId: 42,
        purpose: 'TxProfile',
        stackLevel: 1,
        periods: [{ startPeriodSeconds: 0, limitWatts: 11000 }],
      })
    ).rejects.toBeInstanceOf(GridCommandError);
  });

  it('reports an unreachable protocol service instead of returning success', async () => {
    const { remoteStopTransaction } = await import('./services/grid-commands');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    );
    await expect(
      remoteStopTransaction({ chargePointId: 'CP-7', transactionId: 5 })
    ).rejects.toThrow(/unreachable/);
  });

  it('rejects an empty charging profile before it reaches the charge point', async () => {
    const { setChargingProfile } = await import('./services/grid-commands');
    await expect(
      setChargingProfile({
        chargePointId: 'CP-7',
        connectorId: 1,
        chargingProfileId: 1,
        purpose: 'TxProfile',
        stackLevel: 1,
        periods: [],
      })
    ).rejects.toThrow(/at least one schedule period/);
  });
});
