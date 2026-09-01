/**
 * Nigerian Payment Gateway Tests
 *
 * Covers the Paystack and Flutterwave adapters and their dispatch through
 * PaymentGatewayService. Network access is mocked at the axios layer; the
 * provider services and the gateway dispatch run for real, so these tests
 * verify status mapping, amount conversion, and fail-loud behavior end to end.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock axios — the only network boundary used by the services under test.
vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
    get: vi.fn(),
  },
}));

// Shared, mutable DB state for the mocked drizzle client. vi.hoisted makes it
// available inside the hoisted vi.mock factory below.
const h = vi.hoisted(() => ({
  paymentRow: null as any,
  updates: [] as Array<Record<string, any>>,
  insertedValues: [] as Array<Record<string, any>>,
}));

vi.mock('../db', () => ({
  getDb: vi.fn(() =>
    Promise.resolve({
      insert: vi.fn(() => ({
        // node-postgres has no insertId: the generated key comes back from
        // `.returning()`.
        values: vi.fn((vals: any) => {
          h.insertedValues.push(vals);
          return { returning: vi.fn(() => Promise.resolve([{ id: 1 }])) };
        }),
      })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve(h.paymentRow ? [h.paymentRow] : [])),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((vals: any) => {
          h.updates.push(vals);
          return { where: vi.fn(() => Promise.resolve()) };
        }),
      })),
      // processRefund claims the payment inside a transaction: the tx client
      // serves the locked row via execute() and records updates via update().
      transaction: vi.fn(async (fn: (tx: any) => Promise<unknown>) =>
        fn({
          execute: vi.fn(() => Promise.resolve({ rows: h.paymentRow ? [h.paymentRow] : [] })),
          update: vi.fn(() => ({
            set: vi.fn((vals: any) => {
              h.updates.push(vals);
              return { where: vi.fn(() => Promise.resolve({ rowCount: 1 })) };
            }),
          })),
        })
      ),
    })
  ),
}));

// The payout guard reads dependency posture from its own tables; these tests
// exercise the payment/refund logic, and the guard's refusals are covered by
// server/degraded-operation.test.ts.
vi.mock('./degraded-operation', async () => {
  const actual =
    await vi.importActual<typeof import('./degraded-operation')>('./degraded-operation');
  return {
    ...actual,
    requireCapability: vi.fn(async () => ({
      posture: 'available' as const,
      missing: [],
      evidenceLimit: null,
    })),
    observing: vi.fn(async (_input: unknown, call: () => Promise<unknown>) => call()),
  };
});

import axios from 'axios';
import { paystackService } from './paystack-service';
import { flutterwaveService } from './flutterwave-service';
import { paymentGatewayService } from './payment-gateway-service';

const axiosPost = vi.mocked(axios.post);
const axiosGet = vi.mocked(axios.get);

const PAYSTACK_ENV = process.env.PAYSTACK_SECRET_KEY;
const FLUTTERWAVE_ENV = process.env.FLUTTERWAVE_SECRET_KEY;

beforeEach(() => {
  vi.clearAllMocks();
  h.paymentRow = null;
  h.updates.length = 0;
  h.insertedValues.length = 0;
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_paystack';
  process.env.FLUTTERWAVE_SECRET_KEY = 'FLWSECK_TEST-flutterwave';
  delete process.env.PAYSTACK_BASE_URL;
  delete process.env.FLUTTERWAVE_BASE_URL;
});

afterEach(() => {
  if (PAYSTACK_ENV === undefined) delete process.env.PAYSTACK_SECRET_KEY;
  else process.env.PAYSTACK_SECRET_KEY = PAYSTACK_ENV;
  if (FLUTTERWAVE_ENV === undefined) delete process.env.FLUTTERWAVE_SECRET_KEY;
  else process.env.FLUTTERWAVE_SECRET_KEY = FLUTTERWAVE_ENV;
});

describe('PaystackService', () => {
  it('initiates a transaction and maps reference -> transactionId handle', async () => {
    axiosPost.mockResolvedValueOnce({
      data: {
        status: true,
        message: 'Authorization URL created',
        data: {
          authorization_url: 'https://checkout.paystack.com/abc123',
          access_code: 'abc123',
          reference: 'PSK_REF_001',
        },
      },
    });

    const result = await paystackService.initiatePayment({
      email: 'customer@example.ng',
      amount: 50000, // kobo
      reference: 'INV-1001',
      callbackUrl: 'https://vpp.example.ng/payments/callback',
    });

    expect(result.success).toBe(true);
    expect(result.reference).toBe('PSK_REF_001');
    expect(result.authorizationUrl).toBe('https://checkout.paystack.com/abc123');

    // Paystack receives kobo unscaled, the bearer key, and the callback URL.
    expect(axiosPost).toHaveBeenCalledWith(
      'https://api.paystack.co/transaction/initialize',
      expect.objectContaining({
        email: 'customer@example.ng',
        amount: 50000,
        reference: 'INV-1001',
        currency: 'NGN',
        callback_url: 'https://vpp.example.ng/payments/callback',
      }),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk_test_paystack' }),
      })
    );
  });

  it('reports gateway refusal honestly (no fabricated success)', async () => {
    axiosPost.mockResolvedValueOnce({
      data: { status: false, message: 'Invalid amount' },
    });

    const result = await paystackService.initiatePayment({
      email: 'customer@example.ng',
      amount: 50000,
      reference: 'INV-1002',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid amount');
    expect(result.reference).toBeUndefined();
  });

  it('fails loud without a secret key and makes NO network call', async () => {
    delete process.env.PAYSTACK_SECRET_KEY;

    const init = await paystackService.initiatePayment({
      email: 'customer@example.ng',
      amount: 50000,
      reference: 'INV-1003',
    });
    const status = await paystackService.queryPaymentStatus('PSK_REF_001');
    const refund = await paystackService.processRefund('PSK_REF_001', 'Customer request');

    const expected = 'paystack_not_configured: PAYSTACK_SECRET_KEY is not set';
    expect(init).toEqual({ success: false, error: expected });
    expect(status.success).toBe(false);
    expect(status.error).toBe(expected);
    expect(refund.success).toBe(false);
    expect(refund.error).toBe(expected);
    expect(axiosPost).not.toHaveBeenCalled();
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('fails loud when the customer email is missing, with no network call', async () => {
    const result = await paystackService.initiatePayment({
      email: '',
      amount: 50000,
      reference: 'INV-1004',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('email is required');
    expect(axiosPost).not.toHaveBeenCalled();
  });

  it('maps verify data.status explicitly: success -> completed, failed -> failed, other -> pending', async () => {
    axiosGet.mockResolvedValueOnce({
      data: {
        status: true,
        message: 'Verification successful',
        data: { status: 'success', reference: 'PSK_REF_001', amount: 50000, gateway_response: 'Successful' },
      },
    });
    const completed = await paystackService.queryPaymentStatus('PSK_REF_001');
    expect(completed.success).toBe(true);
    expect(completed.status).toBe('completed');
    expect(completed.amount).toBe(50000);
    expect(axiosGet).toHaveBeenCalledWith(
      'https://api.paystack.co/transaction/verify/PSK_REF_001',
      expect.anything()
    );

    axiosGet.mockResolvedValueOnce({
      data: { status: true, message: 'ok', data: { status: 'failed', reference: 'PSK_REF_002' } },
    });
    const failed = await paystackService.queryPaymentStatus('PSK_REF_002');
    expect(failed.status).toBe('failed');

    axiosGet.mockResolvedValueOnce({
      data: { status: true, message: 'ok', data: { status: 'ongoing', reference: 'PSK_REF_003' } },
    });
    const pending = await paystackService.queryPaymentStatus('PSK_REF_003');
    expect(pending.status).toBe('pending');
  });

  it('processes a refund only when Paystack accepts it', async () => {
    axiosPost.mockResolvedValueOnce({
      data: { status: true, message: 'Refund has been queued', data: { id: 778899, status: 'pending' } },
    });

    const result = await paystackService.processRefund('PSK_REF_001', 'Customer request');

    expect(result.success).toBe(true);
    expect(result.refundId).toBe('778899');
    expect(axiosPost).toHaveBeenCalledWith(
      'https://api.paystack.co/refund',
      { transaction: 'PSK_REF_001', merchant_note: 'Customer request' },
      expect.anything()
    );

    axiosPost.mockResolvedValueOnce({
      data: { status: false, message: 'Transaction was fully refunded' },
    });
    const rejected = await paystackService.processRefund('PSK_REF_001', 'Second attempt');
    expect(rejected.success).toBe(false);
    expect(rejected.error).toBe('Transaction was fully refunded');
  });
});

describe('FlutterwaveService', () => {
  it('initiates a standard payment in major units and returns the checkout link', async () => {
    axiosPost.mockResolvedValueOnce({
      data: {
        status: 'success',
        message: 'Hosted Link',
        data: { link: 'https://checkout.flutterwave.com/xyz' },
      },
    });

    const result = await flutterwaveService.initiatePayment({
      txRef: 'INV-2001',
      amount: 500, // naira (major units)
      customer: { email: 'customer@example.ng', phonenumber: '08012345678', name: 'INV-2001' },
      redirectUrl: 'https://vpp.example.ng/payments/callback',
    });

    expect(result.success).toBe(true);
    expect(result.txRef).toBe('INV-2001');
    expect(result.paymentLink).toBe('https://checkout.flutterwave.com/xyz');
    expect(axiosPost).toHaveBeenCalledWith(
      'https://api.flutterwave.com/v3/payments',
      expect.objectContaining({
        tx_ref: 'INV-2001',
        amount: 500,
        currency: 'NGN',
        redirect_url: 'https://vpp.example.ng/payments/callback',
      }),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer FLWSECK_TEST-flutterwave' }),
      })
    );
  });

  it("verify maps data.status 'successful' -> completed via /transactions/:id/verify", async () => {
    axiosGet.mockResolvedValueOnce({
      data: {
        status: 'success',
        message: 'Transaction fetched successfully',
        data: { id: 1234567, tx_ref: 'INV-2001', status: 'successful', amount: 500, currency: 'NGN' },
      },
    });

    const result = await flutterwaveService.verifyTransaction('1234567');

    expect(result.success).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.transactionId).toBe('1234567');
    expect(result.amount).toBe(500);
    expect(axiosGet).toHaveBeenCalledWith(
      'https://api.flutterwave.com/v3/transactions/1234567/verify',
      expect.anything()
    );
  });

  it('queryPaymentStatus verifies by tx_ref and captures the numeric transaction id', async () => {
    axiosGet.mockResolvedValueOnce({
      data: {
        status: 'success',
        message: 'Transaction fetched successfully',
        data: { id: 7654321, tx_ref: 'INV-2002', status: 'pending', amount: 500, currency: 'NGN' },
      },
    });

    const result = await flutterwaveService.queryPaymentStatus('INV-2002');

    expect(result.success).toBe(true);
    expect(result.status).toBe('pending');
    expect(result.transactionId).toBe('7654321');
    expect(axiosGet).toHaveBeenCalledWith(
      'https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=INV-2002',
      expect.anything()
    );
  });

  it('fails loud without a secret key and makes NO network call', async () => {
    delete process.env.FLUTTERWAVE_SECRET_KEY;

    const init = await flutterwaveService.initiatePayment({
      txRef: 'INV-2003',
      amount: 500,
      customer: { email: 'customer@example.ng' },
    });
    const verify = await flutterwaveService.verifyTransaction('1234567');
    const query = await flutterwaveService.queryPaymentStatus('INV-2003');
    const refund = await flutterwaveService.processRefund('1234567', 500, 'Customer request');

    const expected = 'flutterwave_not_configured: FLUTTERWAVE_SECRET_KEY is not set';
    expect(init).toEqual({ success: false, error: expected });
    expect(verify.error).toBe(expected);
    expect(query.error).toBe(expected);
    expect(refund.error).toBe(expected);
    expect(axiosPost).not.toHaveBeenCalled();
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('processes a refund only when Flutterwave accepts it', async () => {
    axiosPost.mockResolvedValueOnce({
      data: {
        status: 'success',
        message: 'Transaction refund initiated',
        data: { id: 998877, status: 'completed', amount_refunded: 500 },
      },
    });

    const result = await flutterwaveService.processRefund('1234567', 500, 'Customer request');

    expect(result.success).toBe(true);
    expect(result.refundId).toBe('998877');
    expect(axiosPost).toHaveBeenCalledWith(
      'https://api.flutterwave.com/v3/transactions/1234567/refund',
      { amount: 500, comments: 'Customer request' },
      expect.anything()
    );
  });
});

describe('PaymentGatewayService dispatch (paystack / flutterwave)', () => {
  const baseRequest = {
    phoneNumber: '08012345678',
    amount: 50000, // platform minor units: kobo for NGN
    currency: 'NGN' as const,
    accountReference: 'INV-3001',
    transactionDesc: 'Invoice payment',
    userId: 1,
    paymentType: 'invoice' as const,
    email: 'customer@example.ng',
    callbackUrl: 'https://vpp.example.ng/payments/callback',
  };

  it("routes 'paystack' initiation to the Paystack adapter, kobo unscaled", async () => {
    axiosPost.mockResolvedValueOnce({
      data: {
        status: true,
        message: 'Authorization URL created',
        data: { authorization_url: 'https://checkout.paystack.com/abc', access_code: 'abc', reference: 'PSK_REF_9' },
      },
    });

    const result = await paymentGatewayService.initiatePayment({ ...baseRequest, gateway: 'paystack' });

    expect(result.success).toBe(true);
    expect(result.paymentId).toBe(1);
    expect(result.transactionId).toBe('PSK_REF_9');

    // Platform amount is already kobo: Paystack sees 50000, NOT 500.
    expect(axiosPost).toHaveBeenCalledWith(
      'https://api.paystack.co/transaction/initialize',
      expect.objectContaining({ amount: 50000, reference: 'INV-3001', email: 'customer@example.ng' }),
      expect.anything()
    );
    // The payment row records the gateway and the reference as transactionId.
    expect(h.insertedValues[0]).toMatchObject({ paymentMethod: 'paystack', status: 'pending', amount: 50000 });
    expect(h.updates.some(u => u.transactionId === 'PSK_REF_9')).toBe(true);
    expect(h.updates.some(u => u.status === 'failed')).toBe(false);
  });

  it("routes 'flutterwave' initiation to the Flutterwave adapter, kobo -> naira", async () => {
    axiosPost.mockResolvedValueOnce({
      data: { status: 'success', message: 'Hosted Link', data: { link: 'https://checkout.flutterwave.com/xyz' } },
    });

    const result = await paymentGatewayService.initiatePayment({ ...baseRequest, gateway: 'flutterwave' });

    expect(result.success).toBe(true);
    expect(result.transactionId).toBe('INV-3001'); // tx_ref is the reconciliation handle

    // Flutterwave expects major units: 50000 kobo -> 500 naira.
    expect(axiosPost).toHaveBeenCalledWith(
      'https://api.flutterwave.com/v3/payments',
      expect.objectContaining({ tx_ref: 'INV-3001', amount: 500, currency: 'NGN' }),
      expect.anything()
    );
    expect(h.insertedValues[0]).toMatchObject({ paymentMethod: 'flutterwave', status: 'pending' });
    expect(h.updates.some(u => u.transactionId === 'INV-3001')).toBe(true);
  });

  it('marks the payment failed when the gateway refuses initiation', async () => {
    axiosPost.mockResolvedValueOnce({
      data: { status: false, message: 'Duplicate reference' },
    });

    const result = await paymentGatewayService.initiatePayment({ ...baseRequest, gateway: 'paystack' });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Duplicate reference');
    expect(h.updates.some(u => u.status === 'failed')).toBe(true);
  });

  it('queryPaymentStatus routes a pending paystack payment through verify', async () => {
    h.paymentRow = {
      id: 1,
      userId: 1,
      amount: 50000,
      currency: 'NGN',
      status: 'pending',
      paymentMethod: 'paystack',
      transactionId: 'PSK_REF_9',
      metadata: '{}',
    };
    axiosGet.mockResolvedValueOnce({
      data: {
        status: true,
        message: 'Verification successful',
        data: { status: 'success', reference: 'PSK_REF_9', amount: 50000 },
      },
    });

    const result = await paymentGatewayService.queryPaymentStatus(1);

    expect(result.success).toBe(true);
    expect(result.status).toBe('completed');
    expect(axiosGet).toHaveBeenCalledWith(
      'https://api.paystack.co/transaction/verify/PSK_REF_9',
      expect.anything()
    );
    expect(h.updates.some(u => u.status === 'completed')).toBe(true);
  });

  it('queryPaymentStatus routes flutterwave by tx_ref and persists the numeric transaction id', async () => {
    h.paymentRow = {
      id: 1,
      userId: 1,
      amount: 50000,
      currency: 'NGN',
      status: 'pending',
      paymentMethod: 'flutterwave',
      transactionId: 'INV-3001',
      metadata: '{"flutterwaveTxRef":"INV-3001"}',
    };
    axiosGet.mockResolvedValueOnce({
      data: {
        status: 'success',
        message: 'Transaction fetched successfully',
        data: { id: 555666, tx_ref: 'INV-3001', status: 'successful', amount: 500, currency: 'NGN' },
      },
    });

    const result = await paymentGatewayService.queryPaymentStatus(1);

    expect(result.success).toBe(true);
    expect(result.status).toBe('completed');
    expect(axiosGet).toHaveBeenCalledWith(
      'https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=INV-3001',
      expect.anything()
    );
    const completionUpdate = h.updates.find(u => u.status === 'completed');
    expect(completionUpdate).toBeDefined();
    expect(JSON.parse(completionUpdate!.metadata).flutterwaveTransactionId).toBe('555666');
  });

  it('refunds a completed paystack payment via POST /refund and marks it refunded', async () => {
    h.paymentRow = {
      id: 1,
      userId: 1,
      amount: 50000,
      currency: 'NGN',
      status: 'completed',
      paymentMethod: 'paystack',
      transactionId: 'PSK_REF_9',
      metadata: '{}',
    };
    axiosPost.mockResolvedValueOnce({
      data: { status: true, message: 'Refund has been queued', data: { id: 445566, status: 'pending' } },
    });

    const result = await paymentGatewayService.processRefund(1, 'Customer request');

    expect(result.success).toBe(true);
    expect(result.refundId).toBe('445566');
    expect(axiosPost).toHaveBeenCalledWith(
      'https://api.paystack.co/refund',
      { transaction: 'PSK_REF_9', merchant_note: 'Customer request' },
      expect.anything()
    );
    expect(h.updates.some(u => u.status === 'refunded')).toBe(true);
  });

  it('refunds a completed flutterwave payment only when the numeric transaction id was recorded', async () => {
    // Without the recorded Flutterwave transaction id the refund cannot be
    // gateway-confirmed: fail loud, flag manual review, never mark refunded.
    h.paymentRow = {
      id: 1,
      userId: 1,
      amount: 50000,
      currency: 'NGN',
      status: 'completed',
      paymentMethod: 'flutterwave',
      transactionId: 'INV-3001',
      metadata: '{}',
    };

    const unconfirmable = await paymentGatewayService.processRefund(1, 'Customer request');

    expect(unconfirmable.success).toBe(false);
    expect(unconfirmable.error).toContain('refund_not_supported');
    expect(axiosPost).not.toHaveBeenCalled();
    expect(h.updates.some(u => u.status === 'refunded')).toBe(false);

    // With the id recorded, the refund goes to /transactions/:id/refund in
    // major units (50000 kobo -> 500 naira) and the row is marked refunded.
    h.paymentRow = { ...h.paymentRow, metadata: '{"flutterwaveTransactionId":"555666"}' };
    h.updates.length = 0;
    axiosPost.mockResolvedValueOnce({
      data: { status: 'success', message: 'Transaction refund initiated', data: { id: 112233, status: 'completed' } },
    });

    const refunded = await paymentGatewayService.processRefund(1, 'Customer request');

    expect(refunded.success).toBe(true);
    expect(axiosPost).toHaveBeenCalledWith(
      'https://api.flutterwave.com/v3/transactions/555666/refund',
      { amount: 500, comments: 'Customer request' },
      expect.anything()
    );
    expect(h.updates.some(u => u.status === 'refunded')).toBe(true);
  });

  it('gateway-level initiation fails loud with no secret key and no network call', async () => {
    delete process.env.PAYSTACK_SECRET_KEY;

    const result = await paymentGatewayService.initiatePayment({ ...baseRequest, gateway: 'paystack' });

    expect(result.success).toBe(false);
    expect(result.error).toBe('paystack_not_configured: PAYSTACK_SECRET_KEY is not set');
    expect(axiosPost).not.toHaveBeenCalled();
    expect(h.updates.some(u => u.status === 'failed')).toBe(true);
  });
});
