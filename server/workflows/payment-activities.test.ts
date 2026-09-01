/**
 * Pinning tests for the Temporal payment activities (server/workflows/payment-activities.ts):
 *
 *  F2  processPayment must not double-initiate: when the caller already
 *      initiated the charge (paymentId present), the workflow adopts that
 *      payment — no second gateway charge, no second payment row. When the
 *      activity does insert a row, the amount is stored in the canonical
 *      minor units (cents), never amount*100.
 *      updatePaymentStatusActivity has a legal-transition guard: a terminal
 *      payment (completed/failed/refunded) cannot be moved, an unknown
 *      transaction fails loud, and a concurrent transition is refused.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  state: {
    selectQueue: [] as any[][],
    paymentInserts: [] as any[],
    updates: [] as Array<{ table: any; values: any }>,
    updateRowCount: 1,
    events: [] as any[],
  },
}));

function makeTx(state = h.state) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(state.selectQueue.shift() ?? [])),
        })),
      })),
    })),
    insert: vi.fn((table: any) => ({
      values: vi.fn((values: any) => {
        state.paymentInserts.push(values);
        return Promise.resolve();
      }),
    })),
    update: vi.fn((table: any) => ({
      set: vi.fn((values: any) => ({
        where: vi.fn(() => {
          state.updates.push({ table, values });
          return Promise.resolve({ rowCount: state.updateRowCount });
        }),
      })),
    })),
  };
}

vi.mock('../db', () => ({
  getDb: vi.fn(() =>
    Promise.resolve({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve(h.state.selectQueue.shift() ?? [])),
            then: (resolve: any) => resolve(h.state.selectQueue.shift() ?? []),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => Promise.resolve()),
      })),
      update: vi.fn((table: any) => ({
        set: vi.fn((values: any) => ({
          where: vi.fn(() => {
            h.state.updates.push({ table, values });
            return Promise.resolve({ rowCount: h.state.updateRowCount });
          }),
        })),
      })),
      transaction: vi.fn(async (fn: (tx: any) => Promise<unknown>) => fn(makeTx())),
    })
  ),
}));

vi.mock('../payment-gateways', () => ({
  PaymentGatewayManager: {
    initiatePayment: vi.fn(),
    queryPaymentStatus: vi.fn(),
  },
}));

vi.mock('../services/events/outbox', () => ({
  enqueueEvent: vi.fn((_tx: any, event: any) => {
    h.state.events.push(event);
    return Promise.resolve();
  }),
}));

vi.mock('../services/payment-gateway-service', () => ({
  paymentGatewayService: { processRefund: vi.fn() },
}));

vi.mock('../_core/sendNotification', () => ({
  sendPushNotification: vi.fn(() => Promise.resolve({ success: true })),
}));

import { PaymentGatewayManager } from '../payment-gateways';
import { payments, billings } from '../../drizzle/schema';
import {
  initiatePaymentActivity,
  updatePaymentStatusActivity,
  updateBillingStatusActivity,
} from './payment-activities';

const mockInitiate = vi.mocked(PaymentGatewayManager.initiatePayment);
const mockQueryStatus = vi.mocked(PaymentGatewayManager.queryPaymentStatus);

const pendingPayment = {
  id: 501,
  userId: 42,
  billingId: 7,
  paymentType: 'invoice',
  amount: 500000,
  currency: 'TZS',
  paymentMethod: 'mpesa',
  status: 'pending',
  transactionId: 'mr_1',
  metadata: '{}',
};

beforeEach(() => {
  h.state.selectQueue = [];
  h.state.paymentInserts = [];
  h.state.updates = [];
  h.state.events = [];
  h.state.updateRowCount = 1;
  vi.clearAllMocks();
});

describe('initiatePaymentActivity', () => {
  it('adopts the caller-initiated payment instead of charging again', async () => {
    h.state.selectQueue = [[pendingPayment]];

    const result = await initiatePaymentActivity({
      userId: 42,
      billingId: 7,
      amount: 500000,
      gateway: 'mpesa',
      phoneNumber: '+255700000001',
      paymentId: 501,
    });

    expect(result).toEqual({ success: true, transactionId: 'mr_1' });
    expect(mockInitiate).not.toHaveBeenCalled();
    expect(h.state.paymentInserts).toHaveLength(0);
  });

  it('refuses to adopt a payment that is not pending (no double processing)', async () => {
    h.state.selectQueue = [[{ ...pendingPayment, status: 'completed' }]];

    const result = await initiatePaymentActivity({
      userId: 42, billingId: 7, amount: 500000,
      gateway: 'mpesa', phoneNumber: '+255700000001', paymentId: 501,
    });

    expect(result.success).toBe(false);
    expect(mockInitiate).not.toHaveBeenCalled();
  });

  it('inserts exactly one payment row with the amount in cents (no 100x inflation)', async () => {
    mockInitiate.mockResolvedValueOnce({
      success: true,
      transactionId: 'mr_9',
      message: 'Payment request sent',
    } as any);
    h.state.selectQueue = [[]]; // duplicate check inside the tx

    const result = await initiatePaymentActivity({
      userId: 42, billingId: 7, amount: 500000,
      gateway: 'mpesa', phoneNumber: '+255700000001',
    });

    expect(result).toEqual({ success: true, transactionId: 'mr_9' });
    expect(h.state.paymentInserts).toHaveLength(1);
    expect(h.state.paymentInserts[0].amount).toBe(500000); // cents, unchanged
    expect(h.state.paymentInserts[0].status).toBe('pending');
    expect(h.state.events.some(e => e.topic && e.eventKey === 'payment.initiated:mr_9')).toBe(true);
  });

  it('a retried activity does not insert a second row for the same charge', async () => {
    mockInitiate.mockResolvedValueOnce({
      success: true, transactionId: 'mr_9', message: 'sent',
    } as any);
    h.state.selectQueue = [[{ id: 501 }]]; // row already exists from the first attempt

    const result = await initiatePaymentActivity({
      userId: 42, billingId: 7, amount: 500000,
      gateway: 'mpesa', phoneNumber: '+255700000001',
    });

    expect(result.success).toBe(true);
    expect(h.state.paymentInserts).toHaveLength(0);
  });
});

describe('updatePaymentStatusActivity transition guard', () => {
  it('moves a pending payment to completed and emits the event atomically', async () => {
    h.state.selectQueue = [[pendingPayment]];

    await updatePaymentStatusActivity('mr_1', 'completed', { amount: 500000, gateway: 'mpesa' });

    const update = h.state.updates.find(u => u.table === payments);
    expect(update?.values.status).toBe('completed');
    expect(h.state.events.some(e => e.eventKey === 'payment.completed:mr_1:completed')).toBe(true);
  });

  it.each(['completed', 'failed', 'refunded'])(
    'refuses to move a %s payment',
    async (status) => {
      h.state.selectQueue = [[{ ...pendingPayment, status }]];

      await expect(
        updatePaymentStatusActivity('mr_1', status === 'completed' ? 'failed' : 'completed')
      ).rejects.toThrow(/ILLEGAL_PAYMENT_TRANSITION/);
      expect(h.state.updates.find(u => u.table === payments)).toBeUndefined();
    }
  );

  it('fails loud when no payment exists for the transaction', async () => {
    h.state.selectQueue = [[]];

    await expect(
      updatePaymentStatusActivity('ghost', 'completed')
    ).rejects.toThrow(/PAYMENT_NOT_FOUND/);
  });

  it('is idempotent when the target status is already recorded', async () => {
    h.state.selectQueue = [[{ ...pendingPayment, status: 'completed' }]];

    await expect(
      updatePaymentStatusActivity('mr_1', 'completed')
    ).resolves.toBeUndefined();
    expect(h.state.updates.find(u => u.table === payments)).toBeUndefined();
  });

  it('refuses when a concurrent path transitioned the row first', async () => {
    h.state.selectQueue = [[pendingPayment]];
    h.state.updateRowCount = 0; // row left 'pending' between check and update

    await expect(
      updatePaymentStatusActivity('mr_1', 'completed')
    ).rejects.toThrow(/CONCURRENT_PAYMENT_TRANSITION/);
  });
});

describe('updateBillingStatusActivity coverage guard', () => {
  it('marks a covered invoice paid', async () => {
    h.state.selectQueue = [
      [{ id: 7, consumerShare: 500000, status: 'issued' }],
      [{ total: 500000 }],
    ];

    await updateBillingStatusActivity(7, 'paid');

    expect(h.state.updates.find(u => u.table === billings)?.values.status).toBe('paid');
  });

  it('refuses to mark an under-covered invoice paid', async () => {
    h.state.selectQueue = [
      [{ id: 7, consumerShare: 500000, status: 'issued' }],
      [{ total: 300000 }],
    ];

    await expect(updateBillingStatusActivity(7, 'paid')).rejects.toThrow(/BILLING_UNDERPAID/);
    expect(h.state.updates.find(u => u.table === billings)).toBeUndefined();
  });
});

describe('processPayment workflow (proxied activities run for real)', () => {
  it('adopts the caller-initiated payment: no second charge, no second row, correct amount', async () => {
    vi.resetModules();
    // Run the workflow with the REAL activities through the proxy seam.
    vi.doMock('@temporalio/workflow', () => ({
      proxyActivities: <T>(_opts: unknown): T => activities as T,
      sleep: vi.fn(() => Promise.resolve()),
    }));
    const activities = await import('./payment-activities');
    const { processPayment } = await import('./payment-workflow');

    mockQueryStatus.mockResolvedValue({ status: 'completed' } as any);

    // Query order: adopt (payments), status-update load (payments),
    // billing load (billings), coverage SUM (payments).
    h.state.selectQueue = [
      [pendingPayment],
      [pendingPayment],
      [{ id: 7, consumerShare: 500000, status: 'issued' }],
      [{ total: 500000 }],
    ];

    const result = await processPayment({
      paymentId: 501 as any, // the Temporal client passes ids as strings
      userId: '42' as any,
      billingId: undefined as any,
      amount: 500000,
      gateway: 'mpesa',
      phoneNumber: undefined as any,
      metadata: { billingId: 7 },
    });

    expect(result.success).toBe(true);
    expect(result.transactionId).toBe('mr_1');
    expect(mockInitiate).not.toHaveBeenCalled(); // no double charge
    expect(h.state.paymentInserts).toHaveLength(0); // no second row
    // NOTE: the workflow runs on a fresh module registry (resetModules), so
    // drizzle table identity differs; match updates by what they wrote.
    expect(h.state.updates.some(u => u.values.status === 'completed')).toBe(true);
    expect(h.state.updates.some(u => u.values.status === 'paid')).toBe(true);

    vi.doUnmock('@temporalio/workflow');
  });
});
