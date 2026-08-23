/**
 * The ledger wording is the last line between "we cannot see this money" and a
 * screen that reads settled. These assertions pin the distinctions that matter:
 * an unreadable balance is never zero, an empty ledger never agrees, and a
 * mismatch outranks anything reassuring.
 */

import { describe, expect, it } from 'vitest';
import {
  POSTING_STATE_COPY,
  VERDICT_COPY,
  formatMinor,
  postingKindLabel,
  reconciliationHeadline,
  summariseReconciliation,
  type MemberReconciliation,
} from './ledger-state';

function member(overrides: Partial<MemberReconciliation>): MemberReconciliation {
  return {
    userId: 1,
    currency: 'NGN',
    ledgerBalanceMinor: 1000,
    postedBalanceMinor: 1000,
    businessBalanceMinor: 1000,
    unconfirmedMinor: 0,
    verdict: 'matched',
    note: 'agrees',
    ...overrides,
  };
}

describe('ledger posting copy', () => {
  it('never describes an unconfirmed entry as applied', () => {
    expect(POSTING_STATE_COPY.pending.tone).toBe('warning');
    expect(POSTING_STATE_COPY.pending.label).not.toMatch(/ledger$/i);
    expect(POSTING_STATE_COPY.pending.meaning).toMatch(/no balance reflects it/i);
  });

  it('separates a refusal from an unanswered entry', () => {
    expect(POSTING_STATE_COPY.refused.tone).toBe('danger');
    expect(POSTING_STATE_COPY.unavailable_no_ledger.tone).toBe('danger');
    expect(POSTING_STATE_COPY.refused.meaning).not.toEqual(
      POSTING_STATE_COPY.unavailable_no_ledger.meaning
    );
  });

  it('only calls a posted entry good', () => {
    const good = Object.entries(POSTING_STATE_COPY)
      .filter(([, copy]) => copy.tone === 'good')
      .map(([state]) => state);
    expect(good).toEqual(['posted']);
  });

  it('labels known posting kinds and passes unknown ones through', () => {
    expect(postingKindLabel('buyer_payment_captured')).toBe('Buyer payment captured');
    expect(postingKindLabel('something_new')).toBe('something_new');
  });
});

describe('formatMinor', () => {
  it('renders an unreadable balance as unknown, not zero', () => {
    expect(formatMinor(null, 'NGN')).toBe('unknown');
    expect(formatMinor(0, 'NGN')).toBe('0.00 NGN');
  });

  it('keeps minor units exact and signed', () => {
    expect(formatMinor(1234, 'TZS')).toBe('12.34 TZS');
    expect(formatMinor(-5, 'USD')).toBe('-0.05 USD');
  });
});

describe('reconciliation summary', () => {
  it('counts each verdict and totals unconfirmed money', () => {
    const summary = summariseReconciliation([
      member({ userId: 1 }),
      member({ userId: 2, verdict: 'mismatch', unconfirmedMinor: 300 }),
      member({ userId: 3, verdict: 'unknown', ledgerBalanceMinor: null }),
    ]);
    expect(summary).toEqual({
      members: 3,
      matched: 1,
      mismatches: 1,
      unknowns: 1,
      unconfirmedMinor: 300,
    });
  });
});

describe('reconciliation headline', () => {
  const empty = summariseReconciliation([]);

  it('leads with a missing ledger over anything else', () => {
    const headline = reconciliationHeadline(empty, false);
    expect(headline.tone).toBe('danger');
    expect(headline.text).toMatch(/no double-entry ledger/i);
  });

  it('never phrases an empty ledger as agreement', () => {
    const headline = reconciliationHeadline(empty, true);
    expect(headline.tone).toBe('neutral');
    expect(headline.text).not.toMatch(/agree/i);
  });

  it('leads with mismatches even when balances are also unreadable', () => {
    const summary = summariseReconciliation([
      member({ userId: 1, verdict: 'mismatch' }),
      member({ userId: 2, verdict: 'unknown', ledgerBalanceMinor: null }),
    ]);
    const headline = reconciliationHeadline(summary, true);
    expect(headline.tone).toBe('danger');
    expect(headline.text).toMatch(/disagree/i);
  });

  it('reports unreadable balances as a warning, not an all-clear', () => {
    const summary = summariseReconciliation([
      member({ userId: 1 }),
      member({ userId: 2, verdict: 'unknown', ledgerBalanceMinor: null }),
    ]);
    const headline = reconciliationHeadline(summary, true);
    expect(headline.tone).toBe('warning');
    expect(headline.text).toMatch(/could not be read/i);
  });

  it('only says balances agree when every one of them does', () => {
    const headline = reconciliationHeadline(
      summariseReconciliation([member({ userId: 1 }), member({ userId: 2 })]),
      true
    );
    expect(headline.tone).toBe('good');
    expect(headline.text).toBe('All 2 member balances agree');
  });
});

describe('verdict copy', () => {
  it('says a mismatch is not repaired automatically', () => {
    expect(VERDICT_COPY.mismatch.meaning).toMatch(/nothing has been changed/i);
  });

  it('says an unreadable balance is missing information', () => {
    expect(VERDICT_COPY.unknown.meaning).toMatch(/not a balance of zero/i);
  });
});
