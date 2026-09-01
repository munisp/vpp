/**
 * Pinning tests for payment verification/settlement:
 *
 *  F3  paymentProcessing.queryPaymentStatus: the gateway adapters already
 *      report amounts in the platform's minor units (cents). The comparison
 *      must not scale again — otherwise every genuine Airtel/Tigo amount
 *      looks 100x too large and verification can never settle.
 *  F4  payments.verify: a partial payment must NOT settle the full invoice.
 *      The invoice is marked paid only when completed payments cover the
 *      consumer share; underpayment is reported honestly as partial.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  state: {
    selectQueue: [] as any[][],
    updates: [] as Array<{ values: any }>,
    updateRowCount: 1,
    paymentRow: null as any,
    statusTransitions: true,
  },
}));

function fakeDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(h.state.selectQueue.shift() ?? [])),
          then: (resolve: any) => resolve(h.state.selectQueue.shift() ?? []),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: any) => ({
        where: vi.fn(() => {
          h.state.updates.push({ values });
          return Promise.resolve({ rowCount: h.state.updateRowCount });
        }),
      })),
    })),
  };
}

vi.mock('../db', () => ({
  getDb: vi.fn(() => Promise.resolve(fakeDb())),
  getPaymentById: vi.fn(async () => h.state.paymentRow),
  createPayment: vi.fn(async (values: any) => ({ id: 777, ...values })),
  updatePaymentMetadata: vi.fn(async () => undefined),
  updatePaymentStatus: vi.fn(async () => h.state.statusTransitions),
  getTokenByPaymentId: vi.fn(async () => null),
  getUserByOpenId: vi.fn(async () => null),
}));

vi.mock('../services/paystack-service', () => ({
  paystackService: {
    initiatePayment: vi.fn(),
    queryPaymentStatus: vi.fn(),
  },
}));

vi.mock('../services/flutterwave-service', () => ({
  flutterwaveService: {
    initiatePayment: vi.fn(),
    queryPaymentStatus: vi.fn(),
  },
}));

vi.mock('../payment-gateways', () => ({
  PaymentGatewayManager: {
    queryPaymentStatus: vi.fn(),
    initiatePayment: vi.fn(),
    getSupportedGateways: vi.fn(() => []),
  },
}));

vi.mock('../_core/paymentGateway', () => ({
  verifyPaymentStatus: vi.fn(),
  initiateMpesaPayment: vi.fn(),
  initiateAirtelPayment: vi.fn(),
  initiateTigoPesaPayment: vi.fn(),
  toGatewayMajorUnits: (amountCents: number) => amountCents / 100,
}));

vi.mock('../_core/notifications', () => ({
  createNotification: vi.fn(),
}));

vi.mock('../_core/sendNotification', () => ({
  sendPushNotification: vi.fn(() => Promise.resolve({ success: true })),
}));

vi.mock('../services/prepaid-issuance-entry', () => ({
  issuePrepaidTokenForPayment: vi.fn(() => Promise.resolve({ issued: false, reason: 'no prepaid account', retryScheduled: false })),
}));

vi.mock('../integration/temporal-client', () => ({
  temporalClient: { startPaymentWorkflow: vi.fn() },
}));

vi.mock('../services/events/outbox', () => ({
  enqueueEvent: vi.fn(() => Promise.resolve()),
}));

import { PaymentGatewayManager } from '../payment-gateways';
import { verifyPaymentStatus } from '../_core/paymentGateway';
import { paystackService } from '../services/paystack-service';
import { flutterwaveService } from '../services/flutterwave-service';
import { paymentProcessingRouter } from './paymentProcessing';
import { paymentsRouter } from './payments';

const mockGatewayQuery = vi.mocked(PaymentGatewayManager.queryPaymentStatus);
const mockCoreVerify = vi.mocked(verifyPaymentStatus);
const mockPaystackInitiate = vi.mocked(paystackService.initiatePayment);
const mockFlutterwaveInitiate = vi.mocked(flutterwaveService.initiatePayment);

const ctx = { user: { id: 42, role: 'user', currency: 'TZS', openId: 'u42' } } as any;

beforeEach(() => {
  h.state.selectQueue = [];
  h.state.updates = [];
  h.state.updateRowCount = 1;
  h.state.paymentRow = null;
  h.state.statusTransitions = true;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.resetModules();
});

describe('F3: Airtel/Tigo verification round-trip (minor units both sides)', () => {
  const airtelPayment = {
    id: 901,
    userId: 42,
    billingId: 7,
    paymentType: 'invoice',
    amount: 500000, // cents
    currency: 'TZS',
    paymentMethod: 'airtel_money',
    transactionId: 'airtel-tx-1',
    status: 'pending',
    metadata: '{}',
  };

  it('settles when the gateway reports the same amount (already in cents)', async () => {
    mockGatewayQuery.mockResolvedValueOnce({
      status: 'completed',
      amount: 500000, // adapter already normalized major units -> cents
      transactionId: 'airtel-tx-1',
      message: 'Success',
    } as any);

    h.state.selectQueue = [
      [airtelPayment], // payment lookup
      [{ id: 7, userId: 42, consumerShare: 500000, status: 'issued' }], // billing
      [{ total: 500000 }], // SUM(completed payments)
    ];

    const caller = paymentProcessingRouter.createCaller(ctx);
    const result = await caller.queryPaymentStatus({ paymentId: 901 });

    expect(result.success).toBe(true);
    expect(result.status).toBe('completed');
    expect(h.state.updates.some(u => u.values.status === 'completed')).toBe(true);
    expect(h.state.updates.some(u => u.values.status === 'paid')).toBe(true);
  });

  it('reports a discrepancy (and settles nothing) when the gateway amount differs', async () => {
    mockGatewayQuery.mockResolvedValueOnce({
      status: 'completed',
      amount: 6000, // genuinely different from the recorded 500000 cents
      transactionId: 'airtel-tx-1',
      message: 'Success',
    } as any);

    h.state.selectQueue = [[airtelPayment]];

    const caller = paymentProcessingRouter.createCaller(ctx);
    const result = await caller.queryPaymentStatus({ paymentId: 901 });

    expect(result.success).toBe(false);
    expect(result.status).toBe('discrepancy');
    expect(h.state.updates.some(u => u.values.status === 'completed')).toBe(false);
    expect(h.state.updates.some(u => u.values.status === 'paid')).toBe(false);
  });
});

describe('F4: payments.verify only settles a fully covered invoice', () => {
  function paymentRow(amount: number) {
    return {
      id: 902,
      userId: 42,
      billingId: 7,
      paymentType: 'invoice',
      amount,
      currency: 'TZS',
      paymentMethod: 'tigo_pesa',
      transactionId: 'tigo-tx-1',
      status: 'pending',
      metadata: JSON.stringify({ gatewayReference: 'tigo-tx-1' }),
    };
  }

  it('underpayment: payment completes, invoice stays issued, partial is exposed', async () => {
    h.state.paymentRow = paymentRow(300000);
    mockCoreVerify.mockResolvedValueOnce({ status: 'completed', message: 'Success' } as any);

    h.state.selectQueue = [
      [{ id: 7, userId: 42, consumerShare: 500000, status: 'issued' }],
      [{ total: 300000 }], // completed payments so far under-cover the invoice
    ];

    const caller = paymentsRouter.createCaller(ctx);
    const result = await caller.verify({ paymentId: 902 });

    expect(result.success).toBe(true);
    expect((result as any).partial).toBe(true);
    expect((result as any).paidCents).toBe(300000);
    expect((result as any).dueCents).toBe(500000);
    // The invoice is NOT marked paid.
    expect(h.state.updates.some(u => u.values.status === 'paid')).toBe(false);
  });

  it('exact payment: invoice is marked paid', async () => {
    h.state.paymentRow = paymentRow(500000);
    mockCoreVerify.mockResolvedValueOnce({ status: 'completed', message: 'Success' } as any);

    h.state.selectQueue = [
      [{ id: 7, userId: 42, consumerShare: 500000, status: 'issued' }],
      [{ total: 500000 }],
    ];

    const caller = paymentsRouter.createCaller(ctx);
    const result = await caller.verify({ paymentId: 902 });

    expect(result.success).toBe(true);
    expect((result as any).partial).toBeUndefined();
    expect(h.state.updates.some(u => u.values.status === 'paid')).toBe(true);
  });
});

describe('F6a: payments.initiate can reach the Nigerian hosted-checkout providers', () => {
  const hostedBase = {
    paymentType: 'invoice' as const,
    amount: 500000, // cents == kobo
    email: 'customer@example.com',
  };

  it('initiates a Paystack checkout with the kobo amount unscaled', async () => {
    mockPaystackInitiate.mockResolvedValueOnce({
      success: true,
      reference: 'PAY777',
      authorizationUrl: 'https://checkout.paystack.com/abc',
      message: 'Transaction initialized',
    } as any);

    const caller = paymentsRouter.createCaller(ctx);
    const result = await caller.initiate({ ...hostedBase, paymentMethod: 'paystack' });

    expect(result.success).toBe(true);
    expect(mockPaystackInitiate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 500000, reference: 'PAY777', email: 'customer@example.com' })
    );
    expect((result.gatewayResponse as any).authorizationUrl).toBe('https://checkout.paystack.com/abc');
  });

  it('initiates a Flutterwave checkout converting kobo to naira exactly once', async () => {
    mockFlutterwaveInitiate.mockResolvedValueOnce({
      success: true,
      txRef: 'PAY777',
      paymentLink: 'https://checkout.flutterwave.com/abc',
      message: 'Payment initialized',
    } as any);

    const caller = paymentsRouter.createCaller(ctx);
    const result = await caller.initiate({ ...hostedBase, paymentMethod: 'flutterwave' });

    expect(result.success).toBe(true);
    expect(mockFlutterwaveInitiate).toHaveBeenCalledWith(
      expect.objectContaining({ txRef: 'PAY777', amount: 5000 }) // 500000 kobo -> 5000 naira
    );
  });

  it('fails loud and retires the payment when the provider is not configured', async () => {
    mockPaystackInitiate.mockResolvedValueOnce({
      success: false,
      error: 'paystack_not_configured: PAYSTACK_SECRET_KEY is not set',
    } as any);

    const caller = paymentsRouter.createCaller(ctx);
    await expect(
      caller.initiate({ ...hostedBase, paymentMethod: 'paystack' })
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('refuses a hosted-checkout charge without a customer email before money moves', async () => {
    const caller = paymentsRouter.createCaller({
      user: { id: 42, role: 'user', currency: 'NGN', openId: 'u42', email: null },
    } as any);

    await expect(
      caller.initiate({ paymentType: 'invoice', amount: 500000, paymentMethod: 'paystack' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockPaystackInitiate).not.toHaveBeenCalled();
  });
});
