/**
 * Pinning test for the double-refund race (server/services/payment-gateway-service.ts):
 *
 *  F5  processRefund claims the payment atomically: the row is locked FOR
 *      UPDATE inside one transaction for the whole refund. Two concurrent
 *      refund calls against the same completed payment result in exactly ONE
 *      gateway refund; the loser is refused with an already-refunded reason.
 */

import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => {
  const row: any = {
    id: 9,
    status: 'completed',
    amount: 50000,
    currency: 'NGN',
    paymentMethod: 'paystack',
    transactionId: 'PSK_9',
    billingId: null,
    metadata: '{}',
  };
  return {
    row,
    refundCalls: [] as Array<{ reference: string; reason: string }>,
    refundGate: null as null | (() => void),
  };
});

vi.mock('../db', () => {
  // Serialize transactions like the row lock does: a second refund blocks
  // until the first commits, then observes the committed status.
  let chain: Promise<void> = Promise.resolve();
  return {
    getDb: vi.fn(() =>
      Promise.resolve({
        transaction: vi.fn(async (fn: (tx: any) => Promise<unknown>) => {
          const previous = chain;
          let release!: () => void;
          chain = new Promise<void>(r => (release = r));
          await previous;
          try {
            return await fn({
              execute: vi.fn(() => Promise.resolve({ rows: [{ ...h.row }] })),
              update: vi.fn(() => ({
                set: vi.fn((values: any) => ({
                  where: vi.fn(() => {
                    if (values.status) h.row.status = values.status;
                    if (values.metadata) h.row.metadata = values.metadata;
                    return Promise.resolve({ rowCount: 1 });
                  }),
                })),
              })),
            });
          } finally {
            release();
          }
        }),
      })
    ),
  };
});

vi.mock('./degraded-operation', async () => {
  const actual = await vi.importActual<typeof import('./degraded-operation')>('./degraded-operation');
  return {
    ...actual,
    requireCapability: vi.fn(async () => ({ posture: 'available', missing: [], evidenceLimit: null })),
    observing: vi.fn(async (_input: unknown, call: () => Promise<unknown>) => call()),
  };
});

vi.mock('./paystack-service', () => ({
  paystackService: {
    processRefund: vi.fn(async (reference: string, reason: string) => {
      h.refundCalls.push({ reference, reason });
      // Hold the gateway response until the test releases it — this is the
      // window in which the second refund arrives.
      await new Promise<void>(resolve => {
        h.refundGate = resolve;
      });
      return { success: true, refundId: '445566', message: 'Refund has been queued' };
    }),
  },
}));

vi.mock('./mpesa-service', () => ({ mpesaService: {} }));
vi.mock('./airtel-money-service', () => ({ airtelMoneyService: {} }));
vi.mock('./tigo-pesa-service', () => ({ tigoPesaService: {} }));
vi.mock('./flutterwave-service', () => ({ flutterwaveService: {} }));

import { paymentGatewayService } from './payment-gateway-service';

describe('F5: double-refund race', () => {
  it('two concurrent refunds → exactly one gateway refund, one refusal', async () => {
    const first = paymentGatewayService.processRefund(9, 'duplicate test');

    // Wait until the first refund is inside the gateway call (lock held).
    await vi.waitFor(() => expect(h.refundCalls).toHaveLength(1));

    const second = paymentGatewayService.processRefund(9, 'duplicate test');
    // Release the gateway; the first refund commits 'refunded', then the
    // second observes the terminal state.
    h.refundGate!();

    const [r1, r2] = await Promise.all([first, second]);

    expect(h.refundCalls).toHaveLength(1); // gateway charged exactly once
    const outcomes = [r1, r2].map(r => r.success);
    expect(outcomes).toContain(true);
    expect(outcomes).toContain(false);
    const loser = [r1, r2].find(r => !r.success)!;
    expect(loser.error).toMatch(/already refunded/);
    expect(h.row.status).toBe('refunded');
  });
});
