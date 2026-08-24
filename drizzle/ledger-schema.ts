/**
 * Double-entry ledger tables.
 *
 * The platform's money record was single-entry: a hash-chained `settlement_events`
 * log plus per-trade rows. That log is tamper-evident but it does not balance —
 * nothing in it forces the amount owed to a seller and the amount held at a
 * gateway to add up, so a lost or duplicated leg is invisible until somebody
 * reconciles by hand.
 *
 * These tables are the platform's half of a TigerBeetle ledger:
 *
 *   - `ledger_accounts` maps a platform entity (a member, a gateway, the
 *     treasury) to the TigerBeetle account that holds its balance. The mapping is
 *     stored rather than derived at read time so an account can never be
 *     silently re-pointed at a different balance.
 *   - `ledger_postings` is the outbox and the audit trail for every transfer the
 *     platform asked TigerBeetle to apply. A posting is written in the same
 *     transaction as the business fact that justifies it, and only then attempted
 *     against the ledger, so a posting that never reached TigerBeetle is a
 *     visible `pending` row rather than money that quietly moved in one system
 *     and not the other.
 *
 * Nothing here invents balances: when no ledger is configured the posting is
 * recorded as `unavailable_no_ledger`, which is a refusal to claim the transfer
 * happened, not a zero.
 */

import {
  index,
  integer as int,
  pgEnum,
  pgTable,
  serial,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * The kinds of account the platform keeps. Each one has a fixed balance
 * direction, which is what makes a posting checkable:
 *
 *   - `gateway_clearing` and `treasury` are asset accounts (debits - credits):
 *     money the platform holds or has in flight at a provider.
 *   - `member_liability` is what the platform owes a member (credits - debits).
 *     It must never be paid past what is owed.
 *   - `fee_revenue` is the platform's own earnings (credits - debits).
 */
export const ledgerAccountKindEnum = pgEnum('ledger_account_kind', [
  'member_liability',
  'gateway_clearing',
  'treasury',
  'fee_revenue',
]);

/** Currencies the ledger keeps accounts in. One TigerBeetle ledger per currency. */
export const ledgerCurrencyEnum = pgEnum('ledger_currency', ['NGN', 'TZS', 'USD']);

/**
 * What business fact a posting records. Only facts with provider evidence behind
 * them appear here: a match, a dispatch or a client-reported payment does not
 * move money and so does not post.
 */
export const ledgerPostingKindEnum = pgEnum('ledger_posting_kind', [
  /** A buyer's payment was confirmed by the payment provider. */
  'buyer_payment_captured',
  /** A payout to a member was confirmed by the disbursement provider. */
  'member_payout_settled',
  /** A confirmed payment was reversed by the provider. */
  'buyer_payment_reversed',
  /**
   * A prepaid customer's confirmed payment for energy they have not taken yet:
   * the funds sit at the gateway and the platform owes them that energy. The
   * matching consumption is deliberately not posted — energy taken is measured in
   * watt-hours, and converting each meter reading to minor units would post a
   * rounding residue as revenue.
   */
  'prepaid_credit_purchased',
]);

/**
 * A posting's life. `pending` means the platform has committed to the transfer
 * but has no confirmation from the ledger yet — it is the state a crash leaves
 * behind, and it is why the row exists before the call.
 */
export const ledgerPostingStateEnum = pgEnum('ledger_posting_state', [
  'pending',
  /** TigerBeetle applied the transfer (or already had it: the id is idempotent). */
  'posted',
  /** TigerBeetle rejected it — insufficient funds, wrong ledger, bad account. */
  'refused',
  /** No ledger is configured, so the platform cannot say the transfer happened. */
  'unavailable_no_ledger',
]);

export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: serial('id').primaryKey(),
    accountKind: ledgerAccountKindEnum('account_kind').notNull(),
    currency: ledgerCurrencyEnum('currency').notNull(),
    /** Set for `member_liability`: the member whose balance this is. */
    ownerUserId: int('owner_user_id'),
    /** Set for `gateway_clearing`: the provider holding the funds, e.g. `mpesa`. */
    gatewayKey: varchar('gateway_key', { length: 64 }),
    /**
     * The TigerBeetle account id, as the decimal string of a 128-bit unsigned
     * integer. Stored as text because it does not fit an int8, and derived
     * deterministically from the kind, currency and entity so the same platform
     * entity always resolves to the same ledger account.
     */
    tbAccountId: varchar('tb_account_id', { length: 40 }).notNull(),
    /** The TigerBeetle ledger (ISO 4217 numeric code of the currency). */
    ledgerCode: int('ledger_code').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  table => ({
    tbAccountUnique: uniqueIndex('ledger_accounts_tb_account_id_key').on(table.tbAccountId),
    ownerIdx: index('ledger_accounts_owner_idx').on(table.ownerUserId, table.currency),
  })
);

export const ledgerPostings = pgTable(
  'ledger_postings',
  {
    id: serial('id').primaryKey(),
    postingKind: ledgerPostingKindEnum('posting_kind').notNull(),
    /** What the posting is evidence for, e.g. `payment` or `p2p_settlement`. */
    sourceType: varchar('source_type', { length: 40 }).notNull(),
    sourceId: int('source_id').notNull(),
    /** The provider's own reference for the money movement. Never our row id. */
    providerReference: varchar('provider_reference', { length: 128 }),
    currency: ledgerCurrencyEnum('currency').notNull(),
    /** Whole minor units. The ledger holds integers; fractions are a caller bug. */
    amountMinor: int('amount_minor').notNull(),
    debitAccountId: int('debit_account_id').notNull(),
    creditAccountId: int('credit_account_id').notNull(),
    /**
     * The TigerBeetle transfer id (decimal string of a 128-bit integer), derived
     * from the posting kind and source so a retried callback re-posts the same
     * id. TigerBeetle rejects a duplicate id, which is what makes the retry safe.
     */
    tbTransferId: varchar('tb_transfer_id', { length: 40 }).notNull(),
    state: ledgerPostingStateEnum('state').notNull().default('pending'),
    /** Why the posting reads as it does, in the ledger's own words where it refused. */
    detail: varchar('detail', { length: 512 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    settledAt: timestamp('settled_at'),
  },
  table => ({
    transferUnique: uniqueIndex('ledger_postings_tb_transfer_id_key').on(table.tbTransferId),
    sourceIdx: index('ledger_postings_source_idx').on(table.sourceType, table.sourceId),
    stateIdx: index('ledger_postings_state_idx').on(table.state, table.createdAt),
  })
);

export type LedgerAccount = typeof ledgerAccounts.$inferSelect;
export type LedgerPosting = typeof ledgerPostings.$inferSelect;
export type LedgerAccountKind = LedgerAccount['accountKind'];
export type LedgerCurrency = LedgerAccount['currency'];
export type LedgerPostingKind = LedgerPosting['postingKind'];
export type LedgerPostingState = LedgerPosting['state'];
