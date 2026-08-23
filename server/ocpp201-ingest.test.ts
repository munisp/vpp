/**
 * OCPP 2.0.1 ingest tests.
 *
 * The invariants under test are the ones with money attached: the station owns
 * transaction identity, energy comes from the station's own registers, a
 * replayed event is not applied twice, and a buffered offline event is not read
 * as the station's current state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chargingSessions, chargingStations } from '../drizzle/nextgen-vpp-schema';
import { ocppIdTags } from '../drizzle/grid-protocol-schema';

type Row = Record<string, unknown>;

const rows = new Map<unknown, Row[]>();
const inserts: Array<{ table: unknown; values: Row }> = [];
const updates: Array<{ table: unknown; values: Row }> = [];

vi.mock('./db', () => ({
  getDb: vi.fn(async () => ({
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({ limit: async () => rows.get(table) ?? [] }),
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: Row) => {
        inserts.push({ table, values });
        rows.set(table, [...(rows.get(table) ?? []), values]);
      },
    }),
    update: (table: unknown) => ({
      set: (values: Row) => ({
        where: async () => {
          updates.push({ table, values });
        },
      }),
    }),
  })),
}));

const STATION = {
  id: 11,
  stationId: 'CS-1',
  status: 'available',
  v2gCapable: false,
  metadata: null,
};

const TAG = {
  id: 5,
  idTag: 'TOKEN',
  status: 'active',
  expiryDate: null,
  evId: 3,
  userId: 7,
  parentIdTag: null,
};

beforeEach(() => {
  rows.clear();
  inserts.length = 0;
  updates.length = 0;
  rows.set(chargingStations, [{ ...STATION }]);
  rows.set(ocppIdTags, [{ ...TAG }]);
  rows.set(chargingSessions, []);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function register(value: number, unit = 'Wh', multiplier?: number) {
  return [
    {
      timestamp: '2026-01-01T00:00:00Z',
      sampledValue: [
        {
          value,
          measurand: 'Energy.Active.Import.Register',
          unitOfMeasure: { unit, multiplier },
        },
      ],
    },
  ];
}

function startedEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventType: 'Started' as const,
    timestamp: '2026-01-01T00:00:00Z',
    triggerReason: 'Authorized',
    seqNo: 0,
    transactionInfo: { transactionId: 'station-tx-7' },
    evse: { id: 1, connectorId: 1 },
    idToken: { idToken: 'TOKEN', type: 'ISO14443' },
    meterValue: register(1_000),
    ...overrides,
  };
}

function openSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 91,
    stationId: STATION.id,
    sessionId: '',
    endTime: null,
    metadata: JSON.stringify({
      stationTransactionId: 'station-tx-7',
      meterStartWh: 1_000,
      lastSeqNo: 0,
    }),
    ...overrides,
  };
}

describe('transaction identity', () => {
  it('maps a station transaction id into a session key that fits the column', async () => {
    const { transactionSessionKey } = await import('./services/ocpp201-ingest');
    const key = transactionSessionKey('CS-1', 'station-tx-7');
    expect(key.length).toBeLessThanOrEqual(64);
    expect(transactionSessionKey('CS-1', 'station-tx-7')).toBe(key);
    // Two stations can generate the same transaction id; they are not the
    // same session.
    expect(transactionSessionKey('CS-2', 'station-tx-7')).not.toBe(key);
    expect(transactionSessionKey('CS-1', 'station-tx-8')).not.toBe(key);
  });

  it('stores the station transaction id verbatim rather than inventing one', async () => {
    const { handleTransactionEvent201, transactionSessionKey } = await import(
      './services/ocpp201-ingest'
    );
    await handleTransactionEvent201('CS-1', startedEvent());

    const inserted = inserts.find(entry => entry.table === chargingSessions);
    expect(inserted).toBeDefined();
    const metadata = JSON.parse(String(inserted?.values.metadata));
    expect(metadata.stationTransactionId).toBe('station-tx-7');
    expect(inserted?.values.sessionId).toBe(transactionSessionKey('CS-1', 'station-tx-7'));
    expect(metadata.meterStartWh).toBe(1_000);
    expect(inserted?.values.energyDeliveredWh).toBe(0);
  });
});

describe('starting a transaction', () => {
  it('refuses a transaction with no id token, which cannot be billed', async () => {
    const { handleTransactionEvent201 } = await import('./services/ocpp201-ingest');
    await expect(
      handleTransactionEvent201('CS-1', startedEvent({ idToken: undefined }))
    ).rejects.toThrow(/cannot be attributed to a customer/);
    expect(inserts).toHaveLength(0);
  });

  it('refuses an unknown token instead of opening a session for it', async () => {
    rows.set(ocppIdTags, []);
    const { handleTransactionEvent201 } = await import('./services/ocpp201-ingest');
    await expect(handleTransactionEvent201('CS-1', startedEvent())).rejects.toThrow(/Unknown/);
    expect(inserts).toHaveLength(0);
  });

  it('refuses a token with no vehicle assigned', async () => {
    rows.set(ocppIdTags, [{ ...TAG, evId: null }]);
    const { handleTransactionEvent201 } = await import('./services/ocpp201-ingest');
    await expect(handleTransactionEvent201('CS-1', startedEvent())).rejects.toThrow(
      /no vehicle assigned/
    );
  });

  it('refuses an unregistered station', async () => {
    rows.set(chargingStations, []);
    const { handleTransactionEvent201 } = await import('./services/ocpp201-ingest');
    await expect(handleTransactionEvent201('CS-9', startedEvent())).rejects.toThrow(
      /not registered/
    );
  });

  it('does not open a second session for a replayed Started event', async () => {
    const { handleTransactionEvent201, transactionSessionKey } = await import(
      './services/ocpp201-ingest'
    );
    rows.set(chargingSessions, [
      openSession({ sessionId: transactionSessionKey('CS-1', 'station-tx-7') }),
    ]);
    const result = await handleTransactionEvent201('CS-1', startedEvent());
    expect(result.idTokenInfo?.status).toBe('Accepted');
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });
});

describe('updating a transaction', () => {
  beforeEach(() => {
    rows.set(chargingSessions, [openSession()]);
  });

  it('refuses an event for a transaction that never started here', async () => {
    rows.set(chargingSessions, []);
    const { handleTransactionEvent201 } = await import('./services/ocpp201-ingest');
    await expect(
      handleTransactionEvent201('CS-1', {
        ...startedEvent(),
        eventType: 'Updated',
        seqNo: 1,
      })
    ).rejects.toThrow(/the Started event was never received/);
    expect(inserts).toHaveLength(0);
  });

  it('books the delta against the station meter start', async () => {
    const { handleTransactionEvent201 } = await import('./services/ocpp201-ingest');
    await handleTransactionEvent201('CS-1', {
      ...startedEvent(),
      eventType: 'Updated',
      seqNo: 1,
      meterValue: register(4_500),
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].values.energyDeliveredWh).toBe(3_500);
    expect(updates[0].values.energyExportedWh).toBe(0);
  });

  it('reads the unit multiplier the station sent', async () => {
    const { handleTransactionEvent201 } = await import('./services/ocpp201-ingest');
    // 4.5 kWh reported as 4500 Wh × 10⁰ and as 4.5 kWh must book the same energy.
    await handleTransactionEvent201('CS-1', {
      ...startedEvent(),
      eventType: 'Updated',
      seqNo: 1,
      meterValue: register(4.5, 'kWh'),
    });
    expect(updates[0].values.energyDeliveredWh).toBe(3_500);

    updates.length = 0;
    await handleTransactionEvent201('CS-1', {
      ...startedEvent(),
      eventType: 'Updated',
      seqNo: 2,
      meterValue: register(45, 'Wh', 2),
    });
    expect(updates[0].values.energyDeliveredWh).toBe(3_500);
  });

  it('books a negative delta as exported energy', async () => {
    const { handleTransactionEvent201 } = await import('./services/ocpp201-ingest');
    await handleTransactionEvent201('CS-1', {
      ...startedEvent(),
      eventType: 'Updated',
      seqNo: 1,
      meterValue: register(400),
    });
    expect(updates[0].values.energyDeliveredWh).toBe(0);
    expect(updates[0].values.energyExportedWh).toBe(600);
  });

  it('does not apply an event the station already delivered', async () => {
    const { handleTransactionEvent201 } = await import('./services/ocpp201-ingest');
    await handleTransactionEvent201('CS-1', {
      ...startedEvent(),
      eventType: 'Updated',
      seqNo: 0,
      meterValue: register(9_000),
    });
    expect(updates).toHaveLength(0);
  });

  it('accepts a buffered offline event as energy but not as the live state', async () => {
    const { handleTransactionEvent201 } = await import('./services/ocpp201-ingest');
    await handleTransactionEvent201('CS-1', {
      ...startedEvent(),
      eventType: 'Updated',
      seqNo: 3,
      offline: true,
      transactionInfo: { transactionId: 'station-tx-7', chargingState: 'Charging' },
      meterValue: register(2_000),
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].values.energyDeliveredWh).toBe(1_000);
    expect(updates[0].values.status).toBeUndefined();
    expect(JSON.parse(String(updates[0].values.metadata)).lastEventOffline).toBe(true);
  });

  it('closes the session on Ended and records the stop reason', async () => {
    const { handleTransactionEvent201 } = await import('./services/ocpp201-ingest');
    await handleTransactionEvent201('CS-1', {
      ...startedEvent(),
      eventType: 'Ended',
      seqNo: 9,
      triggerReason: 'EVCommunicationLost',
      transactionInfo: { transactionId: 'station-tx-7', stoppedReason: 'EVDisconnected' },
      meterValue: register(6_000),
    });
    expect(updates[0].values.status).toBe('completed');
    expect(updates[0].values.endTime).toBeInstanceOf(Date);
    expect(updates[0].values.energyDeliveredWh).toBe(5_000);
    expect(JSON.parse(String(updates[0].values.metadata)).stoppedReason).toBe('EVDisconnected');
  });

  it('forwards a signed meter reading without claiming it was verified', async () => {
    const { handleTransactionEvent201 } = await import('./services/ocpp201-ingest');
    await handleTransactionEvent201('CS-1', {
      ...startedEvent(),
      eventType: 'Updated',
      seqNo: 1,
      meterValue: [
        {
          timestamp: '2026-01-01T00:05:00Z',
          sampledValue: [
            {
              value: 2_000,
              measurand: 'Energy.Active.Import.Register',
              unitOfMeasure: { unit: 'Wh' },
              signedMeterValue: {
                signedMeterData: 'base64data',
                signingMethod: 'ECDSA192SHA256',
                encodingMethod: 'DLMS Message',
              },
            },
          ],
        },
      ],
    });
    const metadata = JSON.parse(String(updates[0].values.metadata));
    expect(metadata.signedMeterValuesUnverified).toEqual([
      {
        timestamp: '2026-01-01T00:05:00Z',
        signedMeterData: 'base64data',
        signingMethod: 'ECDSA192SHA256',
      },
    ]);
  });

  it('rejects an out-of-range state of charge instead of storing it', async () => {
    const { handleTransactionEvent201 } = await import('./services/ocpp201-ingest');
    await expect(
      handleTransactionEvent201('CS-1', {
        ...startedEvent(),
        eventType: 'Updated',
        seqNo: 1,
        meterValue: [
          {
            timestamp: '2026-01-01T00:05:00Z',
            sampledValue: [{ value: 6_300, measurand: 'SoC' }],
          },
        ],
      })
    ).rejects.toThrow(/is not a percentage/);
    expect(updates).toHaveLength(0);
  });
});

describe('authorization and unattributable energy', () => {
  it('answers Unknown for a token the platform has never seen', async () => {
    rows.set(ocppIdTags, []);
    const { authorizeIdToken201 } = await import('./services/ocpp201-ingest');
    expect(await authorizeIdToken201({ idToken: 'NOPE', type: 'ISO14443' })).toEqual({
      status: 'Unknown',
    });
  });

  it('reports a blocked token as blocked', async () => {
    rows.set(ocppIdTags, [{ ...TAG, status: 'blocked' }]);
    const { authorizeIdToken201 } = await import('./services/ocpp201-ingest');
    expect((await authorizeIdToken201({ idToken: 'TOKEN', type: 'ISO14443' })).status).toBe(
      'Blocked'
    );
  });

  it('reports an expired token as expired', async () => {
    rows.set(ocppIdTags, [{ ...TAG, expiryDate: new Date(Date.now() - 1_000) }]);
    const { authorizeIdToken201 } = await import('./services/ocpp201-ingest');
    expect((await authorizeIdToken201({ idToken: 'TOKEN', type: 'ISO14443' })).status).toBe(
      'Expired'
    );
  });

  it('refuses non-transaction meter values rather than booking unattributed energy', async () => {
    const { handleMeterValues201 } = await import('./services/ocpp201-ingest');
    await expect(
      handleMeterValues201('CS-1', { evseId: 1, meterValue: register(500) })
    ).rejects.toThrow(/carries no transaction/);
    expect(updates).toHaveLength(0);
  });
});

describe('station lifecycle', () => {
  it('records the negotiated protocol version on boot', async () => {
    const { handleBootNotification201 } = await import('./services/ocpp201-ingest');
    const resp = await handleBootNotification201('CS-1', {
      reason: 'PowerUp',
      chargingStation: { vendorName: 'vendor', model: 'model' },
    });
    expect(resp.status).toBe('Accepted');
    expect(updates[0].values.ocppVersion).toBe('2.0.1');
  });

  it('keeps the reporting EVSE and connector on a status notification', async () => {
    const { handleStatusNotification201 } = await import('./services/ocpp201-ingest');
    await handleStatusNotification201('CS-1', {
      timestamp: '2026-01-01T00:00:00Z',
      connectorStatus: 'Charging',
      evseId: 2,
      connectorId: 1,
    });
    expect(updates[0].values.status).toBe('charging');
    const metadata = JSON.parse(String(updates[0].values.metadata));
    expect(metadata.lastConnectorStatus).toMatchObject({ evseId: 2, connectorId: 1 });
  });

  it('rejects a connector status it cannot map', async () => {
    const { handleStatusNotification201 } = await import('./services/ocpp201-ingest');
    await expect(
      handleStatusNotification201('CS-1', {
        timestamp: '2026-01-01T00:00:00Z',
        connectorStatus: 'Levitating',
        evseId: 1,
        connectorId: 1,
      })
    ).rejects.toThrow(/unknown OCPP 2.0.1 connector status/);
  });
});
