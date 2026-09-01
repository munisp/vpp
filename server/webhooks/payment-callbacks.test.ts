/**
 * Pinning tests for payment gateway webhooks (server/webhooks/payment-callbacks.ts):
 *
 *  F1  M-Pesa STK success callback settles the payment. At initiation the
 *      stored transactionId is the MerchantRequestID/CheckoutRequestID; the
 *      success callback carries the MpesaReceiptNumber. The callback must
 *      resolve the payment through the checkout reference and settle exactly
 *      that payment, recording the receipt as the transactionId.
 *  F4  A partial payment must NOT settle the full invoice: the billing is
 *      marked paid only when completed payments cover the consumer share.
 *  F6  Paystack (HMAC-SHA512 x-paystack-signature) and Flutterwave
 *      (verif-hash) webhooks: valid signature settles, bad signature is
 *      rejected, and an unset secret refuses the webhook loudly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'crypto';

// ---------------------------------------------------------------------------
// Stateful fake DB. select() pops results from a queue (one per select call,
// matching the code's fixed query order); update() records set-values per
// table so tests can distinguish payment updates from billing updates.
// ---------------------------------------------------------------------------

interface FakeState {
  selectQueue: any[][];
  updates: Array<{ table: any; values: any }>;
  updateRowCount: number;
  inserts: Array<{ table: any; values: any }>;
}

const h = vi.hoisted(() => {
  const state = {
    selectQueue: [] as any[][],
    updates: [] as Array<{ table: any; values: any }>,
    updateRowCount: 1,
    inserts: [] as Array<{ table: any; values: any }>,
  };
  return { state };
});

vi.mock('../db', () => ({
  getDb: vi.fn(() =>
    Promise.resolve({
      insert: vi.fn((table: any) => ({
        values: vi.fn((values: any) => {
          h.state.inserts.push({ table, values });
          return {
            returning: vi.fn(() => Promise.resolve([{ id: 1 }])),
            then: (resolve: any) => resolve(undefined),
          };
        }),
      })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve(h.state.selectQueue.shift() ?? [])),
            // settleBillingIfCovered's SUM query awaits the where() directly
            then: (resolve: any) => resolve(h.state.selectQueue.shift() ?? []),
          })),
        })),
      })),
      update: vi.fn((table: any) => ({
        set: vi.fn((values: any) => ({
          where: vi.fn(() => {
            h.state.updates.push({ table, values });
            return Promise.resolve({ rowCount: h.state.updateRowCount });
          }),
        })),
      })),
    })
  ),
}));

// Gateway parsing is the adapters' job (covered elsewhere); here the manager
// returns the callback payload the test sets.
vi.mock('../payment-gateways', () => ({
  PaymentGatewayManager: {
    processCallback: vi.fn(),
  },
}));

vi.mock('../_core/sendNotification', () => ({
  sendPushNotification: vi.fn(() => Promise.resolve({ success: true })),
}));

vi.mock('../services/prepaid-issuance-entry', () => ({
  issuePrepaidTokenForPayment: vi.fn(() => Promise.resolve({ issued: false, reason: 'no prepaid account', retryScheduled: false })),
}));

vi.mock('../services/paystack-service', () => ({
  paystackService: {
    queryPaymentStatus: vi.fn(),
  },
}));

vi.mock('../services/flutterwave-service', () => ({
  flutterwaveService: {
    verifyTransaction: vi.fn(),
    queryPaymentStatus: vi.fn(),
  },
}));

import { payments, billings } from '../../drizzle/schema';
import { PaymentGatewayManager } from '../payment-gateways';
import { paystackService } from '../services/paystack-service';
import { flutterwaveService } from '../services/flutterwave-service';
import {
  handleMpesaCallback,
  handlePaystackCallback,
  handleFlutterwaveCallback,
} from './payment-callbacks';

const mockProcessCallback = vi.mocked(PaymentGatewayManager.processCallback);
const mockPaystackQuery = vi.mocked(paystackService.queryPaymentStatus);
const mockFlutterwaveVerify = vi.mocked(flutterwaveService.verifyTransaction);

function fakeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined as any,
  };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: any) => {
    res.body = body;
    return res;
  });
  return res;
}

function fakeReq(body: any, headers: Record<string, string> = {}) {
  return {
    body,
    header: (name: string) => headers[name.toLowerCase()],
  } as any;
}

const pendingMpesaPayment = {
  id: 501,
  userId: 42,
  billingId: 7,
  paymentType: 'invoice',
  amount: 500000, // cents
  currency: 'KES',
  paymentMethod: 'mpesa',
  status: 'pending',
  transactionId: 'merchant-1', // MerchantRequestID stored at initiation
  metadata: JSON.stringify({ gatewayReference: 'ws_CO_1', merchantRequestId: 'merchant-1' }),
};

function mpesaStkBody(receipt: string) {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: 'merchant-1',
        CheckoutRequestID: 'ws_CO_1',
        ResultCode: 0,
        ResultDesc: 'The service request is processed successfully.',
        CallbackMetadata: {
          Item: [
            { Name: 'Amount', Value: 5000 },
            { Name: 'MpesaReceiptNumber', Value: receipt },
            { Name: 'PhoneNumber', Value: 254700000000 },
          ],
        },
      },
    },
  };
}

beforeEach(() => {
  h.state.selectQueue = [];
  h.state.updates = [];
  h.state.inserts = [];
  h.state.updateRowCount = 1;
  vi.clearAllMocks();
});

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('F1: M-Pesa STK success callback settles the initiated payment', () => {
  it('resolves by CheckoutRequestID and settles exactly the right payment', async () => {
    mockProcessCallback.mockResolvedValueOnce({
      transactionId: 'RCPT-ABC-1', // MpesaReceiptNumber — NOT what initiation stored
      checkoutRequestId: 'ws_CO_1',
      amount: 500000, // cents, normalized by the adapter
      phoneNumber: '254700000000',
      status: 'completed',
      resultCode: '0',
      resultDesc: 'Success',
      metadata: { MpesaReceiptNumber: 'RCPT-ABC-1', Amount: 5000 },
    } as any);

    // Query order: 1) direct transactionId lookup misses (receipt unknown at
    // initiation), 2) checkout-reference lookup hits, 3) billing row,
    // 4) SUM(completed payments) for coverage.
    h.state.selectQueue = [
      [],
      [pendingMpesaPayment],
      [{ id: 7, userId: 42, consumerShare: 500000, status: 'issued' }],
      [{ total: 500000 }],
    ];

    const res = fakeRes();
    await handleMpesaCallback(fakeReq(mpesaStkBody('RCPT-ABC-1')), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ResultCode: 0 });

    // Exactly the resolved payment was settled, with the receipt recorded as
    // the transactionId and persisted for later reversals.
    const paymentUpdate = h.state.updates.find(u => u.table === payments && u.values.status === 'completed');
    expect(paymentUpdate).toBeDefined();
    expect(paymentUpdate!.values.transactionId).toBe('RCPT-ABC-1');
    expect(JSON.parse(paymentUpdate!.values.metadata).mpesaReceiptNumber).toBe('RCPT-ABC-1');

    // Full coverage → the invoice is paid.
    const billingUpdate = h.state.updates.find(u => u.table === billings);
    expect(billingUpdate?.values.status).toBe('paid');
  });

  it('still does not settle when no reference matches', async () => {
    mockProcessCallback.mockResolvedValueOnce({
      transactionId: 'RCPT-UNKNOWN',
      checkoutRequestId: 'ws_CO_unknown',
      amount: 500000,
      status: 'completed',
      resultCode: '0',
      metadata: {},
    } as any);

    h.state.selectQueue = [[], [], []];

    const res = fakeRes();
    await handleMpesaCallback(fakeReq(mpesaStkBody('RCPT-UNKNOWN')), res);

    expect(h.state.updates.find(u => u.table === payments && u.values.status === 'completed')).toBeUndefined();
    expect(h.state.updates.find(u => u.table === billings)).toBeUndefined();
  });
});

describe('F4: partial payment does not settle the full invoice (webhook path)', () => {
  it('leaves the invoice issued when completed payments under-cover the consumer share', async () => {
    const partialPayment = { ...pendingMpesaPayment, amount: 300000 };
    mockProcessCallback.mockResolvedValueOnce({
      transactionId: 'RCPT-PARTIAL',
      checkoutRequestId: 'ws_CO_1',
      amount: 300000,
      status: 'completed',
      resultCode: '0',
      metadata: { MpesaReceiptNumber: 'RCPT-PARTIAL' },
    } as any);

    h.state.selectQueue = [
      [],
      [partialPayment],
      [{ id: 7, userId: 42, consumerShare: 500000, status: 'issued' }],
      [{ total: 300000 }], // only the partial payment completed so far
    ];

    const res = fakeRes();
    await handleMpesaCallback(fakeReq(mpesaStkBody('RCPT-PARTIAL')), res);

    // The payment itself settles (real money arrived)…
    expect(h.state.updates.some(u => u.table === payments && u.values.status === 'completed')).toBe(true);
    // …but the invoice is NOT marked paid.
    expect(h.state.updates.find(u => u.table === billings && u.values.status === 'paid')).toBeUndefined();
  });

  it('marks the invoice paid once completed payments cover the consumer share', async () => {
    mockProcessCallback.mockResolvedValueOnce({
      transactionId: 'RCPT-FINAL',
      checkoutRequestId: 'ws_CO_1',
      amount: 500000,
      status: 'completed',
      resultCode: '0',
      metadata: { MpesaReceiptNumber: 'RCPT-FINAL' },
    } as any);

    h.state.selectQueue = [
      [],
      [pendingMpesaPayment],
      [{ id: 7, userId: 42, consumerShare: 500000, status: 'issued' }],
      [{ total: 500000 }], // completed payments now cover the invoice
    ];

    const res = fakeRes();
    await handleMpesaCallback(fakeReq(mpesaStkBody('RCPT-FINAL')), res);

    expect(h.state.updates.find(u => u.table === billings)?.values.status).toBe('paid');
  });
});

describe('F6: Paystack webhook', () => {
  const body = {
    event: 'charge.success',
    data: { reference: 'PSK_REF_1', amount: 50000, status: 'success' },
  };

  function signedReq(payload: any, secret: string) {
    const raw = JSON.stringify(payload);
    const signature = createHmac('sha512', secret).update(raw, 'utf8').digest('hex');
    return fakeReq(payload, { 'x-paystack-signature': signature });
  }

  it('settles the payment on a valid signature and gateway-confirmed charge', async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_secret';
    mockPaystackQuery.mockResolvedValueOnce({
      success: true,
      status: 'completed',
      amount: 50000, // kobo == platform minor units
    } as any);

    h.state.selectQueue = [
      [{
        id: 601, userId: 42, billingId: null, paymentType: 'invoice',
        amount: 50000, currency: 'NGN', paymentMethod: 'paystack',
        status: 'pending', transactionId: 'PSK_REF_1', metadata: '{}',
      }],
    ];

    const res = fakeRes();
    await handlePaystackCallback(signedReq(body, 'sk_test_secret'), res);

    expect(res.statusCode).toBe(200);
    const paymentUpdate = h.state.updates.find(u => u.table === payments && u.values.status === 'completed');
    expect(paymentUpdate).toBeDefined();
  });

  it('rejects a bad signature without touching the database', async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_secret';

    const res = fakeRes();
    await handlePaystackCallback(fakeReq(body, { 'x-paystack-signature': 'deadbeef' }), res);

    expect(res.statusCode).toBe(401);
    expect(h.state.updates).toHaveLength(0);
    expect(mockPaystackQuery).not.toHaveBeenCalled();
  });

  it('refuses the webhook loudly when PAYSTACK_SECRET_KEY is unset', async () => {
    delete process.env.PAYSTACK_SECRET_KEY;

    const res = fakeRes();
    await handlePaystackCallback(fakeReq(body, { 'x-paystack-signature': 'whatever' }), res);

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe('PAYSTACK_NOT_CONFIGURED');
    expect(h.state.updates).toHaveLength(0);
  });

  it('does not settle when the gateway does not confirm the charge', async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_secret';
    mockPaystackQuery.mockResolvedValueOnce({ success: true, status: 'failed' } as any);

    const res = fakeRes();
    await handlePaystackCallback(signedReq(body, 'sk_test_secret'), res);

    expect(res.statusCode).toBe(200);
    expect(h.state.updates.find(u => u.table === payments && u.values.status === 'completed')).toBeUndefined();
  });
});

describe('F6: Flutterwave webhook', () => {
  const body = {
    event: 'charge.completed',
    data: { id: 444555, tx_ref: 'PAY-9', status: 'successful', amount: 500 },
  };

  it('settles the payment on a valid verif-hash and gateway-confirmed charge', async () => {
    process.env.FLUTTERWAVE_SECRET_HASH = 'flw_hash_secret';
    mockFlutterwaveVerify.mockResolvedValueOnce({
      success: true,
      status: 'completed',
      amount: 500, // major units (naira) — scaled once by the handler
      transactionId: '444555',
    } as any);

    h.state.selectQueue = [
      [{
        id: 602, userId: 42, billingId: null, paymentType: 'invoice',
        amount: 50000, currency: 'NGN', paymentMethod: 'flutterwave',
        status: 'pending', transactionId: 'PAY-9', metadata: '{}',
      }],
    ];

    const res = fakeRes();
    await handleFlutterwaveCallback(fakeReq(body, { 'verif-hash': 'flw_hash_secret' }), res);

    expect(res.statusCode).toBe(200);
    const paymentUpdate = h.state.updates.find(u => u.table === payments && u.values.status === 'completed');
    expect(paymentUpdate).toBeDefined();
    // The numeric transaction id is persisted for later refunds.
    expect(JSON.parse(paymentUpdate!.values.metadata).flutterwaveTransactionId).toBe('444555');
  });

  it('rejects a bad verif-hash without touching the database', async () => {
    process.env.FLUTTERWAVE_SECRET_HASH = 'flw_hash_secret';

    const res = fakeRes();
    await handleFlutterwaveCallback(fakeReq(body, { 'verif-hash': 'wrong' }), res);

    expect(res.statusCode).toBe(401);
    expect(h.state.updates).toHaveLength(0);
    expect(mockFlutterwaveVerify).not.toHaveBeenCalled();
  });

  it('refuses the webhook loudly when FLUTTERWAVE_SECRET_HASH is unset', async () => {
    delete process.env.FLUTTERWAVE_SECRET_HASH;

    const res = fakeRes();
    await handleFlutterwaveCallback(fakeReq(body, { 'verif-hash': 'whatever' }), res);

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe('FLUTTERWAVE_NOT_CONFIGURED');
    expect(h.state.updates).toHaveLength(0);
  });
});
