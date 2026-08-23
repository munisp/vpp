/**
 * The TigerBeetle boundary.
 *
 * Two rules hold here, and they are the reason this file is separate from the
 * posting logic:
 *
 *   1. If no ledger is configured, nothing pretends there is one. There is no
 *      in-process balance, no map, no fallback: callers get
 *      `LedgerUnavailableError` and record the money movement as unposted.
 *   2. A refusal from TigerBeetle is returned as a refusal, in its own words. An
 *      `exceeds_credits` on a payout is the ledger saying the platform is about
 *      to pay out more than it owes, and swallowing it would be the single most
 *      expensive bug this platform could have.
 *
 * `exists` is the one non-`created` status treated as success: transfer ids are
 * derived from the business fact (see `chart.ts`), so a duplicate id means this
 * exact transfer was already applied — that is idempotency working, not an error.
 */

import {
  createClient,
  AccountFlags,
  CreateAccountStatus,
  CreateTransferStatus,
  type Account,
  type Client,
  type Transfer,
} from 'tigerbeetle-node';
import { ACCOUNT_BALANCE_DIRECTION, LEDGER_CODES, ACCOUNT_KIND_CODES } from './chart';
import type { LedgerAccountKind, LedgerCurrency } from '../../../drizzle/ledger-schema';

/** Thrown when the platform has no ledger to post to. Never caught and ignored. */
export class LedgerUnavailableError extends Error {
  readonly code = 'LEDGER_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'LedgerUnavailableError';
  }
}

/** Thrown when TigerBeetle answered and refused. Carries the ledger's status name. */
export class LedgerRefusedError extends Error {
  readonly code = 'LEDGER_REFUSED';
  readonly status: string;
  constructor(status: string, message: string) {
    super(message);
    this.name = 'LedgerRefusedError';
    this.status = status;
  }
}

export interface LedgerAccountSpec {
  id: bigint;
  kind: LedgerAccountKind;
  currency: LedgerCurrency;
}

export interface LedgerTransferSpec {
  id: bigint;
  debitAccountId: bigint;
  creditAccountId: bigint;
  amount: bigint;
  currency: LedgerCurrency;
  code: number;
}

export interface LedgerBalance {
  id: bigint;
  debitsPosted: bigint;
  creditsPosted: bigint;
  /** Signed balance in the account's own direction, so a healthy account is >= 0. */
  balance: bigint;
  ledger: number;
  code: number;
}

/** The subset of the TigerBeetle client this platform uses. */
export interface LedgerClient {
  createAccounts(specs: LedgerAccountSpec[]): Promise<void>;
  createTransfers(specs: LedgerTransferSpec[]): Promise<void>;
  lookupBalances(ids: bigint[]): Promise<LedgerBalance[]>;
  close(): void;
}

export function accountFlagsFor(kind: LedgerAccountKind): number {
  // `history` keeps per-transfer balances so reconciliation can be checked against
  // the ledger's own record rather than only against its current totals.
  const base = AccountFlags.history;
  return ACCOUNT_BALANCE_DIRECTION[kind] === 'credit'
    ? // A liability or revenue account must not be debited past what it holds:
      // this is what stops a payout larger than the amount owed.
      base | AccountFlags.debits_must_not_exceed_credits
    : // An asset account must not be credited past what was put into it.
      base | AccountFlags.credits_must_not_exceed_debits;
}

function statusName(status: number, table: Record<number, string>): string {
  return table[status] ?? `status_${status}`;
}

const ACCOUNT_STATUS_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(CreateAccountStatus)
    .filter(([, value]) => typeof value === 'number')
    .map(([name, value]) => [value as number, name])
);

const TRANSFER_STATUS_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(CreateTransferStatus)
    .filter(([, value]) => typeof value === 'number')
    .map(([name, value]) => [value as number, name])
);

/**
 * Turn a batch of ledger statuses into either silence or a refusal. `exists` is
 * success: ids are derived from the business fact, so a duplicate means this exact
 * event was already applied. Every other non-`created` status is the ledger
 * refusing, and is raised rather than logged.
 */
export function assertAccountStatuses(results: Array<{ status: number }>): void {
  for (const result of results) {
    if (result.status === CreateAccountStatus.created || result.status === CreateAccountStatus.exists) {
      continue;
    }
    const name = statusName(result.status, ACCOUNT_STATUS_NAMES);
    throw new LedgerRefusedError(name, `TigerBeetle refused an account: ${name}`);
  }
}

export function assertTransferStatuses(results: Array<{ status: number }>): void {
  for (const result of results) {
    if (result.status === CreateTransferStatus.created || result.status === CreateTransferStatus.exists) {
      continue;
    }
    const name = statusName(result.status, TRANSFER_STATUS_NAMES);
    throw new LedgerRefusedError(name, `TigerBeetle refused a transfer: ${name}`);
  }
}

function emptyAccount(spec: LedgerAccountSpec): Account {
  return {
    id: spec.id,
    debits_pending: 0n,
    debits_posted: 0n,
    credits_pending: 0n,
    credits_posted: 0n,
    user_data_128: 0n,
    user_data_64: 0n,
    user_data_32: 0,
    reserved: 0,
    ledger: LEDGER_CODES[spec.currency],
    code: ACCOUNT_KIND_CODES[spec.kind],
    flags: accountFlagsFor(spec.kind),
    timestamp: 0n,
  };
}

function transferEvent(spec: LedgerTransferSpec): Transfer {
  return {
    id: spec.id,
    debit_account_id: spec.debitAccountId,
    credit_account_id: spec.creditAccountId,
    amount: spec.amount,
    pending_id: 0n,
    user_data_128: 0n,
    user_data_64: 0n,
    user_data_32: 0,
    timeout: 0,
    ledger: LEDGER_CODES[spec.currency],
    code: spec.code,
    flags: 0,
    timestamp: 0n,
  };
}

class TigerBeetleClient implements LedgerClient {
  constructor(private readonly client: Client) {}

  async createAccounts(specs: LedgerAccountSpec[]): Promise<void> {
    if (specs.length === 0) return;
    assertAccountStatuses(await this.client.createAccounts(specs.map(emptyAccount)));
  }

  async createTransfers(specs: LedgerTransferSpec[]): Promise<void> {
    if (specs.length === 0) return;
    assertTransferStatuses(await this.client.createTransfers(specs.map(transferEvent)));
  }

  async lookupBalances(ids: bigint[]): Promise<LedgerBalance[]> {
    if (ids.length === 0) return [];
    const accounts = await this.client.lookupAccounts(ids);
    return accounts.map(account => {
      const kind = (Object.entries(ACCOUNT_KIND_CODES).find(
        ([, code]) => code === account.code
      )?.[0] ?? 'treasury') as LedgerAccountKind;
      const direction = ACCOUNT_BALANCE_DIRECTION[kind];
      return {
        id: account.id,
        debitsPosted: account.debits_posted,
        creditsPosted: account.credits_posted,
        balance:
          direction === 'credit'
            ? account.credits_posted - account.debits_posted
            : account.debits_posted - account.credits_posted,
        ledger: account.ledger,
        code: account.code,
      };
    });
  }

  close(): void {
    this.client.destroy();
  }
}

let cached: LedgerClient | null = null;
let overridden: LedgerClient | null = null;

/** Replace the client in tests. Passing `null` restores configuration-driven use. */
export function setLedgerClientForTests(client: LedgerClient | null): void {
  overridden = client;
}

export function ledgerConfigured(): boolean {
  return Boolean(process.env.TIGERBEETLE_ADDRESSES) || overridden !== null;
}

/**
 * The configured ledger client, or `LedgerUnavailableError`. Callers must not
 * substitute anything for a missing ledger; they record the posting as
 * `unavailable_no_ledger` so the gap is in the audit trail.
 */
export function getLedgerClient(): LedgerClient {
  if (overridden) return overridden;
  if (cached) return cached;

  const addresses = process.env.TIGERBEETLE_ADDRESSES;
  if (!addresses) {
    throw new LedgerUnavailableError(
      'TIGERBEETLE_ADDRESSES is not set: the platform has no double-entry ledger, so no balance can be asserted and no transfer can be posted.'
    );
  }

  const clusterId = process.env.TIGERBEETLE_CLUSTER_ID ?? '0';
  let cluster: bigint;
  try {
    cluster = BigInt(clusterId);
  } catch {
    throw new LedgerUnavailableError(
      `TIGERBEETLE_CLUSTER_ID must be an integer, received "${clusterId}"`
    );
  }

  cached = new TigerBeetleClient(
    createClient({
      cluster_id: cluster,
      replica_addresses: addresses.split(',').map(address => address.trim()).filter(Boolean),
    })
  );
  return cached;
}

export function closeLedgerClient(): void {
  cached?.close();
  cached = null;
}
