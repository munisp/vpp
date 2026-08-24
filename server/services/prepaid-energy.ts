/**
 * Prepaid / pay-as-you-go energy accounts.
 *
 * The order of events here is the whole feature, and it only runs one way:
 *
 *   1. the payment provider confirmed money (a `payments` row that is
 *      `completed`, carrying the provider's own reference);
 *   2. that money is posted to the double-entry ledger and the ledger said
 *      `posted`;
 *   3. only then is a token vended, recorded, and the account credited.
 *
 * A step that cannot be completed stops the chain and is reported as itself: no
 * ledger means no token, and a customer sees "not yet issued, and why" rather
 * than digits their meter will reject. Nothing in this module invents a code, a
 * balance, or a confirmation.
 *
 * Idempotency is structural rather than defensive. A token's identity is
 * `(account, payment, sequence)` and its OpenPAYGO count is unique per account,
 * so a payment callback delivered five times issues one token: the second
 * attempt loses the insert and reads back the token the first one vended.
 *
 * Consumption is measured, never elapsed. The only thing that reduces a balance
 * is movement of the meter's cumulative register; with no meter behind the
 * account, remaining credit is reported as unavailable, because the platform
 * genuinely does not know it.
 */

import { and, asc, desc, eq, gt, inArray, like, sql } from 'drizzle-orm';
import { getDb } from '../db';
import {
  prepaidAccounts,
  prepaidConsumption,
  prepaidSupplyEvents,
  prepaidTokens,
  type PrepaidAccountRow,
  type PrepaidAccountStatus,
  type PrepaidConsumptionRow,
  type PrepaidSupplyEventRow,
  type PrepaidSupplyReason,
  type PrepaidTokenRow,
} from '../../drizzle/prepaid-schema';
import { assets, payments, telemetry, tokens } from '../../drizzle/schema';
import type { LedgerCurrency } from '../../drizzle/ledger-schema';
import {
  consumptionFromRegister,
  energyWhForPayment,
  prepaidBalance,
  PrepaidAccountingError,
  type PrepaidBalance,
} from './prepaid-accounting';
import {
  decodeTokenAsDevice,
  vendAddValueToken,
  vendingConfigured,
  VendingUnavailableError,
  type MeterAcceptanceReason,
} from './prepaid-openpaygo';
import { postPrepaidCreditPurchased } from './ledger/postings';

/** A refusal to act, with the reason a caller and a customer can both read. */
export type PrepaidUnavailableReason =
  | 'unavailable_no_meter_integration'
  | 'unavailable_no_vending_keyring'
  | 'unavailable_no_token_key'
  | 'unavailable_keyring_unreadable'
  | 'unavailable_scheme_not_implemented'
  | 'unavailable_ledger_not_posted';

export class PrepaidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrepaidError';
  }
}

export class PrepaidUnavailableError extends Error {
  readonly reason: PrepaidUnavailableReason;

  constructor(reason: PrepaidUnavailableReason, message: string) {
    super(message);
    this.name = 'PrepaidUnavailableError';
    this.reason = reason;
  }
}

async function database() {
  const db = await getDb();
  if (!db) throw new PrepaidError('Database not available');
  return db;
}

export interface OpenAccountInput {
  userId: number;
  meterSerial: string;
  deviceProfile: string;
  keyRef: string;
  startingCode: number;
  tariffMinorPerKwh: number;
  currency: LedgerCurrency;
  whPerValueUnit?: number;
  meterAssetId?: number | null;
  notes?: string | null;
}

/**
 * Open a prepaid account for a customer's meter.
 *
 * The device details are required rather than defaulted: a starting code, a key
 * reference and a device profile are what make a vended token acceptable to the
 * hardware, and guessing any of them produces tokens that fail in the field.
 */
export async function openPrepaidAccount(
  input: OpenAccountInput,
  openedBy: number
): Promise<PrepaidAccountRow> {
  const db = await database();

  const serial = input.meterSerial.trim();
  if (serial.length === 0) {
    throw new PrepaidError('A prepaid account must name the meter serial it vends for');
  }
  const profile = input.deviceProfile.trim();
  if (profile.length === 0) {
    throw new PrepaidError(
      'A prepaid account must declare the device profile that says how the meter reads a token value'
    );
  }
  const keyRef = input.keyRef.trim();
  if (keyRef.length === 0) {
    throw new PrepaidError('A prepaid account must name the keyring entry its device key is held under');
  }
  if (!Number.isInteger(input.startingCode) || input.startingCode < 0) {
    throw new PrepaidError('The OpenPAYGO starting code must be a whole non-negative number');
  }
  if (!Number.isInteger(input.tariffMinorPerKwh) || input.tariffMinorPerKwh <= 0) {
    throw new PrepaidError('A prepaid tariff must be a whole positive number of minor units per kWh');
  }
  const whPerValueUnit = input.whPerValueUnit ?? 100;
  if (!Number.isInteger(whPerValueUnit) || whPerValueUnit <= 0) {
    throw new PrepaidError('The device unit must be a whole positive number of watt-hours');
  }

  if (input.meterAssetId !== undefined && input.meterAssetId !== null) {
    const [asset] = await db
      .select({ id: assets.id })
      .from(assets)
      .where(eq(assets.id, input.meterAssetId))
      .limit(1);
    if (!asset) {
      throw new PrepaidError(`Asset ${input.meterAssetId} does not exist, so it cannot meter this account`);
    }
  }

  const [row] = await db
    .insert(prepaidAccounts)
    .values({
      userId: input.userId,
      meterAssetId: input.meterAssetId ?? null,
      meterSerial: serial,
      scheme: 'openpaygo',
      deviceProfile: profile,
      keyRef,
      startingCode: input.startingCode,
      whPerValueUnit,
      tariffMinorPerKwh: input.tariffMinorPerKwh,
      currency: input.currency,
      openedBy,
      notes: input.notes ?? null,
    })
    .returning();

  return row;
}

export async function listPrepaidAccounts(
  filter: { userId?: number; status?: PrepaidAccountStatus } = {}
): Promise<PrepaidAccountRow[]> {
  const db = await database();
  const conditions = [];
  if (filter.userId !== undefined) conditions.push(eq(prepaidAccounts.userId, filter.userId));
  if (filter.status !== undefined) conditions.push(eq(prepaidAccounts.status, filter.status));

  return conditions.length === 0
    ? db.select().from(prepaidAccounts).orderBy(desc(prepaidAccounts.id))
    : db
        .select()
        .from(prepaidAccounts)
        .where(conditions.length === 1 ? conditions[0] : and(...conditions))
        .orderBy(desc(prepaidAccounts.id));
}

async function accountOrThrow(accountId: number): Promise<PrepaidAccountRow> {
  const db = await database();
  const [account] = await db
    .select()
    .from(prepaidAccounts)
    .where(eq(prepaidAccounts.id, accountId))
    .limit(1);
  if (!account) throw new PrepaidError(`Prepaid account ${accountId} does not exist`);
  return account;
}

/** The account a payment's energy belongs to, as declared on the payment itself. */
function accountIdFromPaymentMetadata(metadata: string | null): number | null {
  if (!metadata) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record: Record<string, unknown> = parsed as Record<string, unknown>;
  const value = record.prepaidAccountId;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

export type IssueOutcome =
  | { state: 'issued'; token: PrepaidTokenRow; replay: false }
  | { state: 'issued'; token: PrepaidTokenRow; replay: true }
  | {
      state: 'withheld';
      reason: PrepaidUnavailableReason | 'payment_not_confirmed' | 'payment_evidence_missing' | 'ledger_refused';
      detail: string;
    };

/**
 * Issue the token a confirmed payment bought.
 *
 * Returns a `withheld` outcome rather than throwing for the states a customer is
 * entitled to see (payment not confirmed yet, no vending key for their meter, the
 * ledger did not post), because each of those is an answer. It throws only when
 * the request itself makes no sense — an unknown payment, a payment that is not a
 * token purchase, an account that is not the payer's.
 */
export async function issueTokenForPayment(input: {
  paymentId: number;
  accountId?: number;
  issuedBy?: number | null;
}): Promise<IssueOutcome> {
  const db = await database();

  const [payment] = await db.select().from(payments).where(eq(payments.id, input.paymentId)).limit(1);
  if (!payment) throw new PrepaidError(`Payment ${input.paymentId} does not exist`);
  if (payment.paymentType !== 'token_purchase') {
    throw new PrepaidError(
      `Payment ${payment.id} is a ${payment.paymentType}, not a token purchase, so it buys no prepaid energy`
    );
  }

  const accountId =
    input.accountId ?? accountIdFromPaymentMetadata(payment.metadata) ?? (await soleAccountIdFor(payment.userId));
  if (accountId === null) {
    throw new PrepaidError(
      `Payment ${payment.id} does not say which prepaid meter it is for, and its payer has no single prepaid account`
    );
  }

  const account = await accountOrThrow(accountId);
  if (account.userId !== payment.userId) {
    throw new PrepaidError(
      `Prepaid account ${account.id} belongs to another customer than the payer of payment ${payment.id}`
    );
  }

  // A token already vended for this payment is the answer, whatever the caller
  // believes: this is the replayed-callback path.
  const [existing] = await db
    .select()
    .from(prepaidTokens)
    .where(and(eq(prepaidTokens.accountId, account.id), eq(prepaidTokens.paymentId, payment.id)))
    .orderBy(asc(prepaidTokens.sequence))
    .limit(1);
  if (existing) return { state: 'issued', token: existing, replay: true };

  if (payment.status !== 'completed') {
    return {
      state: 'withheld',
      reason: 'payment_not_confirmed',
      detail: `Payment ${payment.id} is ${payment.status}: no energy is credited until the provider confirms the money`,
    };
  }
  const providerReference = (payment.transactionId ?? '').trim();
  if (providerReference.length === 0) {
    return {
      state: 'withheld',
      reason: 'payment_evidence_missing',
      detail: `Payment ${payment.id} is marked completed but carries no provider reference, so there is no evidence money arrived`,
    };
  }
  if (account.scheme !== 'openpaygo') {
    return {
      state: 'withheld',
      reason: 'unavailable_scheme_not_implemented',
      detail: `Account ${account.id} vends on ${account.scheme}, which this deployment has no vending integration for`,
    };
  }
  if (!vendingConfigured()) {
    return {
      state: 'withheld',
      reason: 'unavailable_no_vending_keyring',
      detail:
        'No OpenPAYGO keyring is configured in this deployment, so no token can be vended for any meter. The payment stands and the energy is owed.',
    };
  }

  let energyWh: number;
  try {
    ({ energyWh } = energyWhForPayment({
      amountMinor: payment.amount,
      tariffMinorPerKwh: account.tariffMinorPerKwh,
    }));
  } catch (error) {
    if (error instanceof PrepaidAccountingError) {
      throw new PrepaidError(error.message);
    }
    throw error;
  }

  // The money is posted before the energy is vended. A token is a promise the
  // platform has to honour; it is not made until the movement that pays for it
  // is on the ledger.
  const posting = await postPrepaidCreditPurchased({
    paymentId: payment.id,
    customerUserId: account.userId,
    gatewayKey: payment.paymentMethod,
    currency: account.currency,
    amountMinor: payment.amount,
    providerReference,
  });
  if (posting.state !== 'posted') {
    return {
      state: 'withheld',
      reason: posting.state === 'refused' ? 'ledger_refused' : 'unavailable_ledger_not_posted',
      detail: `The purchase is not on the ledger (${posting.state}): ${posting.detail}. No token is vended until it is.`,
    };
  }

  let vended;
  try {
    vended = vendAddValueToken({
      keyRef: account.keyRef,
      startingCode: account.startingCode,
      lastCount: account.tokenCount,
      energyWh,
      whPerValueUnit: account.whPerValueUnit,
    });
  } catch (error) {
    if (error instanceof VendingUnavailableError) {
      return {
        state: 'withheld',
        reason:
          error.refusal === 'unavailable_no_token_key'
            ? 'unavailable_no_token_key'
            : 'unavailable_keyring_unreadable',
        detail: error.message,
      };
    }
    if (error instanceof PrepaidAccountingError) {
      throw new PrepaidError(error.message);
    }
    throw error;
  }

  const token = await db.transaction(async (tx) => {
    // Claim the count under the account row: the update only applies if the
    // account is still at the count this token was vended against, so two
    // concurrent callbacks cannot both vend at the same count.
    const claimed = await tx
      .update(prepaidAccounts)
      .set({
        tokenCount: vended.tokenCount,
        creditedWh: sql`${prepaidAccounts.creditedWh} + ${energyWh}`,
      })
      .where(and(eq(prepaidAccounts.id, account.id), eq(prepaidAccounts.tokenCount, account.tokenCount)))
      .returning({ id: prepaidAccounts.id });
    if (claimed.length === 0) {
      throw new ConcurrentVendError(account.id);
    }

    const [inserted] = await tx
      .insert(prepaidTokens)
      .values({
        accountId: account.id,
        paymentId: payment.id,
        sequence: 0,
        scheme: 'openpaygo',
        tokenCode: vended.tokenCode,
        tokenCount: vended.tokenCount,
        tokenType: vended.tokenType,
        energyWh,
        valueUnits: vended.valueUnits,
        amountMinor: payment.amount,
        currency: account.currency,
        providerReference,
        ledgerPostingId: posting.postingId,
        issuedBy: input.issuedBy ?? null,
      })
      .returning();

    // The legacy `tokens` table is what the SMS commands, the payments page and
    // the notification emails read. Writing the vend there too keeps one token
    // visible in every surface instead of splitting the customer's history in
    // two.
    //
    // A payment that could not be vended when it confirmed already holds a
    // `PENDING_ISSUANCE_<id>` row there, so this *replaces* that row rather than
    // adding a second one: two rows for one payment would leave those surfaces
    // free to read the placeholder and hand the customer that literal string
    // where their digits belong, and to keep showing a token that is pending
    // forever.
    const legacyValues = {
      tokenCode: vended.tokenCode,
      energyKwh: Math.floor(energyWh / 1000),
      amount: payment.amount,
      validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      status: 'active' as const,
      metadata: JSON.stringify({
        scheme: 'openpaygo',
        prepaidAccountId: account.id,
        prepaidTokenId: inserted.id,
        energyWh,
        tokenCount: vended.tokenCount,
      }),
    };

    const replaced = await tx
      .update(tokens)
      .set(legacyValues)
      .where(
        and(
          eq(tokens.userId, account.userId),
          eq(tokens.paymentId, payment.id),
          like(tokens.tokenCode, 'PENDING_ISSUANCE_%')
        )
      )
      .returning({ id: tokens.id });

    if (replaced.length === 0) {
      await tx
        .insert(tokens)
        .values({ userId: account.userId, paymentId: payment.id, ...legacyValues })
        .onConflictDoNothing({ target: [tokens.userId, tokens.tokenCode] });
    }

    return inserted;
  });

  return { state: 'issued', token, replay: false };
}

class ConcurrentVendError extends PrepaidError {
  constructor(accountId: number) {
    super(
      `Another vend advanced prepaid account ${accountId}'s token count while this one was in flight; retry to vend at the new count`
    );
    this.name = 'ConcurrentVendError';
  }
}

async function soleAccountIdFor(userId: number): Promise<number | null> {
  const db = await database();
  const rows = await db
    .select({ id: prepaidAccounts.id })
    .from(prepaidAccounts)
    .where(and(eq(prepaidAccounts.userId, userId), eq(prepaidAccounts.status, 'active')))
    .limit(2);
  return rows.length === 1 ? rows[0].id : null;
}

export async function listPrepaidTokens(
  filter: { accountId?: number; userId?: number; limit?: number } = {}
): Promise<PrepaidTokenRow[]> {
  const db = await database();
  const conditions = [];
  if (filter.accountId !== undefined) conditions.push(eq(prepaidTokens.accountId, filter.accountId));
  if (filter.userId !== undefined) {
    conditions.push(
      inArray(
        prepaidTokens.accountId,
        db.select({ id: prepaidAccounts.id }).from(prepaidAccounts).where(eq(prepaidAccounts.userId, filter.userId))
      )
    );
  }

  const query = db.select().from(prepaidTokens);
  const filtered =
    conditions.length === 0
      ? query
      : query.where(conditions.length === 1 ? conditions[0] : and(...conditions));
  return filtered.orderBy(desc(prepaidTokens.issuedAt)).limit(filter.limit ?? 100);
}

/**
 * Check a token the way the customer's device would, using the counts this
 * account has already had accepted.
 *
 * A token this account has already redeemed is answered from the platform's own
 * record, which is what it recorded a device accepting; only a code with no
 * settled outcome here goes to the standard's decoder. Deciding it the other way
 * round would make the answer depend on the decoder agreeing with the ledger of
 * redemptions, and the reference decoder can fail to answer at all. It asserts
 * nothing about physical hardware either way.
 */
export async function checkTokenAgainstDevice(input: {
  accountId: number;
  tokenCode: string;
}): Promise<{
  accepted: boolean;
  reason: MeterAcceptanceReason;
  valueUnits: number | null;
  energyWh: number | null;
}> {
  const account = await accountOrThrow(input.accountId);
  const db = await database();
  const code = input.tokenCode.trim();

  const [known] = await db
    .select()
    .from(prepaidTokens)
    .where(and(eq(prepaidTokens.accountId, account.id), eq(prepaidTokens.tokenCode, code)))
    .limit(1);
  if (known && known.status === 'redeemed') {
    return {
      accepted: false,
      reason: 'already_used',
      valueUnits: known.valueUnits,
      energyWh: known.energyWh,
    };
  }
  if (known && known.status === 'void') {
    return { accepted: false, reason: 'invalid', valueUnits: null, energyWh: null };
  }

  const redeemed = await db
    .select({ tokenCount: prepaidTokens.tokenCount })
    .from(prepaidTokens)
    .where(and(eq(prepaidTokens.accountId, account.id), eq(prepaidTokens.status, 'redeemed')))
    .orderBy(asc(prepaidTokens.tokenCount));

  const usedCounts = redeemed.map((row) => row.tokenCount);
  const decoded = decodeTokenAsDevice({
    keyRef: account.keyRef,
    startingCode: account.startingCode,
    token: code,
    // The device's own count is the highest it has accepted, or the account's
    // seed count when it has accepted none.
    lastCount: usedCounts.length > 0 ? usedCounts[usedCounts.length - 1] : 1,
    usedCounts,
  });

  return {
    accepted: decoded.accepted,
    reason: decoded.reason,
    valueUnits: decoded.valueUnits,
    energyWh: decoded.valueUnits === null ? null : decoded.valueUnits * account.whPerValueUnit,
  };
}

/**
 * Record that a device accepted a token.
 *
 * Single use is enforced twice over: the standard's decoder refuses a count the
 * device has already taken, and the row itself can only move from `issued` to
 * `redeemed` once, under a conditional update. Evidence is required — a
 * redemption with nothing behind it is a claim, not a fact.
 */
export async function recordTokenRedemption(input: {
  accountId: number;
  tokenCode: string;
  evidenceRef: string;
  redeemedAt?: Date;
}): Promise<PrepaidTokenRow> {
  const db = await database();
  const evidence = input.evidenceRef.trim();
  if (evidence.length === 0) {
    throw new PrepaidError('A redemption must reference what proves the meter accepted the token');
  }
  const account = await accountOrThrow(input.accountId);

  const code = input.tokenCode.trim();
  const [token] = await db
    .select()
    .from(prepaidTokens)
    .where(and(eq(prepaidTokens.accountId, input.accountId), eq(prepaidTokens.tokenCode, code)))
    .limit(1);
  if (!token) {
    throw new PrepaidError(`No token ${code} was vended for prepaid account ${input.accountId}`);
  }
  if (token.status === 'redeemed') {
    throw new PrepaidError(
      `Token ${code} was already redeemed at ${token.redeemedAt?.toISOString() ?? 'an unrecorded time'}; a token credits a meter once`
    );
  }
  if (token.status === 'void') {
    throw new PrepaidError(`Token ${code} was voided (${token.voidReason ?? 'no reason recorded'}) and cannot be redeemed`);
  }

  const [updated] = await db
    .update(prepaidTokens)
    .set({
      status: 'redeemed',
      redeemedAt: input.redeemedAt ?? new Date(),
      redemptionEvidenceRef: evidence,
    })
    .where(and(eq(prepaidTokens.id, token.id), eq(prepaidTokens.status, 'issued')))
    .returning();
  if (!updated) {
    throw new PrepaidError(`Token ${code} was redeemed by another request while this one was in flight`);
  }

  // Also mark this customer's legacy row, so the SMS and payments surfaces stop
  // offering a code the meter will no longer take. Scoped to the account's owner:
  // the same digits can be another customer's live token.
  await db
    .update(tokens)
    .set({ status: 'used', usedAt: updated.redeemedAt ?? new Date() })
    .where(and(eq(tokens.tokenCode, code), eq(tokens.userId, account.userId)));

  return updated;
}

export interface ConsumptionResult {
  accountId: number;
  segmentsRecorded: number;
  energyWh: number;
  resetGaps: number;
  /** Null when readings were found; a reason when nothing could be measured. */
  reason: 'no_meter_readings' | 'no_new_readings' | null;
  balance: PrepaidBalance;
}

/**
 * Account for energy the meter says was taken.
 *
 * Reads the meter asset's cumulative energy register forward from the last
 * reading already accounted for, and records the differences. Time never appears
 * in this calculation: an account whose meter has been silent for a week has an
 * unknown consumption for that week, not a free one.
 */
export async function applyMeteredConsumption(input: {
  accountId: number;
  until?: Date;
}): Promise<ConsumptionResult> {
  const db = await database();
  const account = await accountOrThrow(input.accountId);

  if (account.meterAssetId === null) {
    throw new PrepaidUnavailableError(
      'unavailable_no_meter_integration',
      `Prepaid account ${account.id} has no meter behind it, so the energy taken on it cannot be measured. Credit is recorded; consumption is unknown.`
    );
  }

  const cursorAt = account.meterReadingAt;
  const rows = await db
    .select({ at: telemetry.timestamp, energy: telemetry.energy })
    .from(telemetry)
    .where(
      cursorAt
        ? and(
            eq(telemetry.assetId, account.meterAssetId),
            gt(telemetry.timestamp, cursorAt),
            sql`${telemetry.energy} IS NOT NULL`
          )
        : and(eq(telemetry.assetId, account.meterAssetId), sql`${telemetry.energy} IS NOT NULL`)
    )
    .orderBy(asc(telemetry.timestamp))
    .limit(5000);

  const readings = rows
    .filter((row): row is { at: Date; energy: number } => row.energy !== null)
    .map((row) => ({ at: row.at, registerWh: row.energy }));

  if (readings.length === 0) {
    const balance = await balanceForAccount(account);
    return {
      accountId: account.id,
      segmentsRecorded: 0,
      energyWh: 0,
      resetGaps: 0,
      reason: cursorAt ? 'no_new_readings' : 'no_meter_readings',
      balance,
    };
  }

  const cursor =
    cursorAt !== null && account.meterRegisterWh !== null
      ? { at: cursorAt, registerWh: account.meterRegisterWh }
      : null;
  const segments = consumptionFromRegister({ cursor, readings });

  let consumedWh = 0;
  let recorded = 0;
  let resetGaps = 0;

  for (const segment of segments) {
    const inserted = await db
      .insert(prepaidConsumption)
      .values({
        accountId: account.id,
        fromAt: segment.fromAt,
        toAt: segment.toAt,
        registerStartWh: segment.registerStartWh,
        registerEndWh: segment.registerEndWh,
        energyWh: segment.energyWh,
        source: segment.source,
        evidenceRef: `telemetry:asset=${account.meterAssetId}:${segment.fromAt.toISOString()}..${segment.toAt.toISOString()}`,
        detail: segment.detail,
      })
      .onConflictDoNothing({ target: [prepaidConsumption.accountId, prepaidConsumption.toAt] })
      .returning({ id: prepaidConsumption.id });

    if (inserted.length === 0) continue;
    recorded += 1;
    consumedWh += segment.energyWh;
    if (segment.source === 'meter_reset_gap') resetGaps += 1;
  }

  const last = readings[readings.length - 1];
  const [updated] = await db
    .update(prepaidAccounts)
    .set({
      consumedWh: sql`${prepaidAccounts.consumedWh} + ${consumedWh}`,
      meterRegisterWh: last.registerWh,
      meterReadingAt: last.at,
    })
    .where(eq(prepaidAccounts.id, account.id))
    .returning();

  return {
    accountId: account.id,
    segmentsRecorded: recorded,
    energyWh: consumedWh,
    resetGaps,
    reason: null,
    balance: await balanceForAccount(updated),
  };
}

async function balanceForAccount(account: PrepaidAccountRow): Promise<PrepaidBalance> {
  return prepaidBalance({
    creditedWh: account.creditedWh,
    consumedWh: account.consumedWh,
    meterIntegrated: account.meterAssetId !== null,
  });
}

export interface PrepaidAccountView {
  account: PrepaidAccountRow;
  balance: PrepaidBalance;
  /** The most recent vend, so a customer can be shown or re-sent their code. */
  latestToken: PrepaidTokenRow | null;
  tokensIssued: number;
  tokensRedeemed: number;
  latestConsumption: PrepaidConsumptionRow | null;
  latestSupplyEvent: PrepaidSupplyEventRow | null;
  /** Whether this deployment can vend for this account at all. */
  vendingAvailable: boolean;
}

export async function prepaidAccountView(accountId: number): Promise<PrepaidAccountView> {
  const db = await database();
  const account = await accountOrThrow(accountId);

  const [latestToken] = await db
    .select()
    .from(prepaidTokens)
    .where(eq(prepaidTokens.accountId, account.id))
    .orderBy(desc(prepaidTokens.issuedAt))
    .limit(1);

  const [counts] = await db
    .select({
      issued: sql<number>`count(*) filter (where ${prepaidTokens.status} = 'issued')::int`,
      redeemed: sql<number>`count(*) filter (where ${prepaidTokens.status} = 'redeemed')::int`,
    })
    .from(prepaidTokens)
    .where(eq(prepaidTokens.accountId, account.id));

  const [latestConsumption] = await db
    .select()
    .from(prepaidConsumption)
    .where(eq(prepaidConsumption.accountId, account.id))
    .orderBy(desc(prepaidConsumption.toAt))
    .limit(1);

  const [latestSupplyEvent] = await db
    .select()
    .from(prepaidSupplyEvents)
    .where(eq(prepaidSupplyEvents.accountId, account.id))
    .orderBy(desc(prepaidSupplyEvents.createdAt))
    .limit(1);

  return {
    account,
    balance: await balanceForAccount(account),
    latestToken: latestToken ?? null,
    tokensIssued: counts?.issued ?? 0,
    tokensRedeemed: counts?.redeemed ?? 0,
    latestConsumption: latestConsumption ?? null,
    latestSupplyEvent: latestSupplyEvent ?? null,
    vendingAvailable: vendingConfigured(),
  };
}

export async function listPrepaidConsumption(
  accountId: number,
  limit = 100
): Promise<PrepaidConsumptionRow[]> {
  const db = await database();
  return db
    .select()
    .from(prepaidConsumption)
    .where(eq(prepaidConsumption.accountId, accountId))
    .orderBy(desc(prepaidConsumption.toAt))
    .limit(limit);
}

export async function listSupplyEvents(accountId: number, limit = 100): Promise<PrepaidSupplyEventRow[]> {
  const db = await database();
  return db
    .select()
    .from(prepaidSupplyEvents)
    .where(eq(prepaidSupplyEvents.accountId, accountId))
    .orderBy(desc(prepaidSupplyEvents.createdAt))
    .limit(limit);
}

/**
 * Record a supply decision on an account.
 *
 * `enforcedAtMeter` defaults to false and stays false unless a device reported
 * back: the platform can decide to disconnect, but on a deployment with no meter
 * integration it cannot claim the customer's supply changed.
 */
export async function recordSupplyDecision(input: {
  accountId: number;
  action: 'disconnect' | 'reconnect';
  reason: PrepaidSupplyReason;
  actorUserId?: number | null;
  evidenceRef?: string | null;
  enforcedAtMeter?: boolean;
  detail?: string | null;
}): Promise<PrepaidSupplyEventRow> {
  const db = await database();
  const account = await accountOrThrow(input.accountId);

  if (input.enforcedAtMeter === true && (input.evidenceRef ?? '').trim().length === 0) {
    throw new PrepaidError(
      'Claiming a meter enforced a disconnection needs the evidence it reported; without it the decision is recorded as unenforced'
    );
  }

  const [event] = await db
    .insert(prepaidSupplyEvents)
    .values({
      accountId: account.id,
      action: input.action,
      reason: input.reason,
      actorUserId: input.actorUserId ?? null,
      enforcedAtMeter: input.enforcedAtMeter ?? false,
      evidenceRef: input.evidenceRef?.trim() ? input.evidenceRef.trim() : null,
      detail: input.detail ?? null,
    })
    .returning();

  await db
    .update(prepaidAccounts)
    .set({ status: input.action === 'disconnect' ? 'disconnected' : 'active' })
    .where(eq(prepaidAccounts.id, account.id));

  return event;
}
