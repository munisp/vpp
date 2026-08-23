/**
 * Asking a mobile-money provider for money is the one step in a P2P trade that
 * cannot be undone by the platform, so it is guarded by the database rather than
 * by a read: a payment row is reserved under the live-payment unique index
 * before the provider is called, and whoever loses that race never calls the
 * provider at all.
 *
 * These tests pin:
 *  - a deployment with no provider refuses before reserving anything
 *  - the reservation is inserted before the provider is asked
 *  - a concurrent request that loses the unique index returns the in-flight
 *    request instead of raising a second charge
 *  - a provider refusal releases the reservation so the buyer can retry
 *  - a provider call that throws keeps the reservation, because it is unknown
 *    whether the request was received
 *  - a payment can only settle the trade it is linked to, and only for the
 *    person who made it
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { getTableName, type Table } from 'drizzle-orm';

type Row = Record<string, unknown>;

interface Store {
  trade: Row;
  payments: Row[];
}

interface Recorder {
  inserts: Row[];
  updates: Array<{ table: string; values: Row }>;
  order: string[];
}

/**
 * A unique violation from the partial index on payments.p2pTradeId, shaped as
 * node-postgres reports it.
 */
function uniqueViolation(): Error & { code: string } {
  const error = new Error(
    'duplicate key value violates unique constraint "payments_p2p_trade_live_uq"'
  ) as Error & { code: string };
  error.code = '23505';
  return error;
}

function mockDb(store: Store, recorder: Recorder, opts: { insertError?: () => Error } = {}) {
  const rowsFor = (table: Table): Row[] => {
    switch (getTableName(table)) {
      case 'trades':
        return [store.trade];
      case 'payments':
        return store.payments;
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
    insert: (table: Table) => ({
      values: (values: Row) => ({
        returning: async () => {
          recorder.order.push(`insert:${getTableName(table)}`);
          if (opts.insertError) throw opts.insertError();
          recorder.inserts.push(values);
          const id = 900 + recorder.inserts.length;
          store.payments.push({ ...values, id });
          return [{ id }];
        },
      }),
    }),
    update: (table: Table) => ({
      set: (values: Row) => ({
        where: async () => {
          recorder.updates.push({ table: getTableName(table), values });
        },
      }),
    }),
  };
  vi.doMock('./db', () => ({ getDb: async () => db }));
}

function mockGateway(
  recorder: Recorder,
  behaviour:
    | { configured: false; reason: string }
    | { configured: true; initiate: () => unknown }
) {
  const initiatePayment = vi.fn(async () => {
    recorder.order.push('provider:initiate');
    if (!behaviour.configured) throw new Error('unreachable in this test');
    return behaviour.initiate();
  });
  vi.doMock('./payment-gateways', () => ({
    PaymentGatewayManager: {
      isConfigured: async () =>
        behaviour.configured
          ? { configured: true }
          : { configured: false, reason: behaviour.reason },
      initiatePayment,
    },
  }));
  vi.doMock('./payment-gateways/environment', () => ({
    resolveGatewayEnvironment: () => 'sandbox' as const,
  }));
  return initiatePayment;
}

function tradeRow(overrides: Row = {}): Row {
  return {
    id: 100,
    userId: 7,
    tradeType: 'p2p_buy',
    status: 'pending',
    counterpartyId: 8,
    energy: 5000,
    totalAmount: 4500,
    metadata: JSON.stringify({ sellOfferId: 101 }),
    ...overrides,
  };
}

let recorder: Recorder;

beforeEach(() => {
  vi.resetModules();
  recorder = { inserts: [], updates: [], order: [] };
});

afterEach(() => {
  vi.doUnmock('./db');
  vi.doUnmock('./payment-gateways');
  vi.doUnmock('./payment-gateways/environment');
});

describe('startTradePayment reserves before it charges', () => {
  const input = {
    buyTradeId: 100,
    buyerId: 7,
    gateway: 'mpesa' as const,
    phoneNumber: '255700000001',
  };

  it('refuses without reserving anything when no provider is configured', async () => {
    mockDb({ trade: tradeRow(), payments: [] }, recorder);
    const initiate = mockGateway(recorder, {
      configured: false,
      reason: 'No sandbox credentials are stored for mpesa.',
    });
    const { startTradePayment } = await import('./services/p2p-settlement');

    await expect(startTradePayment(input)).rejects.toMatchObject({
      code: 'GATEWAY_NOT_CONFIGURED',
    });
    expect(initiate).not.toHaveBeenCalled();
    expect(recorder.inserts).toHaveLength(0);
  });

  it('inserts the reservation before asking the provider for money', async () => {
    mockDb({ trade: tradeRow(), payments: [] }, recorder);
    mockGateway(recorder, {
      configured: true,
      initiate: () => ({
        success: true,
        transactionId: 'MERCHANT-1',
        checkoutRequestId: 'CHECKOUT-1',
        message: 'accepted',
      }),
    });
    const { startTradePayment } = await import('./services/p2p-settlement');

    const result = await startTradePayment(input);

    expect(recorder.order).toEqual(['insert:payments', 'provider:initiate']);
    expect(recorder.inserts[0]).toMatchObject({
      p2pTradeId: 100,
      status: 'pending',
      amount: 4500,
      currency: 'TZS',
      userId: 7,
    });
    expect(result.transactionId).toBe('MERCHANT-1');
    expect(result.checkoutRequestId).toBe('CHECKOUT-1');
    expect(result.settlement).toBe('buyer_payment_initiated');
  });

  it('returns the in-flight request when a concurrent one won the reservation', async () => {
    // The loser of the race sees the unique index, not an empty read.
    const store: Store = { trade: tradeRow(), payments: [] };
    mockDb(store, recorder, { insertError: uniqueViolation });
    const initiate = mockGateway(recorder, {
      configured: true,
      initiate: () => ({ success: true, transactionId: 'SECOND-CHARGE' }),
    });
    store.payments.push({
      id: 500,
      status: 'pending',
      amount: 4500,
      transactionId: 'MERCHANT-1',
      p2pTradeId: 100,
      metadata: JSON.stringify({ buyTradeId: 100, checkoutRequestId: 'CHECKOUT-1' }),
    });
    const { startTradePayment } = await import('./services/p2p-settlement');

    const result = await startTradePayment(input);

    expect(initiate).not.toHaveBeenCalled();
    expect(result.paymentId).toBe(500);
    expect(result.transactionId).toBe('MERCHANT-1');
    expect(result.checkoutRequestId).toBe('CHECKOUT-1');
  });

  it('refuses a trade a completed payment already settled', async () => {
    const store: Store = {
      trade: tradeRow(),
      payments: [{ id: 501, status: 'completed', amount: 4500, p2pTradeId: 100, metadata: null }],
    };
    mockDb(store, recorder);
    const initiate = mockGateway(recorder, {
      configured: true,
      initiate: () => ({ success: true, transactionId: 'SECOND-CHARGE' }),
    });
    const { startTradePayment } = await import('./services/p2p-settlement');

    await expect(startTradePayment(input)).rejects.toMatchObject({ code: 'ALREADY_PAID' });
    expect(initiate).not.toHaveBeenCalled();
  });

  it('releases the reservation when the provider refuses before taking money', async () => {
    mockDb({ trade: tradeRow(), payments: [] }, recorder);
    mockGateway(recorder, {
      configured: true,
      initiate: () => ({ success: false, message: 'Insufficient balance' }),
    });
    const { startTradePayment } = await import('./services/p2p-settlement');

    await expect(startTradePayment(input)).rejects.toMatchObject({ code: 'GATEWAY_REFUSED' });
    const released = recorder.updates.find(u => u.table === 'payments');
    expect(released?.values.status).toBe('failed');
  });

  it('keeps the reservation live when the provider call throws', async () => {
    // Whether the provider received the request is unknown, so releasing the
    // reservation would let a retry raise a second charge for the same trade.
    mockDb({ trade: tradeRow(), payments: [] }, recorder);
    mockGateway(recorder, {
      configured: true,
      initiate: () => {
        throw new Error('socket hang up');
      },
    });
    const { startTradePayment } = await import('./services/p2p-settlement');

    await expect(startTradePayment(input)).rejects.toMatchObject({ code: 'GATEWAY_UNREACHABLE' });
    expect(recorder.updates.filter(u => u.table === 'payments')).toHaveLength(0);
    expect(recorder.inserts[0]).toMatchObject({ status: 'pending' });
  });
});

describe('recordBuyerPaymentSettled attributes a payment to one trade and one payer', () => {
  const confirmed = {
    id: 900,
    userId: 7,
    amount: 4500,
    currency: 'TZS',
    transactionId: 'MERCHANT-1',
  };

  it('refuses when the payment column and its metadata name different trades', async () => {
    mockDb({ trade: tradeRow(), payments: [] }, recorder);
    const { recordBuyerPaymentSettled } = await import('./services/p2p-settlement');

    await expect(
      recordBuyerPaymentSettled({
        ...confirmed,
        p2pTradeId: 100,
        metadata: JSON.stringify({ buyTradeId: 999 }),
      })
    ).rejects.toMatchObject({ code: 'PAYMENT_TRADE_CONFLICT' });
  });

  it('refuses to settle one participant’s trade with another participant’s payment', async () => {
    mockDb({ trade: tradeRow({ userId: 7 }), payments: [] }, recorder);
    const { recordBuyerPaymentSettled } = await import('./services/p2p-settlement');

    await expect(
      recordBuyerPaymentSettled({
        ...confirmed,
        userId: 42,
        p2pTradeId: 100,
        metadata: JSON.stringify({ buyTradeId: 100 }),
      })
    ).rejects.toMatchObject({ code: 'PAYMENT_PAYER_MISMATCH' });
    expect(recorder.updates).toHaveLength(0);
  });

  it('refuses a payment linked to something that is not a purchase', async () => {
    mockDb({ trade: tradeRow({ tradeType: 'p2p_sell' }), payments: [] }, recorder);
    const { recordBuyerPaymentSettled } = await import('./services/p2p-settlement');

    await expect(
      recordBuyerPaymentSettled({ ...confirmed, p2pTradeId: 100, metadata: null })
    ).rejects.toMatchObject({ code: 'TRADE_NOT_PURCHASE' });
  });
});
