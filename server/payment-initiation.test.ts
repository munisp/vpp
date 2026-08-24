/**
 * `payments.initiate` asks a mobile-money provider for money, and end-to-end
 * testing showed the route answering HTTP 500 "Failed to initiate payment"
 * whenever no provider is configured — after the payment row was already
 * written, leaving a pending payment a status query could later resolve.
 *
 * These tests pin:
 *  - a method with no provider behind it (bank transfer, card) is refused
 *    before any payment row exists, rather than reported as initiated
 *  - a mobile-money method with no phone number is refused the same way
 *  - an unconfigured gateway is reported as unavailable, and its reservation
 *    is retired instead of left pending
 *  - an unreachable gateway is reported as a gateway failure, also retired
 *  - an accepted request keeps the payment pending with the gateway reference
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

interface Recorded {
  created: Array<Record<string, unknown>>;
  statuses: Array<{ id: number; status: string; expected?: string }>;
  requests: Array<Record<string, unknown>>;
}

function mocks(recorded: Recorded, gateway: () => unknown) {
  vi.doMock('./db', () => ({
    getBillingById: async () => null,
    createPayment: async (values: Record<string, unknown>) => {
      recorded.created.push(values);
      return { id: 501, ...values };
    },
    updatePaymentStatus: async (
      id: number,
      status: string,
      _transactionId?: string,
      expected?: string
    ) => {
      recorded.statuses.push({ id, status, expected });
    },
    updatePaymentMetadata: async () => undefined,
  }));

  const initiator = async (request: Record<string, unknown>) => {
    recorded.requests.push(request);
    const result = gateway();
    if (result instanceof Error) throw result;
    return result;
  };

  vi.doMock('./_core/paymentGateway', () => ({
    initiateMpesaPayment: initiator,
    initiateAirtelPayment: initiator,
    initiateTigoPesaPayment: initiator,
  }));

  vi.doMock('./_core/notifications', () => ({
    createNotification: async () => undefined,
  }));
}

async function initiate(input: Record<string, unknown>) {
  const { paymentsRouter } = await import('./routers/payments');
  const caller = paymentsRouter.createCaller({
    user: { id: 42, role: 'user', currency: 'TZS' },
  } as never);
  return caller.initiate(input as never);
}

function recorder(): Recorded {
  return { created: [], statuses: [], requests: [] };
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('./db');
  vi.doUnmock('./_core/paymentGateway');
  vi.doUnmock('./_core/notifications');
});

const base = {
  paymentType: 'invoice' as const,
  amount: 5_000,
  phoneNumber: '+255700000001',
};

describe('payments.initiate', () => {
  it.each(['bank_transfer', 'card'])(
    'refuses %s as unavailable without writing a payment',
    async (paymentMethod) => {
      const recorded = recorder();
      mocks(recorded, () => ({ success: true }));

      await expect(initiate({ ...base, paymentMethod })).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        message: expect.stringContaining('PAYMENT_METHOD_NO_PROVIDER'),
      });
      expect(recorded.created).toHaveLength(0);
      expect(recorded.requests).toHaveLength(0);
    }
  );

  it('refuses a mobile-money charge with no phone number', async () => {
    const recorded = recorder();
    mocks(recorded, () => ({ success: true }));

    await expect(
      initiate({ ...base, phoneNumber: undefined, paymentMethod: 'mpesa' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(recorded.created).toHaveLength(0);
  });

  it('reports an unconfigured gateway as unavailable and retires the payment', async () => {
    const recorded = recorder();
    mocks(recorded, () => new Error('MPESA_NOT_CONFIGURED'));

    await expect(initiate({ ...base, paymentMethod: 'mpesa' })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'MPESA_NOT_CONFIGURED',
    });
    expect(recorded.created).toHaveLength(1);
    expect(recorded.statuses).toEqual([
      { id: 501, status: 'failed', expected: 'pending' },
    ]);
  });

  it('reports an unreachable gateway as a gateway failure and retires the payment', async () => {
    const recorded = recorder();
    mocks(recorded, () => new Error('connect ECONNREFUSED 127.0.0.1:443'));

    await expect(initiate({ ...base, paymentMethod: 'airtel_money' })).rejects.toMatchObject({
      code: 'BAD_GATEWAY',
    });
    expect(recorded.statuses).toEqual([
      { id: 501, status: 'failed', expected: 'pending' },
    ]);
  });

  it('keeps an accepted request pending against its gateway reference', async () => {
    const recorded = recorder();
    mocks(recorded, () => ({
      success: true,
      checkoutRequestId: 'ws_CO_1',
      transactionId: 'merchant-1',
      message: 'Payment request sent to customer phone',
    }));

    const result = await initiate({ ...base, paymentMethod: 'tigo_pesa' });
    expect(result.gatewayResponse).toMatchObject({ success: true });
    expect(recorded.requests[0]).toMatchObject({
      amount: 5_000,
      accountReference: 'PAY501',
    });
    expect(recorded.statuses).toEqual([
      { id: 501, status: 'pending', expected: undefined },
    ]);
  });
});
