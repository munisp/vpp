/**
 * Pinning tests for P11: a self-referral is reward farming, not a referral.
 * applyReferralCode rejects the referrer referring their own account or their
 * own email address, and processReferralReward re-guards at payout time so a
 * self-referral that predates the apply-time guard still never pays.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

type Row = Record<string, unknown>;

interface Captured {
  updates: Row[];
  rewardInserts: Row[];
  transactions: number;
}

function mockDb(opts: { referral: Row | null; referrerEmail?: string | null }, captured: Captured) {
  const db = {
    select: (fields?: Row) => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            // The email lookup selects a projection; the referral lookup is select().
            if (fields && 'email' in fields) {
              return opts.referrerEmail != null ? [{ email: opts.referrerEmail }] : [];
            }
            return opts.referral ? [opts.referral] : [];
          },
        }),
      }),
    }),
    update: () => ({
      set: (values: Row) => ({
        where: async () => {
          captured.updates.push(values);
          return { rowCount: 1 };
        },
      }),
    }),
    insert: () => ({
      values: (values: Row) => ({
        returning: async () => {
          captured.rewardInserts.push(values);
          return [{ id: 9 }];
        },
      }),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      captured.transactions++;
      return fn(db);
    },
  };
  vi.doMock('./db', () => ({ getDb: async () => db }));
}

const pendingReferral: Row = {
  id: 3,
  referrerId: 7,
  referralCode: 'REF-7',
  refereeId: null,
  refereeEmail: null,
  status: 'pending',
  expiresAt: null,
  rewardType: 'credit',
  rewardAmount: 5000,
  rewardCurrency: 'TZS',
};

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('./db');
});

describe('applyReferralCode self-referral rejection (P11)', () => {
  it('rejects the referrer applying their own code to their own account', async () => {
    const captured: Captured = { updates: [], rewardInserts: [], transactions: 0 };
    mockDb({ referral: pendingReferral }, captured);
    const { applyReferralCode } = await import('./db-referrals');

    await expect(applyReferralCode('REF-7', 7)).rejects.toThrow(/cannot refer your own account/);
    expect(captured.updates).toHaveLength(0);
  });

  it("rejects the referee using the referrer's own email address (case-insensitive)", async () => {
    const captured: Captured = { updates: [], rewardInserts: [], transactions: 0 };
    mockDb({ referral: pendingReferral, referrerEmail: 'Ada@Example.com' }, captured);
    const { applyReferralCode } = await import('./db-referrals');

    await expect(applyReferralCode('REF-7', 8, ' ada@example.COM ')).rejects.toThrow(
      /belongs to this email address/
    );
    expect(captured.updates).toHaveLength(0);
  });

  it('still applies a genuine referral between two different users', async () => {
    const captured: Captured = { updates: [], rewardInserts: [], transactions: 0 };
    mockDb({ referral: pendingReferral, referrerEmail: 'ada@example.com' }, captured);
    const { applyReferralCode } = await import('./db-referrals');

    const referral = await applyReferralCode('REF-7', 8, 'bob@example.com');
    expect(referral.id).toBe(3);
    expect(captured.updates).toHaveLength(1);
    expect(captured.updates[0]).toMatchObject({ refereeId: 8, status: 'completed' });
  });
});

describe('processReferralReward re-guard (P11)', () => {
  it('refuses to pay a self-referral that predates the apply-time guard', async () => {
    const captured: Captured = { updates: [], rewardInserts: [], transactions: 0 };
    mockDb({ referral: { ...pendingReferral, refereeId: 7, status: 'completed' } }, captured);
    const { processReferralReward } = await import('./db-referrals');

    await expect(processReferralReward(3)).rejects.toThrow(/Self-referral is not rewardable/);
    expect(captured.transactions).toBe(0);
    expect(captured.rewardInserts).toHaveLength(0);
  });

  it('pays a genuine referral exactly once through the claim transaction', async () => {
    const captured: Captured = { updates: [], rewardInserts: [], transactions: 0 };
    mockDb({ referral: { ...pendingReferral, refereeId: 8, status: 'completed' } }, captured);
    const { processReferralReward } = await import('./db-referrals');

    const reward = await processReferralReward(3);
    expect(reward).toMatchObject({ id: 9, amount: 5000, currency: 'TZS' });
    expect(captured.rewardInserts).toHaveLength(1);
    expect(captured.rewardInserts[0]).toMatchObject({ referralId: 3, userId: 7, status: 'pending' });
  });
});
