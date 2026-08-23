/**
 * The boundary between the platform and the ledger. Its job is to never let a
 * ledger problem read as a completed movement of money:
 *
 *  - with no ledger configured, callers get a refusal, never a stand-in that
 *    reports balances of zero
 *  - `created` and `exists` are the only successes; every other status is the
 *    ledger refusing and is raised with the status it gave
 *  - a refusal and an unreachable ledger are recorded as different states, because
 *    one is a finding about the money and the other is missing information
 */

import { describe, it, expect, afterEach } from 'vitest';
import { CreateAccountStatus, CreateTransferStatus } from 'tigerbeetle-node';
import {
  LedgerRefusedError,
  LedgerUnavailableError,
  assertAccountStatuses,
  assertTransferStatuses,
  closeLedgerClient,
  getLedgerClient,
  ledgerConfigured,
  setLedgerClientForTests,
} from './services/ledger/tigerbeetle';
import { postingOutcomeForError } from './services/ledger/postings';

const savedAddresses = process.env.TIGERBEETLE_ADDRESSES;

afterEach(() => {
  setLedgerClientForTests(null);
  closeLedgerClient();
  if (savedAddresses === undefined) delete process.env.TIGERBEETLE_ADDRESSES;
  else process.env.TIGERBEETLE_ADDRESSES = savedAddresses;
});

describe('an unconfigured ledger', () => {
  it('is reported as absent rather than empty', () => {
    delete process.env.TIGERBEETLE_ADDRESSES;
    expect(ledgerConfigured()).toBe(false);
    expect(() => getLedgerClient()).toThrow(LedgerUnavailableError);
    expect(() => getLedgerClient()).toThrow(/no double-entry ledger/);
  });

  it('refuses a cluster id that is not a number instead of guessing zero', () => {
    process.env.TIGERBEETLE_ADDRESSES = '127.0.0.1:3200';
    const savedCluster = process.env.TIGERBEETLE_CLUSTER_ID;
    process.env.TIGERBEETLE_CLUSTER_ID = 'primary';
    try {
      expect(() => getLedgerClient()).toThrow(LedgerUnavailableError);
    } finally {
      if (savedCluster === undefined) delete process.env.TIGERBEETLE_CLUSTER_ID;
      else process.env.TIGERBEETLE_CLUSTER_ID = savedCluster;
    }
  });
});

describe('ledger statuses', () => {
  it('accepts a created account and an account that already exists', () => {
    expect(() =>
      assertAccountStatuses([{ status: CreateAccountStatus.created }, { status: CreateAccountStatus.exists }])
    ).not.toThrow();
  });

  it('raises the ledger status when an account is refused', () => {
    let raised: unknown = null;
    try {
      assertAccountStatuses([{ status: CreateAccountStatus.exists_with_different_ledger }]);
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(LedgerRefusedError);
    expect((raised as LedgerRefusedError).status).toBe('exists_with_different_ledger');
  });

  it('treats a duplicate transfer as already applied, not as a second payment', () => {
    expect(() => assertTransferStatuses([{ status: CreateTransferStatus.exists }])).not.toThrow();
  });

  it('raises the ledger status when a transfer would overdraw an account', () => {
    let raised: unknown = null;
    try {
      assertTransferStatuses([{ status: CreateTransferStatus.exceeds_credits }]);
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(LedgerRefusedError);
    expect((raised as LedgerRefusedError).status).toBe('exceeds_credits');
  });

  it('reports a status it does not know rather than passing it as success', () => {
    expect(() => assertTransferStatuses([{ status: 9999 }])).toThrow(/status_9999/);
  });
});

describe('how a failed attempt is recorded', () => {
  it('records a ledger refusal as refused', () => {
    const outcome = postingOutcomeForError(new LedgerRefusedError('exceeds_credits', 'refused'));
    expect(outcome.state).toBe('refused');
    expect(outcome.detail).toMatch(/no balance changed/);
  });

  it('records a missing ledger as unavailable, not as posted', () => {
    const outcome = postingOutcomeForError(new LedgerUnavailableError('no ledger'));
    expect(outcome.state).toBe('unavailable_no_ledger');
  });

  it('keeps an unreachable ledger pending so the transfer is retried', () => {
    const outcome = postingOutcomeForError(new Error('connection reset'));
    expect(outcome.state).toBe('pending');
    expect(outcome.detail).toMatch(/retried/);
  });
});

describe('a test-supplied client', () => {
  it('is used in place of configuration, and balances come from it', async () => {
    delete process.env.TIGERBEETLE_ADDRESSES;
    setLedgerClientForTests({
      createAccounts: async () => undefined,
      createTransfers: async () => undefined,
      lookupBalances: async ids =>
        ids.map(id => ({ id, debitsPosted: 0n, creditsPosted: 500n, balance: 500n, ledger: 834, code: 1 })),
      close: () => undefined,
    });
    expect(ledgerConfigured()).toBe(true);
    const [balance] = await getLedgerClient().lookupBalances([1n]);
    expect(balance.balance).toBe(500n);
  });
});
