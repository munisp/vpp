import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveWalletBalanceCents } from './services/energy-wallet';

describe('wallet arithmetic', () => {
  it('subtracts the invoice consumer share rather than the platform total value', () => {
    expect(
      deriveWalletBalanceCents({
        paymentsCompletedCents: 700,
        topUpsCompletedCents: 0,
        billingsPayableCents: 700,
        tokenPurchasesCents: 0,
      })
    ).toBe(0);
  });

  it('does not subtract token purchases twice from a completed-payment balance', () => {
    expect(
      deriveWalletBalanceCents({
        paymentsCompletedCents: 1_000,
        topUpsCompletedCents: 0,
        billingsPayableCents: 0,
        tokenPurchasesCents: 1_000,
      })
    ).toBe(0);
  });
});

describe('automatic top-up serialization', () => {
  it('uses a transaction-scoped per-user lock and preserves a pending-attempt state', () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, 'services/energy-wallet.ts'), 'utf8');
    expect(source).toContain('pg_advisory_xact_lock(${userId})');
    expect(source).toContain("${walletTopUpAttempts.triggerType} = 'auto'");
    expect(source).toContain("${walletTopUpAttempts.status} = 'initiated'");
    expect(source).toContain("reason: 'auto_top_up_pending'");
  });
});
