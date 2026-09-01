/**
 * Pinning tests for the energy wallet (server/services/energy-wallet.ts):
 *
 *  F7  Balance formula consistency: the wallet holds the CONSUMER's money, so
 *      billings subtract the consumer share — never the gross totalValue that
 *      includes the 30% platform commission (routers/payments.ts getBalance
 *      uses the same convention).
 *  F8  Auto top-up double-charge: concurrent triggers are serialized by an
 *      in-flight guard; the second trigger is refused with
 *      'already_in_progress' and the gateway is asked exactly once.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const h = vi.hoisted(() => ({
  payments: { completed: 0, tokenPurchases: 0 },
  billings: [] as Array<{ totalValue: number; consumerShare: number; status: string }>,
  topUpsCompleted: 0,
  attempts: [] as Array<{ id: number; status: string }>,
  gatewayCalls: 0,
  gatewayGate: null as null | (() => void),
  nextAttemptId: 100,
  lastSnapshot: null as any,
}));

const dialect = new PgDialect();
function sqlText(q: any): string {
  return dialect.sqlToQuery(q).sql;
}

vi.mock('../db', () => {
  // Serialize transactions like pg_advisory_xact_lock does.
  let chain: Promise<void> = Promise.resolve();
  return {
    getDb: vi.fn(() =>
      Promise.resolve({
        execute: vi.fn((query: any) => {
          const text = sqlText(query);
          if (text.includes('FROM payments')) {
            return Promise.resolve({
              rows: [{ completed_cents: h.payments.completed, token_purchases_cents: h.payments.tokenPurchases }],
            });
          }
          if (text.includes('FROM billings')) {
            // Honor the column the query actually sums, so the test proves
            // WHICH convention the code uses.
            const useConsumerShare = text.includes('"consumerShare"');
            const total = h.billings
              .filter(b => ['issued', 'paid', 'overdue'].includes(b.status))
              .reduce((sum, b) => sum + (useConsumerShare ? b.consumerShare : b.totalValue), 0);
            return Promise.resolve({ rows: [{ issued_cents: total }] });
          }
          if (text.includes('wallet_top_up_attempts')) {
            return Promise.resolve({ rows: [{ completed_cents: h.topUpsCompleted }] });
          }
          return Promise.resolve({ rows: [] });
        }),
        insert: vi.fn(() => ({
          values: vi.fn((values: any) => {
            h.lastSnapshot = { id: 1, createdAt: new Date(), ...values };
            return {
              returning: vi.fn(() => Promise.resolve([{ id: 1 }])),
              onConflictDoUpdate: vi.fn(() => Promise.resolve()),
              then: (resolve: any) => resolve(undefined),
            };
          }),
        })),
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => Promise.resolve([h.lastSnapshot])),
            })),
          })),
        })),
        transaction: vi.fn(async (fn: (tx: any) => Promise<unknown>) => {
          const previous = chain;
          let release!: () => void;
          chain = new Promise<void>(r => (release = r));
          await previous;
          try {
            return await fn({
              execute: vi.fn(() => Promise.resolve({ rows: [] })),
              select: vi.fn(() => ({
                from: vi.fn(() => ({
                  where: vi.fn(() => ({
                    limit: vi.fn(() =>
                      Promise.resolve(h.attempts.filter(a => a.status === 'initiated'))
                    ),
                  })),
                })),
              })),
              insert: vi.fn(() => ({
                values: vi.fn((values: any) => {
                  const id = h.nextAttemptId++;
                  h.attempts.push({ id, status: values.status });
                  return {
                    returning: vi.fn(() => Promise.resolve([{ id }])),
                    then: (resolve: any) => resolve(undefined),
                  };
                }),
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

vi.mock('../_core/paymentGateway', () => ({
  initiateMpesaPayment: vi.fn(async () => {
    h.gatewayCalls++;
    await new Promise<void>(resolve => {
      h.gatewayGate = resolve;
    });
    return { success: true, transactionId: 'mr_topup_1', message: 'sent' };
  }),
  initiateAirtelPayment: vi.fn(),
  initiateTigoPesaPayment: vi.fn(),
  verifyPaymentStatus: vi.fn(),
}));

import { EnergyWalletService } from './energy-wallet';

beforeEach(() => {
  h.payments = { completed: 0, tokenPurchases: 0 };
  h.billings = [];
  h.topUpsCompleted = 0;
  h.attempts = [];
  h.gatewayCalls = 0;
  h.gatewayGate = null;
  h.nextAttemptId = 100;
});

describe('F7: wallet balance uses the consumer share consistently', () => {
  it('a payment covering the consumer share settles the wallet to zero, not negative', async () => {
    // Invoice: 1,000,000 cents gross, of which the consumer owes 700,000 and
    // the platform commission is 300,000. The consumer paid their share.
    h.billings = [{ totalValue: 1000000, consumerShare: 700000, status: 'issued' }];
    h.payments = { completed: 700000, tokenPurchases: 0 };

    const wallet = new EnergyWalletService();
    const snapshot = await wallet.computeBalanceSnapshot(42, 'test');

    // Consumer-share convention: 700000 paid - 700000 owed = 0.
    // The old totalValue convention would report -300000: the consumer would
    // be told they owe the platform's commission too.
    expect(snapshot.balanceCents).toBe(0);
  });

  it('credits completed top-ups and debits token purchases', async () => {
    h.billings = [{ totalValue: 100000, consumerShare: 70000, status: 'issued' }];
    h.payments = { completed: 50000, tokenPurchases: 20000 };
    h.topUpsCompleted = 100000;

    const wallet = new EnergyWalletService();
    const snapshot = await wallet.computeBalanceSnapshot(42, 'test');

    // 50000 + 100000 - 70000 - 20000 = 60000
    expect(snapshot.balanceCents).toBe(60000);
  });
});

describe('F8: auto top-up in-flight guard', () => {
  it('two concurrent triggers → one gateway charge, one already_in_progress refusal', async () => {
    const wallet = new EnergyWalletService();

    const first = wallet.initiateTopUp(42, 500000, 'mpesa', '+255700000001', 'auto');

    // Wait until the first trigger is inside the gateway call (lock held).
    await vi.waitFor(() => expect(h.gatewayCalls).toBe(1));

    const second = wallet.initiateTopUp(42, 500000, 'mpesa', '+255700000001', 'auto');
    h.gatewayGate!();

    const [r1, r2] = await Promise.all([first, second]);

    expect(h.gatewayCalls).toBe(1); // customer charged exactly once
    const results = [r1, r2];
    expect(results.some(r => r.topUpInitiated)).toBe(true);
    const loser = results.find(r => !r.topUpInitiated)!;
    expect(loser.reason).toBe('already_in_progress');
    expect(loser.attemptId).toBeDefined();
  });
});
