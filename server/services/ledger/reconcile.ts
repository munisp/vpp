/**
 * Independent reconciliation.
 *
 * Three records of the same money exist once a ledger is in place:
 *
 *   1. TigerBeetle's balances — the ledger's own arithmetic;
 *   2. `ledger_postings` — what the platform asked the ledger to do;
 *   3. the business tables (`p2p_settlements`) — what the platform told its users
 *      happened.
 *
 * Reconciliation compares all three per member and reports a mismatch. It does
 * not repair anything: a difference between a member's ledger balance and the
 * settlements shown to that member is exactly the kind of fact that must reach an
 * operator rather than be normalised away by a background job.
 *
 * Any account the reconciler cannot read from the ledger reports `unknown`, never
 * zero — a missing balance is missing information, not an empty account.
 */

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { getDb } from '../../db';
import { p2pSettlements } from '../../../drizzle/innovations-schema';
import {
  ledgerAccounts,
  ledgerPostings,
  type LedgerCurrency,
} from '../../../drizzle/ledger-schema';
import { getLedgerClient, LedgerUnavailableError, ledgerConfigured } from './tigerbeetle';

export type ReconciliationVerdict = 'matched' | 'mismatch' | 'unknown';

export interface MemberReconciliation {
  userId: number;
  currency: LedgerCurrency;
  /** Balance TigerBeetle holds for the member, in minor units. `null` if unreadable. */
  ledgerBalanceMinor: number | null;
  /** What the platform's own postings say the balance should be. */
  postedBalanceMinor: number;
  /** What the settlements shown to users imply the member is owed. */
  businessBalanceMinor: number;
  /** Postings the ledger never confirmed; they explain a legitimate difference. */
  unconfirmedMinor: number;
  verdict: ReconciliationVerdict;
  note: string;
}

export interface ReconciliationReport {
  ledgerConfigured: boolean;
  checkedAt: string;
  members: MemberReconciliation[];
  mismatches: number;
  unknowns: number;
  note: string;
}

/**
 * Reconcile member liability balances. `userIds` narrows the check; omitted, it
 * reconciles every member the ledger holds an account for.
 */
export async function reconcileMemberBalances(userIds?: number[]): Promise<ReconciliationReport> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const checkedAt = new Date().toISOString();
  const configured = ledgerConfigured();

  const accountRows = await db
    .select()
    .from(ledgerAccounts)
    .where(
      userIds && userIds.length > 0
        ? and(eq(ledgerAccounts.accountKind, 'member_liability'), inArray(ledgerAccounts.ownerUserId, userIds))
        : eq(ledgerAccounts.accountKind, 'member_liability')
    );

  if (accountRows.length === 0) {
    return {
      ledgerConfigured: configured,
      checkedAt,
      members: [],
      mismatches: 0,
      unknowns: 0,
      note: 'No member holds a ledger account yet, so there is nothing to reconcile.',
    };
  }

  // What our own postings say each member's balance should be: credits raise the
  // liability, debits (payouts, reversals) discharge it. Only confirmed postings
  // count — an unconfirmed one has not moved anything.
  const postedRows = await db
    .select({
      accountId: ledgerAccounts.id,
      credited: sql<string>`COALESCE(SUM(CASE WHEN ${ledgerPostings.creditAccountId} = ${ledgerAccounts.id} AND ${ledgerPostings.state} = 'posted' THEN ${ledgerPostings.amountMinor} ELSE 0 END), 0)`,
      debited: sql<string>`COALESCE(SUM(CASE WHEN ${ledgerPostings.debitAccountId} = ${ledgerAccounts.id} AND ${ledgerPostings.state} = 'posted' THEN ${ledgerPostings.amountMinor} ELSE 0 END), 0)`,
      unconfirmed: sql<string>`COALESCE(SUM(CASE WHEN ${ledgerPostings.state} <> 'posted' THEN ${ledgerPostings.amountMinor} ELSE 0 END), 0)`,
    })
    .from(ledgerAccounts)
    .leftJoin(
      ledgerPostings,
      sql`${ledgerPostings.creditAccountId} = ${ledgerAccounts.id} OR ${ledgerPostings.debitAccountId} = ${ledgerAccounts.id}`
    )
    .where(inArray(ledgerAccounts.id, accountRows.map(row => row.id)))
    .groupBy(ledgerAccounts.id);

  const postedByAccount = new Map(
    postedRows.map(row => [
      row.accountId,
      {
        posted: Number(row.credited) - Number(row.debited),
        unconfirmed: Number(row.unconfirmed),
      },
    ])
  );

  // The independent record: what the platform showed its users. A settlement whose
  // buyer paid and whose seller was never paid is an amount the platform owes.
  const settlementRows = await db
    .select({
      sellerId: p2pSettlements.sellerId,
      currency: p2pSettlements.currency,
      owed: sql<string>`COALESCE(SUM(CASE WHEN ${p2pSettlements.sellerPayout} = 'evidenced' THEN 0 ELSE ${p2pSettlements.amountCents} END), 0)`,
    })
    .from(p2pSettlements)
    .where(
      and(
        isNotNull(p2pSettlements.buyerPaidAt),
        inArray(
          p2pSettlements.sellerId,
          accountRows.map(row => row.ownerUserId as number)
        )
      )
    )
    .groupBy(p2pSettlements.sellerId, p2pSettlements.currency);

  const businessByMember = new Map(
    settlementRows.map(row => [`${row.sellerId}:${row.currency}`, Number(row.owed)])
  );

  let ledgerBalances = new Map<string, bigint>();
  let ledgerNote = '';
  if (configured) {
    try {
      const balances = await getLedgerClient().lookupBalances(
        accountRows.map(row => BigInt(row.tbAccountId))
      );
      ledgerBalances = new Map(balances.map(balance => [balance.id.toString(), balance.balance]));
    } catch (error) {
      ledgerNote =
        error instanceof LedgerUnavailableError
          ? error.message
          : `The ledger could not be read: ${(error as Error).message}`;
    }
  } else {
    ledgerNote =
      'No double-entry ledger is configured, so no balance can be compared: this report shows what the platform records, not what a ledger confirms.';
  }

  const members: MemberReconciliation[] = accountRows.map(row => {
    const key = `${row.ownerUserId}:${row.currency}`;
    const posted = postedByAccount.get(row.id) ?? { posted: 0, unconfirmed: 0 };
    const business = businessByMember.get(key) ?? 0;
    const rawBalance = ledgerBalances.get(row.tbAccountId);
    const ledgerBalanceMinor = rawBalance === undefined ? null : Number(rawBalance);

    let verdict: ReconciliationVerdict;
    let note: string;
    if (ledgerBalanceMinor === null) {
      verdict = 'unknown';
      note =
        ledgerNote ||
        'The ledger holds no account for this member yet, so its balance is unknown rather than zero.';
    } else if (ledgerBalanceMinor !== posted.posted) {
      verdict = 'mismatch';
      note = `The ledger holds ${ledgerBalanceMinor} but the platform's confirmed postings sum to ${posted.posted}. One of the two records is wrong; neither has been changed.`;
    } else if (ledgerBalanceMinor !== business) {
      verdict = 'mismatch';
      note = `The ledger and the platform's postings agree on ${ledgerBalanceMinor}, but the settlements shown to this member imply ${business} is owed${
        posted.unconfirmed > 0 ? `, with ${posted.unconfirmed} in postings the ledger never confirmed` : ''
      }.`;
    } else {
      verdict = 'matched';
      note = `Ledger, postings and settlements agree on ${ledgerBalanceMinor} ${row.currency} minor units.`;
    }

    return {
      userId: row.ownerUserId as number,
      currency: row.currency,
      ledgerBalanceMinor,
      postedBalanceMinor: posted.posted,
      businessBalanceMinor: business,
      unconfirmedMinor: posted.unconfirmed,
      verdict,
      note,
    };
  });

  return {
    ledgerConfigured: configured,
    checkedAt,
    members,
    mismatches: members.filter(member => member.verdict === 'mismatch').length,
    unknowns: members.filter(member => member.verdict === 'unknown').length,
    note:
      ledgerNote ||
      'Balances were read from the ledger and compared against the platform\'s postings and settlements. Nothing was repaired.',
  };
}
