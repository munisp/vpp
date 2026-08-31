/**
 * Durable prepaid token issuance.
 *
 * A customer who has paid must end up with either a token or a stated reason,
 * and neither an unreachable ledger nor a restarted API process is an acceptable
 * way to lose that obligation. This workflow is what carries it: it retries the
 * issuance step, and where a token is withheld for something that can pass — a
 * payment the provider has not confirmed yet — it waits and asks again, up to a
 * bounded number of attempts, instead of failing the customer on the first look.
 *
 * It never invents an outcome. When the last attempt still cannot vend, the
 * result says so, with the reason, and the account keeps its unissued state
 * visible in the app and to operators.
 */

import { proxyActivities, sleep } from '@temporalio/workflow';
import type * as activities from './prepaid-issuance-activities';

const {
  issuePrepaidTokenActivity,
  deliverPrepaidTokenActivity,
  accountConsumptionActivity,
  listPrepaidAccountIdsActivity,
} = proxyActivities<typeof activities>({
    startToCloseTimeout: '2 minutes',
    retry: {
      initialInterval: '2s',
      backoffCoefficient: 2,
      maximumInterval: '1 minute',
      maximumAttempts: 5,
    },
  });

export interface PrepaidIssuanceWorkflowInput {
  paymentId: number;
  accountId?: number;
  issuedBy?: number | null;
  /** How many times to look again while the payment is still unconfirmed. */
  maxAttempts?: number;
  /** How long to wait between those looks. */
  retryDelaySeconds?: number;
}

export interface PrepaidIssuanceWorkflowResult {
  paymentId: number;
  state: 'issued' | 'withheld';
  replay: boolean;
  tokenId: number | null;
  tokenCode: string | null;
  energyWh: number | null;
  reason: string | null;
  detail: string | null;
  delivered: boolean;
  deliveryReason: string | null;
  attempts: number;
}

/** Reasons that can become issuable later, so waiting and retrying is honest. */
const TRANSIENT_REASONS = new Set([
  'payment_not_confirmed',
  'unavailable_ledger_not_posted',
  'payment_evidence_missing',
]);

export async function prepaidIssuanceWorkflow(
  input: PrepaidIssuanceWorkflowInput
): Promise<PrepaidIssuanceWorkflowResult> {
  const maxAttempts = input.maxAttempts ?? 5;
  const delaySeconds = input.retryDelaySeconds ?? 30;

  let attempts = 0;
  let last = await issuePrepaidTokenActivity({
    paymentId: input.paymentId,
    accountId: input.accountId,
    issuedBy: input.issuedBy ?? null,
  });
  attempts += 1;

  while (
    last.state === 'withheld' &&
    last.reason !== null &&
    TRANSIENT_REASONS.has(last.reason) &&
    attempts < maxAttempts
  ) {
    await sleep(`${delaySeconds}s`);
    last = await issuePrepaidTokenActivity({
      paymentId: input.paymentId,
      accountId: input.accountId,
      issuedBy: input.issuedBy ?? null,
    });
    attempts += 1;
  }

  if (last.state !== 'issued' || last.tokenCode === null || last.energyWh === null) {
    return {
      paymentId: input.paymentId,
      state: 'withheld',
      replay: false,
      tokenId: null,
      tokenCode: null,
      energyWh: null,
      reason: last.reason,
      detail: last.detail,
      delivered: false,
      deliveryReason: null,
      attempts,
    };
  }

  const delivery = await deliverPrepaidTokenActivity({
    paymentId: input.paymentId,
    tokenCode: last.tokenCode,
    energyWh: last.energyWh,
  });

  return {
    paymentId: input.paymentId,
    state: 'issued',
    replay: last.replay,
    tokenId: last.tokenId,
    tokenCode: last.tokenCode,
    energyWh: last.energyWh,
    reason: null,
    detail: null,
    delivered: delivery.delivered,
    deliveryReason: delivery.reason,
    attempts,
  };
}

export interface PrepaidConsumptionSweepInput {
  accountIds: number[];
}

export interface PrepaidConsumptionSweepResult {
  accountsProcessed: number;
  segmentsRecorded: number;
  energyWh: number;
  accountsWithoutMeter: number;
}

/**
 * Bring a set of accounts' consumption up to date.
 *
 * Accounts with no meter integration are counted, not skipped silently: an
 * operator seeing "40 of 120 accounts have no meter behind them" knows the
 * platform cannot bill or disconnect those on measured use.
 */
export async function prepaidConsumptionSweepWorkflow(
  input: PrepaidConsumptionSweepInput
): Promise<PrepaidConsumptionSweepResult> {
  // An empty accountIds list means "sweep every prepaid account" — the daily
  // schedule uses this so accounts opened after the schedule was created are
  // included without anyone re-registering the schedule.
  const accountIds =
    input.accountIds.length > 0 ? input.accountIds : await listPrepaidAccountIdsActivity();

  let segmentsRecorded = 0;
  let energyWh = 0;
  let accountsWithoutMeter = 0;

  for (const accountId of accountIds) {
    const result = await accountConsumptionActivity({ accountId });
    segmentsRecorded += result.segmentsRecorded;
    energyWh += result.energyWh;
    if (result.unavailableReason === 'unavailable_no_meter_integration') {
      accountsWithoutMeter += 1;
    }
  }

  return {
    accountsProcessed: accountIds.length,
    segmentsRecorded,
    energyWh,
    accountsWithoutMeter,
  };
}
