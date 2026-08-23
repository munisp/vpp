/**
 * The hold behind a P2P trade is a buyer payment the provider confirmed; there
 * is no custody account. The activity used to compare that payment against an
 * amount the caller re-derived from energy and price, which rounds differently
 * from the total the buyer was actually charged: a validly paid trade failed
 * its own escrow step by a cent.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { getTableName, type Table } from 'drizzle-orm';

type Row = Record<string, unknown>;

const updates: Row[] = [];

function mockDb(store: { trade: Row | null; payment: Row | null }) {
  const rowsFor = (table: Table): Row[] => {
    switch (getTableName(table)) {
      case 'trades':
        return store.trade ? [store.trade] : [];
      case 'payments':
        return store.payment ? [store.payment] : [];
      default:
        return [];
    }
  };

  const db = {
    select: () => ({
      from: (table: Table) => ({
        where: () => ({
          limit: async () => rowsFor(table),
          then: (resolve: (rows: Row[]) => unknown) => Promise.resolve(rowsFor(table)).then(resolve),
        }),
      }),
    }),
    update: () => ({
      set: (values: Row) => ({
        where: async () => {
          updates.push(values);
        },
      }),
    }),
  };
  vi.doMock('./db', () => ({ getDb: async () => db }));
}

beforeEach(() => {
  vi.resetModules();
  updates.length = 0;
});

afterEach(() => {
  vi.doUnmock('./db');
});

describe('createEscrowActivity', () => {
  const input = { tradeId: 100, buyerId: 7, amount: 4501 };

  it('holds a payment that matches the stored trade total, not the caller’s figure', async () => {
    // 4500 is what the buyer was charged; 4501 is the caller's rounding.
    mockDb({
      trade: { totalAmount: 4500, metadata: JSON.stringify({ sellOfferId: 101 }) },
      payment: { id: 900, amount: 4500 },
    });
    const { tradingActivities } = await import('./workflows/trading-activities');

    const result = await tradingActivities.createEscrowActivity(input);

    expect(result).toMatchObject({ success: true, escrowId: 'PAYMENT-900' });
    const metadata = JSON.parse(String(updates[0]?.metadata));
    expect(metadata).toMatchObject({
      escrowAmount: 4500,
      escrowKind: 'provider_confirmed_buyer_payment',
      buyerPaymentId: 900,
      sellOfferId: 101,
    });
  });

  it('refuses when the confirmed payment is not the amount the trade owes', async () => {
    mockDb({
      trade: { totalAmount: 4500, metadata: null },
      payment: { id: 900, amount: 4000 },
    });
    const { tradingActivities } = await import('./workflows/trading-activities');

    const result = await tradingActivities.createEscrowActivity(input);

    expect(result.success).toBe(false);
    expect(result.error).toContain('4000');
    expect(updates).toHaveLength(0);
  });

  it('refuses when no provider-confirmed payment exists', async () => {
    mockDb({ trade: { totalAmount: 4500, metadata: null }, payment: null });
    const { tradingActivities } = await import('./workflows/trading-activities');

    const result = await tradingActivities.createEscrowActivity(input);

    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot hold funds it never received');
    expect(updates).toHaveLength(0);
  });
});
