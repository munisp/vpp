/**
 * The one way a confirmed payment becomes a prepaid token.
 *
 * Both the payment verification route and the gateway callback come through
 * here, so a token is vended the same way whichever confirmed the payment, and
 * a replay of either produces the token that already exists rather than a second
 * one.
 *
 * Durability is Temporal's job, and it is best-effort *on top of* the in-process
 * attempt, never instead of it: the token is vended here and now if it can be,
 * and a workflow is started only to keep asking when the vend was withheld for
 * something that may pass. If Temporal is unreachable the caller still gets the
 * true outcome — including "not vended, and nothing is retrying" — instead of a
 * promise the platform cannot keep.
 */

import { issueTokenForPayment, PrepaidError, type IssueOutcome } from './prepaid-energy';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { getTemporalClient, TASK_QUEUES } from '../integration/temporal-config';

export interface PrepaidIssuanceEntryResult {
  /** Whether a real, meter-acceptable token now exists for this payment. */
  issued: boolean;
  tokenCode: string | null;
  energyWh: number | null;
  /** Present when no token was vended: why, in the service's own vocabulary. */
  reason: string | null;
  detail: string | null;
  /** Whether a durable workflow is now retrying the withheld issuance. */
  retryScheduled: boolean;
}

/** Reasons a later attempt could legitimately succeed. */
const RETRYABLE_REASONS = new Set([
  'payment_not_confirmed',
  'payment_evidence_missing',
  'unavailable_ledger_not_posted',
]);

export async function issuePrepaidTokenForPayment(input: {
  paymentId: number;
  accountId?: number;
  issuedBy?: number | null;
}): Promise<PrepaidIssuanceEntryResult> {
  let outcome: IssueOutcome;
  try {
    outcome = await issueTokenForPayment(input);
  } catch (error) {
    if (error instanceof PrepaidError) {
      return {
        issued: false,
        tokenCode: null,
        energyWh: null,
        reason: 'prepaid_account_not_resolved',
        detail: error.message,
        retryScheduled: false,
      };
    }
    throw error;
  }

  if (outcome.state === 'issued') {
    return {
      issued: true,
      tokenCode: outcome.token.tokenCode,
      energyWh: outcome.token.energyWh,
      reason: null,
      detail: null,
      retryScheduled: false,
    };
  }

  const retryScheduled = RETRYABLE_REASONS.has(outcome.reason)
    ? await startIssuanceWorkflow(input)
    : false;

  return {
    issued: false,
    tokenCode: null,
    energyWh: null,
    reason: outcome.reason,
    detail: outcome.detail,
    retryScheduled,
  };
}

/**
 * Start the durable issuance workflow, keyed by the payment so a second call
 * joins the running one instead of racing it.
 */
async function startIssuanceWorkflow(input: {
  paymentId: number;
  accountId?: number;
  issuedBy?: number | null;
}): Promise<boolean> {
  try {
    const client = await getTemporalClient();
    await client.workflow.start('prepaidIssuanceWorkflow', {
      taskQueue: TASK_QUEUES.PREPAID_ISSUANCE,
      workflowId: `prepaid-issuance-${input.paymentId}`,
      args: [
        {
          paymentId: input.paymentId,
          accountId: input.accountId,
          issuedBy: input.issuedBy ?? null,
        },
      ],
    });
    return true;
  } catch (error) {
    if (error instanceof WorkflowExecutionAlreadyStartedError) {
      // One workflow per payment is the point of the deterministic id: an
      // already-running issuance is the retry this call was asking for.
      return true;
    }
    // Temporal being unreachable must not turn a withheld token into a claimed
    // one, and must not fail the payment either: the payment is confirmed and
    // the energy is owed. It is reported as not being retried.
    console.warn(
      `[prepaid] no durable retry for payment ${input.paymentId}:`,
      error instanceof Error ? error.message : error
    );
    return false;
  }
}
