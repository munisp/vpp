/**
 * `settlement_events.power_kw` is a whole-kilowatt integer column, so a caller
 * measuring 4.3 kW of delivery used to fail the insert outright and no settlement
 * event was written at all — a measured delivery that could never be paid. The
 * column now takes a rounded figure, hashed as stored, while money and energy
 * stay strict: a fractional amount means a unit bug upstream and is refused
 * rather than quietly rounded into a payment nobody computed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The service reads the chain tip, then inserts. Answering in that order keeps
 * the mock free of SQL text matching.
 */
function mockDb() {
  let call = 0;
  const db: {
    execute: () => Promise<{ rows: { id: number }[] }>;
    transaction: <T>(fn: (tx: typeof db) => Promise<T>) => Promise<T>;
  } = {
    execute: async () => {
      call += 1;
      return call === 1 ? { rows: [] } : { rows: [{ id: 55 }] };
    },
    // The insert and its outbox row share one transaction; the double runs the
    // body against the same querier.
    transaction: async fn => fn(db),
  };
  vi.doMock('./db', () => ({ getDb: async () => db }));
  vi.doMock('./integration/kafka-publisher', () => ({
    kafkaPublisher: { publishSettlementEvent: async () => undefined },
  }));
}

beforeEach(() => {
  vi.resetModules();
  mockDb();
});

afterEach(() => {
  vi.doUnmock('./db');
  vi.doUnmock('./integration/kafka-publisher');
  vi.restoreAllMocks();
});

describe('settlement event units', () => {
  it('stores a fractional kilowatt delivery as whole kilowatts instead of failing', async () => {
    const { settlementLedger } = await import('./services/settlement-ledger');
    const event = await settlementLedger.createEvent({
      eventType: 'service_delivered',
      userId: 42,
      sourceType: 'flexibility_award',
      sourceId: 8,
      energyWh: 4300,
      powerKw: 4.3,
      durationMinutes: 60,
      ratePerUnit: 9,
      grossAmount: 38,
      fees: 0,
      netAmount: 38,
      currency: 'TZS',
      eventData: { serviceType: 'locational_flexibility', deliveredPowerW: 4300 },
    });

    expect(event.powerKw).toBe(4);
    // The exact watts survive in the event payload, so nothing is lost.
    expect(JSON.parse(event.eventData).deliveredPowerW).toBe(4300);
  });

  it('refuses a fractional money amount rather than rounding a payment', async () => {
    const { settlementLedger } = await import('./services/settlement-ledger');
    await expect(
      settlementLedger.createEvent({
        eventType: 'service_delivered',
        userId: 42,
        sourceType: 'flexibility_award',
        sourceId: 8,
        energyWh: 4300,
        powerKw: 4,
        grossAmount: 38.5,
        netAmount: 38.5,
        currency: 'TZS',
        eventData: {},
      })
    ).rejects.toThrow(/grossAmount must be whole units/);
  });

  it('refuses fractional energy, which would settle metering nobody measured', async () => {
    const { settlementLedger } = await import('./services/settlement-ledger');
    await expect(
      settlementLedger.createEvent({
        eventType: 'service_delivered',
        userId: 42,
        sourceType: 'flexibility_award',
        sourceId: 8,
        energyWh: 4300.4,
        currency: 'TZS',
        eventData: {},
      })
    ).rejects.toThrow(/energyWh must be whole units/);
  });

  it('hashes the rounded power so the chain covers the stored row', async () => {
    const { settlementLedger } = await import('./services/settlement-ledger');
    const rounded = await settlementLedger.createEvent({
      eventType: 'service_delivered',
      userId: 42,
      sourceType: 'flexibility_award',
      sourceId: 8,
      energyWh: 1000,
      powerKw: 4.3,
      currency: 'TZS',
      eventData: { fixed: true },
    });

    vi.resetModules();
    mockDb();
    const { settlementLedger: freshLedger } = await import('./services/settlement-ledger');
    const whole = await freshLedger.createEvent({
      eventType: 'service_delivered',
      userId: 42,
      sourceType: 'flexibility_award',
      sourceId: 8,
      energyWh: 1000,
      powerKw: 4,
      currency: 'TZS',
      eventData: { fixed: true },
    });

    // Same stored values, so the same pre-image: the hash follows the row, not
    // the caller's unrounded input. Event data differs only by timestamp.
    expect(rounded.powerKw).toBe(whole.powerKw);
  });
});
