/**
 * Chart of accounts.
 *
 * TigerBeetle knows nothing about users, gateways or trades: it holds numbered
 * accounts on numbered ledgers. This module is the only place that decides which
 * number belongs to which platform entity, and it decides it deterministically so
 * that the same member always resolves to the same balance, in this process, in a
 * worker, and after a restart.
 *
 * The id layout is a 128-bit integer:
 *
 *   [ 32 bits: account kind ][ 32 bits: ledger (currency) ][ 64 bits: entity ]
 *
 * so an id is readable and collision-free by construction rather than by luck,
 * and an account can never be mistaken for the same entity on another ledger.
 */

import { createHash } from 'crypto';
import type { LedgerAccountKind, LedgerCurrency } from '../../../drizzle/ledger-schema';

/**
 * ISO 4217 numeric codes, used as the TigerBeetle ledger. One ledger per
 * currency: TigerBeetle refuses a transfer whose accounts are on different
 * ledgers, which is what makes a cross-currency posting impossible rather than
 * merely discouraged.
 */
export const LEDGER_CODES: Record<LedgerCurrency, number> = {
  NGN: 566,
  TZS: 834,
  USD: 840,
};

/** Stable numeric code per account kind. Never renumber: ids are derived from it. */
export const ACCOUNT_KIND_CODES: Record<LedgerAccountKind, number> = {
  member_liability: 1,
  gateway_clearing: 2,
  treasury: 3,
  fee_revenue: 4,
};

/**
 * The balance direction of each kind, and therefore which way a posting has to
 * run. Asset accounts hold what the platform has; liability and revenue accounts
 * hold what it owes and what it earned.
 */
export const ACCOUNT_BALANCE_DIRECTION: Record<LedgerAccountKind, 'debit' | 'credit'> = {
  member_liability: 'credit',
  gateway_clearing: 'debit',
  treasury: 'debit',
  fee_revenue: 'credit',
};

export interface AccountRef {
  kind: LedgerAccountKind;
  currency: LedgerCurrency;
  /** The member whose balance this is. Required for `member_liability`. */
  ownerUserId?: number | null;
  /** The provider holding the funds. Required for `gateway_clearing`. */
  gatewayKey?: string | null;
}

const MAX_UINT64 = (1n << 64n) - 1n;

/**
 * Fold a gateway key into the 64-bit entity slot. A hash is used because gateway
 * keys are strings chosen by configuration; taking the low 63 bits of SHA-256
 * keeps the id stable across deployments without a registry to keep in sync.
 */
function gatewayEntityId(gatewayKey: string): bigint {
  const digest = createHash('sha256').update(`gateway:${gatewayKey}`).digest('hex');
  const value = BigInt(`0x${digest}`) & ((1n << 63n) - 1n);
  // Zero is not a usable id, and a gateway that hashed to zero would silently
  // collide with the singleton slot used by treasury accounts.
  return value === 0n ? 1n : value;
}

/**
 * The 64-bit entity slot for a reference. Treasury and fee accounts are
 * singletons per currency, so they occupy slot 1.
 */
export function entityIdFor(ref: AccountRef): bigint {
  switch (ref.kind) {
    case 'member_liability': {
      const userId = ref.ownerUserId;
      if (!Number.isInteger(userId) || (userId as number) <= 0) {
        throw new Error(
          `A member liability account needs the member it belongs to; received ownerUserId=${String(userId)}`
        );
      }
      return BigInt(userId as number);
    }
    case 'gateway_clearing': {
      if (!ref.gatewayKey) {
        throw new Error('A gateway clearing account needs the gateway holding the funds');
      }
      return gatewayEntityId(ref.gatewayKey);
    }
    case 'treasury':
    case 'fee_revenue':
      return 1n;
  }
}

/** The deterministic TigerBeetle account id for a platform entity. */
export function accountIdFor(ref: AccountRef): bigint {
  const kindCode = ACCOUNT_KIND_CODES[ref.kind];
  const ledger = LEDGER_CODES[ref.currency];
  if (ledger === undefined) {
    throw new Error(`No ledger is defined for currency ${ref.currency}`);
  }
  const entity = entityIdFor(ref);
  if (entity > MAX_UINT64) {
    throw new Error(`Entity id ${entity} does not fit the ledger's 64-bit entity slot`);
  }
  return (BigInt(kindCode) << 96n) | (BigInt(ledger) << 64n) | entity;
}

/**
 * The deterministic transfer id for a business fact. A retried provider callback
 * derives the same id and TigerBeetle rejects the duplicate, so the retry cannot
 * move the money twice. The id therefore must not depend on wall-clock time,
 * attempt number, or anything else that changes between retries.
 */
export function transferIdFor(input: {
  postingKind: string;
  sourceType: string;
  sourceId: number;
}): bigint {
  const digest = createHash('sha256')
    .update(`transfer:v1:${input.postingKind}:${input.sourceType}:${input.sourceId}`)
    .digest('hex');
  // TigerBeetle rejects id 0 and id 2^128-1, so the top bit is cleared and zero
  // is mapped away rather than trusted not to occur.
  const value = BigInt(`0x${digest}`) & ((1n << 127n) - 1n);
  return value === 0n ? 1n : value;
}

/** TigerBeetle `code` on a transfer: what kind of money movement it records. */
export const TRANSFER_CODES: Record<string, number> = {
  buyer_payment_captured: 1,
  member_payout_settled: 2,
  buyer_payment_reversed: 3,
};

export function describeAccount(ref: AccountRef): string {
  switch (ref.kind) {
    case 'member_liability':
      return `member ${ref.ownerUserId} liability (${ref.currency})`;
    case 'gateway_clearing':
      return `${ref.gatewayKey} clearing (${ref.currency})`;
    case 'treasury':
      return `treasury (${ref.currency})`;
    case 'fee_revenue':
      return `fee revenue (${ref.currency})`;
  }
}
