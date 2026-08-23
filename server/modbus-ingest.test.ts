/**
 * Regression tests for Modbus ingest persistence.
 *
 * End-to-end testing of the degraded-operation layer found the ingest handler
 * collapsing every reading in a request into a single telemetry row at the
 * newest timestamp, while answering with the number of registers received. A
 * poller replaying a spooled outage therefore reported success for history the
 * platform had thrown away — precisely the silent-success class this platform
 * exists to avoid. One instant now stores one row, and the response counts what
 * was written.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

interface InsertedRow {
  assetId: number;
  timestamp: Date;
  power?: number;
  metadata: string;
}

function mockDb(device: { id: number; assetId: number; enabled: boolean } | null) {
  const inserted: InsertedRow[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (device ? [device] : []) }),
      }),
    }),
    insert: () => ({
      values: async (row: InsertedRow) => {
        inserted.push(row);
      },
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  };
  vi.doMock('./db', () => ({ getDb: async () => db }));
  return inserted;
}

function mockObservations() {
  const observed: string[] = [];
  vi.doMock('./services/degraded-operation', async () => {
    const actual = await vi.importActual<typeof import('./services/degraded-operation')>(
      './services/degraded-operation'
    );
    return {
      ...actual,
      recordObservation: async (input: { dependency: string }) => {
        observed.push(input.dependency);
        return { observationId: 1, outageOpened: false, outageClosed: false };
      },
    };
  });
  return observed;
}

function reading(overrides: {
  device_id?: string;
  value: number;
  timestamp_ms: number;
}) {
  return {
    device_id: overrides.device_id ?? 'meter-1',
    name: 'active_power',
    unit: 'W',
    address: 1,
    value: overrides.value,
    timestamp_ms: overrides.timestamp_ms,
  };
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('./db');
  vi.doUnmock('./services/degraded-operation');
});

describe('handleModbusReadings', () => {
  it('stores one row per instant instead of keeping only the newest value', async () => {
    const inserted = mockDb({ id: 3, assetId: 9, enabled: true });
    mockObservations();
    const { handleModbusReadings } = await import('./services/grid-protocol-ingest');

    const result = await handleModbusReadings([
      reading({ value: 111, timestamp_ms: 1_700_000_000_000 }),
      reading({ value: 222, timestamp_ms: 1_700_000_060_000 }),
      reading({ value: 333, timestamp_ms: 1_700_000_120_000 }),
    ]);

    expect(result).toEqual({ samples: 3, readings: 3 });
    expect(inserted.map(row => row.power)).toEqual([111, 222, 333]);
    // Oldest first: a replayed spool is stored as the history it carries.
    expect(inserted.map(row => row.timestamp.getTime())).toEqual([
      1_700_000_000_000, 1_700_000_060_000, 1_700_000_120_000,
    ]);
  });

  it('groups the registers read at the same instant into one sample', async () => {
    const inserted = mockDb({ id: 3, assetId: 9, enabled: true });
    mockObservations();
    const { handleModbusReadings } = await import('./services/grid-protocol-ingest');

    const result = await handleModbusReadings([
      { ...reading({ value: 400, timestamp_ms: 1_700_000_000_000 }) },
      {
        device_id: 'meter-1',
        name: 'voltage_l1',
        unit: 'V',
        address: 5,
        value: 231,
        timestamp_ms: 1_700_000_000_000,
      },
    ]);

    // Two registers, one measurement: the response says one row was written.
    expect(result).toEqual({ samples: 1, readings: 2 });
    expect(inserted).toHaveLength(1);
    expect(JSON.parse(inserted[0].metadata).registers).toHaveLength(2);
  });

  it('refuses a whole batch whose device is not registered rather than reporting stored rows', async () => {
    const inserted = mockDb(null);
    mockObservations();
    const { handleModbusReadings, GridProtocolError } = await import(
      './services/grid-protocol-ingest'
    );

    await expect(
      handleModbusReadings([reading({ value: 1, timestamp_ms: 1_700_000_000_000 })])
    ).rejects.toBeInstanceOf(GridProtocolError);
    expect(inserted).toHaveLength(0);
  });

  it('reports nothing stored for an empty request', async () => {
    mockDb({ id: 3, assetId: 9, enabled: true });
    mockObservations();
    const { handleModbusReadings } = await import('./services/grid-protocol-ingest');
    expect(await handleModbusReadings([])).toEqual({ samples: 0, readings: 0 });
  });
});
