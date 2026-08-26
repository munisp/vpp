import { afterEach, describe, expect, it, vi } from 'vitest';

const payment = {
  id: 71,
  userId: 9,
  paymentType: 'invoice',
  billingId: null,
  amount: 5_000,
  currency: 'TZS',
  paymentMethod: 'mpesa',
  transactionId: 'checkout-71',
  p2pTradeId: null,
  metadata: null,
  status: 'pending',
};

function setup() {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    insert: () => ({ values: async () => undefined }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [payment],
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return {
          where: async () => ({ rowCount: 1 }),
        };
      },
    }),
  };

  vi.doMock('./db', () => ({ getDb: async () => db }));
  vi.doMock('./payment-gateways', () => ({
    PaymentGatewayManager: {
      processCallback: async () => ({
        transactionId: 'checkout-71',
        status: 'completed',
        amount: 5_000,
      }),
    },
  }));
  vi.doMock('./_core/sendNotification', () => ({
    sendPushNotification: async () => {
      throw new Error('push provider unavailable');
    },
  }));

  return { updates };
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('./db');
  vi.doUnmock('./payment-gateways');
  vi.doUnmock('./_core/sendNotification');
});

describe('payment callback recovery', () => {
  it('records a durable reconciliation marker when a completed payment side effect fails', async () => {
    const { updates } = setup();
    const { handleMpesaCallback } = await import('./webhooks/payment-callbacks');
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    await handleMpesaCallback(
      { body: { Body: { stkCallback: { CheckoutRequestID: 'checkout-71' } } } } as never,
      res as never
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(updates).toHaveLength(2);
    const marker = JSON.parse(String(updates[1].metadata));
    expect(marker.postPaymentActionFailure).toMatchObject({
      reason: 'push provider unavailable',
      paymentType: 'invoice',
    });
    expect(marker.postPaymentActionFailure.recordedAt).toEqual(expect.any(String));
  });
});
