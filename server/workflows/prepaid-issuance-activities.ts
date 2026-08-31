/**
 * Activities for durable prepaid token issuance.
 *
 * Issuance is one function (`issueTokenForPayment`) and it is already idempotent
 * by construction, so the activity is a thin durable wrapper rather than a
 * re-implementation: Temporal's contribution here is the retry of a step that
 * failed on an unreachable ledger or a database blip, and the guarantee that a
 * confirmed payment is not left with nobody ever coming back to vend for it.
 *
 * Retries are safe precisely because a second attempt reads back the token the
 * first one wrote instead of vending again.
 */

import {
  applyMeteredConsumption,
  issueTokenForPayment,
  PrepaidUnavailableError,
  type IssueOutcome,
} from '../services/prepaid-energy';
import { sendSMS } from '../_core/notifications';
import { getDb } from '../db';
import { payments } from '../../drizzle/schema';
import { prepaidAccounts } from '../../drizzle/prepaid-schema';
import { eq } from 'drizzle-orm';

/**
 * Every prepaid account is swept: accounts carry no active/inactive status —
 * a credited account is owed a truthful balance whether or not it consumed
 * recently. Accounts without meter integration surface through
 * accountsWithoutMeter in the sweep result, not by silent exclusion.
 */
export async function listPrepaidAccountIdsActivity(): Promise<number[]> {
  const db = await getDb();
  if (!db) throw new Error('database unavailable');
  const rows = await db.select({ id: prepaidAccounts.id }).from(prepaidAccounts);
  return rows.map(row => row.id);
}

export interface IssueTokenActivityInput {
  paymentId: number;
  accountId?: number;
  issuedBy?: number | null;
}

export interface IssueTokenActivityResult {
  state: 'issued' | 'withheld';
  replay: boolean;
  tokenId: number | null;
  tokenCode: string | null;
  energyWh: number | null;
  reason: string | null;
  detail: string | null;
}

export async function issuePrepaidTokenActivity(
  input: IssueTokenActivityInput
): Promise<IssueTokenActivityResult> {
  const outcome: IssueOutcome = await issueTokenForPayment(input);
  if (outcome.state === 'issued') {
    return {
      state: 'issued',
      replay: outcome.replay,
      tokenId: outcome.token.id,
      tokenCode: outcome.token.tokenCode,
      energyWh: outcome.token.energyWh,
      reason: null,
      detail: null,
    };
  }
  return {
    state: 'withheld',
    replay: false,
    tokenId: null,
    tokenCode: null,
    energyWh: null,
    reason: outcome.reason,
    detail: outcome.detail,
  };
}

export interface DeliverTokenActivityInput {
  paymentId: number;
  tokenCode: string;
  energyWh: number;
}

/**
 * Send the vended code to the phone that paid.
 *
 * Returns whether the provider accepted the message. A code that could not be
 * delivered is still a valid vend recorded against the account, and the customer
 * can retrieve it with `TOKEN RESEND` or in the app, so a failed send does not
 * fail the workflow — it is reported.
 */
export async function deliverPrepaidTokenActivity(
  input: DeliverTokenActivityInput
): Promise<{ delivered: boolean; reason: string | null }> {
  const db = await getDb();
  if (!db) return { delivered: false, reason: 'database_unavailable' };

  const [payment] = await db
    .select({ phoneNumber: payments.phoneNumber })
    .from(payments)
    .where(eq(payments.id, input.paymentId))
    .limit(1);

  const phone = payment?.phoneNumber?.trim() ?? '';
  if (phone.length === 0) {
    return { delivered: false, reason: 'no_phone_number_on_payment' };
  }

  const kwh = (input.energyWh / 1000).toFixed(2);
  const sent = await sendSMS({
    to: phone,
    message: `VPP Token: ${input.tokenCode}. Energy: ${kwh} kWh. Enter it on your meter.`,
  });
  return { delivered: sent, reason: sent ? null : 'sms_provider_did_not_accept' };
}

export interface AccountConsumptionActivityInput {
  accountId: number;
}

export interface AccountConsumptionActivityResult {
  segmentsRecorded: number;
  energyWh: number;
  resetGaps: number;
  remainingWh: number | null;
  unavailableReason: string | null;
}

/**
 * Bring an account's consumption up to date from its meter's register.
 *
 * A missing meter integration is returned as an unavailable reason rather than
 * thrown, so a scheduled sweep over many accounts is not stopped by the accounts
 * that have no meter behind them.
 */
export async function accountConsumptionActivity(
  input: AccountConsumptionActivityInput
): Promise<AccountConsumptionActivityResult> {
  try {
    const result = await applyMeteredConsumption({ accountId: input.accountId });
    return {
      segmentsRecorded: result.segmentsRecorded,
      energyWh: result.energyWh,
      resetGaps: result.resetGaps,
      remainingWh: result.balance.remainingWh,
      unavailableReason: result.balance.unavailableReason,
    };
  } catch (error) {
    if (error instanceof PrepaidUnavailableError) {
      return {
        segmentsRecorded: 0,
        energyWh: 0,
        resetGaps: 0,
        remainingWh: null,
        unavailableReason: error.reason,
      };
    }
    throw error;
  }
}
