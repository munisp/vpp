/**
 * A P2P trade used to be its own settlement evidence: a metadata status said it
 * was paid, delivery was assumed from the dispatch, and reconciliation compared
 * the trade with itself. These tests pin the evidence rules on the settlement
 * record:
 *  - delivery is measured from telemetry, and thin coverage is `unverified`
 *    rather than either a delivery or a proven failure to deliver
 *  - a paid trade that delivered nothing becomes `unresolved`, not a quiet failure
 *  - an open transfer window is refused instead of measured as a whole delivery
 *  - reconciliation reads the payment row, and a mismatch on amount, currency,
 *    status, trade link or provider reference is a mismatch, never a match
 *  - `matched` requires the seller payout, which the platform cannot make, so
 *    an otherwise clean trade reconciles as pending rather than complete
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { getTableName, type Table } from 'drizzle-orm';

type Row = Record<string, unknown>;

interface Store {
  settlement: Row | null;
  trade: Row | null;
  payment: Row | null;
  telemetry: Row[];
}

const updates: Array<{ table: unknown; values: Row }> = [];

function mockDb(store: Store) {
  // Each test re-imports the service through vi.resetModules, so the schema
  // objects it holds are not the ones this file imported: tables are matched by
  // name rather than by reference.
  const rowsFor = (table: Table): Row[] => {
    switch (getTableName(table)) {
      case 'p2p_settlements':
        return store.settlement ? [store.settlement] : [];
      case 'trades':
        return store.trade ? [store.trade] : [];
      case 'payments':
        return store.payment ? [store.payment] : [];
      case 'telemetry':
        return store.telemetry;
      default:
        return [];
    }
  };

  const db = {
    select: () => ({
      from: (table: Table) => {
        const result = {
          where: () => ({
            limit: async () => rowsFor(table),
            orderBy: async () => rowsFor(table),
            then: (resolve: (rows: Row[]) => unknown) => Promise.resolve(rowsFor(table)).then(resolve),
          }),
        };
        return result;
      },
    }),
    update: (table: Table) => ({
      set: (values: Row) => ({
        where: async () => {
          updates.push({ table, values });
        },
      }),
    }),
  };
  vi.doMock('./db', () => ({ getDb: async () => db }));
}

const past = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

function settlementRow(overrides: Row = {}): Row {
  return {
    id: 1,
    buyTradeId: 100,
    sellTradeId: 101,
    buyerId: 7,
    sellerId: 8,
    energyWh: 2000,
    amountCents: 5000,
    currency: 'TZS',
    buyerPaymentId: 55,
    buyerPaymentReference: 'PROVIDER-REF-1',
    buyerPaidAt: past(120),
    delivery: 'unmeasured',
    deliveredEnergyWh: null,
    deliverySamples: null,
    sellerPayout: 'unavailable_no_provider',
    state: 'buyer_paid_seller_unpaid',
    reconciliation: 'pending',
    ...overrides,
  };
}

/** A dispatched seller leg: asset 5, a window that has already closed. */
function dispatchedSellTrade(windowMinutesAgo = 90, windowMinutes = 60): Row {
  const validFrom = past(windowMinutesAgo);
  return {
    id: 101,
    metadata: JSON.stringify({
      assetId: 5,
      validFrom: validFrom.toISOString(),
      validTo: new Date(validFrom.getTime() + windowMinutes * 60_000).toISOString(),
      transferStatus: 'broker_queued',
    }),
  };
}

/** Evenly spaced samples at a constant power, covering the whole window. */
function samplesAt(watts: number, windowMinutesAgo = 90, windowMinutes = 60, count = 7): Row[] {
  const start = past(windowMinutesAgo).getTime();
  const step = (windowMinutes * 60_000) / (count - 1);
  return Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(start + i * step),
    power: watts,
  }));
}

beforeEach(() => {
  updates.length = 0;
});

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('./db');
});

describe('measureTradeDelivery', () => {
  it('measures the energy the seller\'s asset actually exported', async () => {
    mockDb({
      settlement: settlementRow(),
      trade: dispatchedSellTrade(),
      payment: null,
      // 2000 W held for an hour delivers the 2000 Wh traded.
      telemetry: samplesAt(2000),
    });
    const { measureTradeDelivery } = await import('./services/p2p-settlement');

    const result = await measureTradeDelivery(100);

    expect(result.delivery).toBe('measured');
    expect(result.deliveredEnergyWh).toBe(2000);
    expect(result.samples).toBe(7);
    expect(updates.at(-1)?.values).toMatchObject({
      delivery: 'measured',
      deliveredEnergyWh: 2000,
      state: 'delivery_evidenced',
    });
  });

  it('records too little telemetry as unverified rather than as no delivery', async () => {
    mockDb({
      settlement: settlementRow(),
      trade: dispatchedSellTrade(),
      payment: null,
      telemetry: [{ timestamp: past(80), power: 2000 }],
    });
    const { measureTradeDelivery } = await import('./services/p2p-settlement');

    const result = await measureTradeDelivery(100);

    expect(result.delivery).toBe('unverified');
    expect(result.deliveredEnergyWh).toBeNull();
    expect(result.note).toContain('too little telemetry');
    // Neither paid as delivered nor advanced past the payment state.
    expect(updates.at(-1)?.values).toMatchObject({
      delivery: 'unverified',
      deliveredEnergyWh: null,
      deliveryMeasuredAt: null,
      state: 'buyer_paid_seller_unpaid',
    });
  });

  it('never counts a reported reading as power when the value is missing', async () => {
    mockDb({
      settlement: settlementRow(),
      trade: dispatchedSellTrade(),
      payment: null,
      telemetry: [
        { timestamp: past(90), power: null },
        { timestamp: past(60), power: null },
        { timestamp: past(45), power: null },
      ],
    });
    const { measureTradeDelivery } = await import('./services/p2p-settlement');

    const result = await measureTradeDelivery(100);

    expect(result.samples).toBe(0);
    expect(result.delivery).toBe('unverified');
  });

  it('marks a paid trade that delivered nothing unresolved', async () => {
    mockDb({
      settlement: settlementRow(),
      trade: dispatchedSellTrade(),
      payment: null,
      telemetry: samplesAt(0),
    });
    const { measureTradeDelivery } = await import('./services/p2p-settlement');

    const result = await measureTradeDelivery(100);

    expect(result.delivery).toBe('not_delivered');
    expect(result.deliveredEnergyWh).toBe(0);
    expect(result.note).toContain('refund');
    expect(updates.at(-1)?.values).toMatchObject({ state: 'unresolved' });
  });

  it('does not count import as delivered export', async () => {
    mockDb({
      settlement: settlementRow(),
      trade: dispatchedSellTrade(),
      payment: null,
      telemetry: samplesAt(-2000),
    });
    const { measureTradeDelivery } = await import('./services/p2p-settlement');

    const result = await measureTradeDelivery(100);

    expect(result.deliveredEnergyWh).toBe(0);
    expect(result.delivery).toBe('not_delivered');
  });

  it('refuses to measure a transfer window that is still open', async () => {
    mockDb({
      settlement: settlementRow(),
      trade: dispatchedSellTrade(30, 60), // started 30 minutes ago, closes in 30
      payment: null,
      telemetry: samplesAt(2000, 30, 30),
    });
    const { measureTradeDelivery } = await import('./services/p2p-settlement');

    await expect(measureTradeDelivery(100)).rejects.toThrow(/closes at/);
    expect(updates).toHaveLength(0);
  });

  it('refuses to measure a trade that was never dispatched to an asset', async () => {
    mockDb({
      settlement: settlementRow(),
      trade: { id: 101, metadata: JSON.stringify({ settlement: 'awaiting_payment' }) },
      payment: null,
      telemetry: [],
    });
    const { measureTradeDelivery } = await import('./services/p2p-settlement');

    await expect(measureTradeDelivery(100)).rejects.toThrow(/cannot be measured/);
  });

  it('refuses to measure a trade with no settlement record', async () => {
    mockDb({ settlement: null, trade: dispatchedSellTrade(), payment: null, telemetry: [] });
    const { measureTradeDelivery } = await import('./services/p2p-settlement');

    await expect(measureTradeDelivery(100)).rejects.toThrow(/no settlement record/);
  });
});

describe('reconcileTradeSettlement', () => {
  const completedPayment = (overrides: Row = {}): Row => ({
    id: 55,
    status: 'completed',
    amount: 5000,
    currency: 'TZS',
    p2pTradeId: 100,
    transactionId: 'PROVIDER-REF-1',
    ...overrides,
  });

  it('holds a measured, paid trade as pending because the seller cannot be paid', async () => {
    mockDb({
      settlement: settlementRow({ delivery: 'measured', deliveredEnergyWh: 2000 }),
      trade: null,
      payment: completedPayment(),
      telemetry: [],
    });
    const { reconcileTradeSettlement } = await import('./services/p2p-settlement');

    const result = await reconcileTradeSettlement(100);

    expect(result.reconciliation).toBe('pending');
    expect(result.note).toContain('seller has not been paid');
    expect(updates.at(-1)?.values).toMatchObject({ reconciledAt: null });
  });

  it('reports a mismatch when the payment amount differs from the settled amount', async () => {
    mockDb({
      settlement: settlementRow({ delivery: 'measured', deliveredEnergyWh: 2000 }),
      trade: null,
      payment: completedPayment({ amount: 4000 }),
      telemetry: [],
    });
    const { reconcileTradeSettlement } = await import('./services/p2p-settlement');

    const result = await reconcileTradeSettlement(100);

    expect(result.reconciliation).toBe('mismatch');
    expect(result.note).toContain('4000 cents against 5000 settled');
    expect(updates.at(-1)?.values).toMatchObject({ state: 'unresolved' });
  });

  it('reports a mismatch when the payment is in another currency', async () => {
    mockDb({
      settlement: settlementRow({ delivery: 'measured', deliveredEnergyWh: 2000 }),
      trade: null,
      payment: completedPayment({ currency: 'KES' }),
      telemetry: [],
    });
    const { reconcileTradeSettlement } = await import('./services/p2p-settlement');

    expect((await reconcileTradeSettlement(100)).reconciliation).toBe('mismatch');
  });

  it('reports a mismatch when the payment is not completed', async () => {
    mockDb({
      settlement: settlementRow({ delivery: 'measured', deliveredEnergyWh: 2000 }),
      trade: null,
      payment: completedPayment({ status: 'pending' }),
      telemetry: [],
    });
    const { reconcileTradeSettlement } = await import('./services/p2p-settlement');

    const result = await reconcileTradeSettlement(100);

    expect(result.reconciliation).toBe('mismatch');
    expect(result.note).toContain("is 'pending', not completed");
  });

  it('reports a mismatch when the payment names another trade', async () => {
    mockDb({
      settlement: settlementRow({ delivery: 'measured', deliveredEnergyWh: 2000 }),
      trade: null,
      payment: completedPayment({ p2pTradeId: 999 }),
      telemetry: [],
    });
    const { reconcileTradeSettlement } = await import('./services/p2p-settlement');

    expect((await reconcileTradeSettlement(100)).reconciliation).toBe('mismatch');
  });

  it('reports a mismatch when the provider reference does not match the payment', async () => {
    mockDb({
      settlement: settlementRow({ delivery: 'measured', deliveredEnergyWh: 2000 }),
      trade: null,
      payment: completedPayment({ transactionId: 'SOMETHING-ELSE' }),
      telemetry: [],
    });
    const { reconcileTradeSettlement } = await import('./services/p2p-settlement');

    const result = await reconcileTradeSettlement(100);

    expect(result.reconciliation).toBe('mismatch');
    expect(result.note).toContain('does not match payment');
  });

  it('reports a mismatch when no payment row backs the recorded payment', async () => {
    mockDb({
      settlement: settlementRow({ delivery: 'measured', deliveredEnergyWh: 2000 }),
      trade: null,
      payment: null,
      telemetry: [],
    });
    const { reconcileTradeSettlement } = await import('./services/p2p-settlement');

    const result = await reconcileTradeSettlement(100);

    expect(result.reconciliation).toBe('mismatch');
    expect(result.note).toContain('no payment row');
  });

  it('reports a mismatch when the energy was measured as undelivered', async () => {
    mockDb({
      settlement: settlementRow({ delivery: 'not_delivered', deliveredEnergyWh: 0 }),
      trade: null,
      payment: completedPayment(),
      telemetry: [],
    });
    const { reconcileTradeSettlement } = await import('./services/p2p-settlement');

    const result = await reconcileTradeSettlement(100);

    expect(result.reconciliation).toBe('mismatch');
    expect(result.note).toContain('undelivered');
  });

  it('stays pending while delivery is unmeasured, even with a clean payment', async () => {
    mockDb({
      settlement: settlementRow(),
      trade: null,
      payment: completedPayment(),
      telemetry: [],
    });
    const { reconcileTradeSettlement } = await import('./services/p2p-settlement');

    const result = await reconcileTradeSettlement(100);

    expect(result.reconciliation).toBe('pending');
    expect(result.note).toContain("delivery is 'unmeasured'");
  });

  it('matches and completes only when payment, delivery and payout are all evidenced', async () => {
    mockDb({
      settlement: settlementRow({
        delivery: 'measured',
        deliveredEnergyWh: 2000,
        sellerPayout: 'evidenced',
        sellerPayoutReference: 'PAYOUT-1',
      }),
      trade: null,
      payment: completedPayment(),
      telemetry: [],
    });
    const { reconcileTradeSettlement } = await import('./services/p2p-settlement');

    const result = await reconcileTradeSettlement(100);

    expect(result.reconciliation).toBe('matched');
    expect(updates.at(-1)?.values).toMatchObject({ state: 'complete' });
  });
});

describe('assertSellerPayoutAvailable', () => {
  it('refuses instead of implying the seller was paid', async () => {
    const { assertSellerPayoutAvailable } = await import('./services/p2p-settlement');
    expect(() => assertSellerPayoutAvailable({ tradeId: 100, sellerId: 8 })).toThrow(
      /no disbursement provider/
    );
  });
});
