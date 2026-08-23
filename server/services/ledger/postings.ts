/**
 * Double-entry postings.
 *
 * Every function here follows the same shape, and the shape is the point:
 *
 *   1. resolve both sides of the entry to real ledger accounts;
 *   2. write a `ledger_postings` row **before** talking to TigerBeetle;
 *   3. attempt the transfer;
 *   4. record what the ledger said.
 *
 * Step 2 is what makes a crash survivable: a transfer that was attempted but
 * never confirmed is left as a `pending` row that `sweepPendingPostings()` will
 * retry with the same derived transfer id, so the retry either applies the
 * transfer once or learns from TigerBeetle that it already exists. The
 * alternative — post first, record after — loses the money movement from our own
 * audit trail exactly when it matters.
 *
 * Nothing here decides that money *should* move. Callers must already hold
 * provider evidence; these functions record a movement that a provider confirmed.
 */

import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { getDb } from '../../db';
import {
  ledgerAccounts,
  ledgerPostings,
  type LedgerCurrency,
  type LedgerPostingKind,
  type LedgerPostingState,
} from '../../../drizzle/ledger-schema';
import { accountIdFor, describeAccount, transferIdFor, TRANSFER_CODES, LEDGER_CODES, type AccountRef } from './chart';
import {
  LedgerRefusedError,
  LedgerUnavailableError,
  getLedgerClient,
  ledgerConfigured,
  type LedgerAccountSpec,
} from './tigerbeetle';

/**
 * How a failed attempt is recorded. The three cases are deliberately different
 * states rather than one "failed": the ledger refusing a transfer is a finding
 * about the money, an unreachable ledger is missing information, and a missing
 * configuration is the platform having no ledger at all.
 */
export function postingOutcomeForError(error: unknown): { state: LedgerPostingState; detail: string } {
  if (error instanceof LedgerRefusedError) {
    return {
      state: 'refused',
      detail: `The ledger refused this transfer: ${error.status}. The money movement is recorded but no balance changed.`,
    };
  }
  if (error instanceof LedgerUnavailableError) {
    return { state: 'unavailable_no_ledger', detail: error.message };
  }
  const reason = error instanceof Error ? error.message : String(error);
  return {
    state: 'pending',
    detail: `The ledger did not confirm this transfer: ${reason}. It remains pending and will be retried.`,
  };
}

export interface PostingResult {
  postingId: number;
  state: LedgerPostingState;
  tbTransferId: string;
  detail: string;
}

/**
 * Resolve a platform entity to its ledger account row, creating the row if this
 * is the first time the entity has held money. The TigerBeetle account itself is
 * created at post time, where account creation and the transfer are attempted
 * together — a local row for an account TigerBeetle has never seen would
 * otherwise read as an account with a zero balance.
 */
export async function ensureLedgerAccount(ref: AccountRef): Promise<{ id: number; tbAccountId: bigint }> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const tbAccountId = accountIdFor(ref);
  const asText = tbAccountId.toString();

  const [row] = await db
    .insert(ledgerAccounts)
    .values({
      accountKind: ref.kind,
      currency: ref.currency,
      ownerUserId: ref.ownerUserId ?? null,
      gatewayKey: ref.gatewayKey ?? null,
      tbAccountId: asText,
      ledgerCode: LEDGER_CODES[ref.currency],
    })
    .onConflictDoUpdate({
      target: ledgerAccounts.tbAccountId,
      // The derived id already fixes kind, currency and entity, so there is
      // nothing to change on conflict; the update exists to return the row.
      set: { tbAccountId: asText },
    })
    .returning({ id: ledgerAccounts.id });

  return { id: row.id, tbAccountId };
}

interface PostEntryInput {
  postingKind: LedgerPostingKind;
  sourceType: string;
  sourceId: number;
  currency: LedgerCurrency;
  amountMinor: number;
  providerReference: string | null;
  debit: AccountRef;
  credit: AccountRef;
}

async function postEntry(input: PostEntryInput): Promise<PostingResult> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new Error(
      `A ledger posting must move a whole positive amount of minor units, received ${input.amountMinor}`
    );
  }
  if (input.debit.currency !== input.credit.currency || input.debit.currency !== input.currency) {
    throw new Error('A posting cannot cross currencies: both accounts must be on the posting ledger');
  }

  const debitAccount = await ensureLedgerAccount(input.debit);
  const creditAccount = await ensureLedgerAccount(input.credit);
  const transferId = transferIdFor(input);
  const asText = transferId.toString();

  const configured = ledgerConfigured();
  const initialState: LedgerPostingState = configured ? 'pending' : 'unavailable_no_ledger';
  const initialDetail = configured
    ? `${describeAccount(input.debit)} -> ${describeAccount(input.credit)}: attempted, awaiting the ledger`
    : 'No double-entry ledger is configured, so this money movement is recorded but not posted: the platform cannot assert a balance for it.';

  // Keyed by the derived transfer id, so a retried provider callback re-enters
  // the same row instead of opening a second posting for one movement.
  const [posting] = await db
    .insert(ledgerPostings)
    .values({
      postingKind: input.postingKind,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      providerReference: input.providerReference,
      currency: input.currency,
      amountMinor: input.amountMinor,
      debitAccountId: debitAccount.id,
      creditAccountId: creditAccount.id,
      tbTransferId: asText,
      state: initialState,
      detail: initialDetail,
    })
    .onConflictDoNothing({ target: ledgerPostings.tbTransferId })
    .returning({ id: ledgerPostings.id, state: ledgerPostings.state });

  const existing = posting
    ? posting
    : (
        await db
          .select({ id: ledgerPostings.id, state: ledgerPostings.state })
          .from(ledgerPostings)
          .where(eq(ledgerPostings.tbTransferId, asText))
          .limit(1)
      )[0];

  if (!existing) {
    throw new Error(`Ledger posting ${asText} could neither be written nor read back`);
  }

  // Already confirmed by the ledger: re-posting would be an attempt to move the
  // same money twice, and TigerBeetle would refuse it anyway.
  if (existing.state === 'posted') {
    return {
      postingId: existing.id,
      state: 'posted',
      tbTransferId: asText,
      detail: 'Already posted to the ledger; this confirmation is a repeat.',
    };
  }

  if (!configured) {
    return { postingId: existing.id, state: 'unavailable_no_ledger', tbTransferId: asText, detail: initialDetail };
  }

  return applyPosting({
    postingId: existing.id,
    transferId,
    currency: input.currency,
    amountMinor: input.amountMinor,
    postingKind: input.postingKind,
    debit: { ref: input.debit, tbAccountId: debitAccount.tbAccountId },
    credit: { ref: input.credit, tbAccountId: creditAccount.tbAccountId },
  });
}

async function applyPosting(args: {
  postingId: number;
  transferId: bigint;
  currency: LedgerCurrency;
  amountMinor: number;
  postingKind: LedgerPostingKind;
  debit: { ref: AccountRef; tbAccountId: bigint };
  credit: { ref: AccountRef; tbAccountId: bigint };
}): Promise<PostingResult> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const specs: LedgerAccountSpec[] = [
    { id: args.debit.tbAccountId, kind: args.debit.ref.kind, currency: args.currency },
    { id: args.credit.tbAccountId, kind: args.credit.ref.kind, currency: args.currency },
  ];

  try {
    const client = getLedgerClient();
    // Idempotent: `exists` is success, so the accounts are ensured on every
    // posting rather than tracked with a flag that can drift from the ledger.
    await client.createAccounts(specs);
    await client.createTransfers([
      {
        id: args.transferId,
        debitAccountId: args.debit.tbAccountId,
        creditAccountId: args.credit.tbAccountId,
        amount: BigInt(args.amountMinor),
        currency: args.currency,
        code: TRANSFER_CODES[args.postingKind] ?? 1,
      },
    ]);
  } catch (error) {
    const { state, detail } = postingOutcomeForError(error);
    const refused = error instanceof LedgerRefusedError;

    await db
      .update(ledgerPostings)
      .set({ state, detail: detail.slice(0, 512) })
      .where(eq(ledgerPostings.id, args.postingId));

    if (refused) throw error;
    return { postingId: args.postingId, state, tbTransferId: args.transferId.toString(), detail };
  }

  const detail = `${describeAccount(args.debit.ref)} -> ${describeAccount(args.credit.ref)}: posted ${args.amountMinor} ${args.currency} minor units.`;
  await db
    .update(ledgerPostings)
    .set({ state: 'posted', settledAt: new Date(), detail: detail.slice(0, 512) })
    .where(eq(ledgerPostings.id, args.postingId));

  return { postingId: args.postingId, state: 'posted', tbTransferId: args.transferId.toString(), detail };
}

/** The gateway whose clearing account holds funds a provider has confirmed. */
export function gatewayClearing(gatewayKey: string, currency: LedgerCurrency): AccountRef {
  return { kind: 'gateway_clearing', currency, gatewayKey };
}

export function memberLiability(userId: number, currency: LedgerCurrency): AccountRef {
  return { kind: 'member_liability', currency, ownerUserId: userId };
}

/**
 * A buyer's payment that the provider confirmed: the funds sit at the gateway and
 * the platform now owes them to the seller. Both facts are one entry, so the
 * platform cannot hold the money without owing it.
 */
export async function postBuyerPaymentCaptured(input: {
  paymentId: number;
  sellerUserId: number;
  gatewayKey: string;
  currency: LedgerCurrency;
  amountMinor: number;
  providerReference: string;
}): Promise<PostingResult> {
  return postEntry({
    postingKind: 'buyer_payment_captured',
    sourceType: 'payment',
    sourceId: input.paymentId,
    currency: input.currency,
    amountMinor: input.amountMinor,
    providerReference: input.providerReference,
    debit: gatewayClearing(input.gatewayKey, input.currency),
    credit: memberLiability(input.sellerUserId, input.currency),
  });
}

/**
 * A payout the disbursement provider confirmed: what the platform owed the member
 * is discharged against the funds held at the gateway. The ledger refuses this if
 * the member is not owed that much, which is the check no single-entry log can do.
 */
export async function postMemberPayoutSettled(input: {
  payoutId: number;
  memberUserId: number;
  gatewayKey: string;
  currency: LedgerCurrency;
  amountMinor: number;
  providerReference: string;
}): Promise<PostingResult> {
  return postEntry({
    postingKind: 'member_payout_settled',
    sourceType: 'payout',
    sourceId: input.payoutId,
    currency: input.currency,
    amountMinor: input.amountMinor,
    providerReference: input.providerReference,
    debit: memberLiability(input.memberUserId, input.currency),
    credit: gatewayClearing(input.gatewayKey, input.currency),
  });
}

/**
 * A confirmed payment the provider later reversed. The entry runs the other way
 * rather than deleting the capture: the ledger keeps both movements, so a reversal
 * is visible as a reversal instead of as a payment that never happened.
 */
export async function postBuyerPaymentReversed(input: {
  paymentId: number;
  sellerUserId: number;
  gatewayKey: string;
  currency: LedgerCurrency;
  amountMinor: number;
  providerReference: string;
}): Promise<PostingResult> {
  return postEntry({
    postingKind: 'buyer_payment_reversed',
    sourceType: 'payment',
    sourceId: input.paymentId,
    currency: input.currency,
    amountMinor: input.amountMinor,
    providerReference: input.providerReference,
    debit: memberLiability(input.sellerUserId, input.currency),
    credit: gatewayClearing(input.gatewayKey, input.currency),
  });
}

export interface SweepResult {
  attempted: number;
  posted: number;
  stillPending: number;
  refused: number;
}

/**
 * Retry postings the ledger never confirmed. Safe to run concurrently with new
 * postings: the transfer id is derived from the business fact, so a retry of a
 * transfer that did apply comes back `exists` and is recorded as posted.
 */
export async function sweepPendingPostings(options: { olderThanMs?: number; limit?: number } = {}): Promise<SweepResult> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  if (!ledgerConfigured()) {
    return { attempted: 0, posted: 0, stillPending: 0, refused: 0 };
  }

  const cutoff = new Date(Date.now() - (options.olderThanMs ?? 30_000));
  const pending = await db
    .select({
      id: ledgerPostings.id,
      postingKind: ledgerPostings.postingKind,
      currency: ledgerPostings.currency,
      amountMinor: ledgerPostings.amountMinor,
      tbTransferId: ledgerPostings.tbTransferId,
      debitAccountId: ledgerPostings.debitAccountId,
      creditAccountId: ledgerPostings.creditAccountId,
    })
    .from(ledgerPostings)
    .where(
      and(
        inArray(ledgerPostings.state, ['pending', 'unavailable_no_ledger']),
        lt(ledgerPostings.createdAt, cutoff)
      )
    )
    .orderBy(ledgerPostings.id)
    .limit(options.limit ?? 100);

  const result: SweepResult = { attempted: pending.length, posted: 0, stillPending: 0, refused: 0 };
  if (pending.length === 0) return result;

  const accountIds = Array.from(
    new Set(pending.flatMap(row => [row.debitAccountId, row.creditAccountId]))
  );
  const accounts = await db
    .select()
    .from(ledgerAccounts)
    .where(inArray(ledgerAccounts.id, accountIds));
  const byId = new Map(accounts.map(account => [account.id, account]));

  for (const row of pending) {
    const debit = byId.get(row.debitAccountId);
    const credit = byId.get(row.creditAccountId);
    if (!debit || !credit) {
      result.stillPending++;
      continue;
    }
    try {
      const applied = await applyPosting({
        postingId: row.id,
        transferId: BigInt(row.tbTransferId),
        currency: row.currency,
        amountMinor: row.amountMinor,
        postingKind: row.postingKind,
        debit: {
          ref: {
            kind: debit.accountKind,
            currency: debit.currency,
            ownerUserId: debit.ownerUserId,
            gatewayKey: debit.gatewayKey,
          },
          tbAccountId: BigInt(debit.tbAccountId),
        },
        credit: {
          ref: {
            kind: credit.accountKind,
            currency: credit.currency,
            ownerUserId: credit.ownerUserId,
            gatewayKey: credit.gatewayKey,
          },
          tbAccountId: BigInt(credit.tbAccountId),
        },
      });
      if (applied.state === 'posted') result.posted++;
      else result.stillPending++;
    } catch (error) {
      if (error instanceof LedgerRefusedError) {
        result.refused++;
        continue;
      }
      result.stillPending++;
    }
  }

  return result;
}

/** Postings the ledger has not confirmed, for the operator surfaces. */
export async function listUnpostedPostings(limit = 50) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  return db
    .select()
    .from(ledgerPostings)
    .where(inArray(ledgerPostings.state, ['pending', 'refused', 'unavailable_no_ledger']))
    .orderBy(sql`${ledgerPostings.createdAt} DESC`)
    .limit(limit);
}
