/**
 * Temporal Payment Workflow
 * 
 * Orchestrates the complete payment lifecycle with retry logic,
 * timeout handling, and compensation workflows.
 */

import { proxyActivities, sleep } from '@temporalio/workflow';
import type * as activities from './payment-activities';

/**
 * Activities are invoked through Temporal proxies so they execute on the
 * worker (with retries) instead of being called directly inside the
 * deterministic workflow sandbox.
 */
const {
  initiatePaymentActivity,
  verifyPaymentActivity,
  updatePaymentStatusActivity,
  updateBillingStatusActivity,
  sendPaymentNotificationActivity,
  refundPaymentActivity,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: {
    initialInterval: '1s',
    backoffCoefficient: 2,
    maximumInterval: '60s',
    maximumAttempts: 5,
  },
});

/**
 * Payment Workflow Configuration
 *
 * The tRPC router (paymentProcessing.initiatePayment) initiates the charge
 * and writes the payment row BEFORE starting this workflow, then passes its
 * id. The workflow must therefore adopt that payment — re-initiating would
 * charge the customer twice. `amount` is in the platform's canonical minor
 * units (cents); the workflow never scales it.
 */
export interface PaymentWorkflowInput {
  /** Id of the payment row created (and gateway-initiated) by the caller. */
  paymentId?: number;
  userId: number;
  billingId: number;
  amount: number; // cents
  gateway: 'mpesa' | 'airtel' | 'tigo' | 'airtel_money' | 'tigo_pesa';
  phoneNumber: string;
  currency?: string;
  metadata?: Record<string, any>;
}

export interface PaymentWorkflowResult {
  success: boolean;
  transactionId?: string;
  error?: string;
}

/**
 * Main Payment Workflow (Temporal workflow type: "processPayment")
 *
 * Orchestrates the full payment lifecycle:
 * 1. Initiate payment with the mobile-money gateway.
 * 2. Poll for confirmation with Temporal timers between attempts.
 * 3. Update payment and billing status on success.
 * 4. Send user notification.
 * 5. Compensate (mark failed, notify) on any error.
 *
 * Exported under the exact type name the Temporal client starts
 * (server/integration/temporal-client.ts uses 'processPayment').
 */
export async function processPayment(
  input: PaymentWorkflowInput
): Promise<PaymentWorkflowResult> {
  let transactionId: string | undefined;

  // The Temporal client (integration/temporal-client.ts) passes ids as
  // strings and carries billingId in metadata; normalise once, deterministically.
  const userId = Number(input.userId);
  const billingId = Number(input.billingId ?? input.metadata?.billingId);
  const paymentId =
    input.paymentId !== undefined && input.paymentId !== null
      ? Number(input.paymentId)
      : input.metadata?.paymentId
        ? Number(input.metadata.paymentId)
        : undefined;

  try {
    // Step 1: Adopt the caller-initiated payment, or initiate when this
    // workflow is the first mover (no paymentId supplied).
    const initiateResult = await initiatePaymentActivity({
      userId,
      billingId,
      amount: input.amount,
      gateway: input.gateway,
      phoneNumber: input.phoneNumber,
      paymentId,
    });

    if (!initiateResult.success || !initiateResult.transactionId) {
      throw new Error(initiateResult.error || 'Payment initiation failed');
    }

    transactionId = initiateResult.transactionId;

    // Step 2: Poll for payment confirmation.
    // Uses Temporal's deterministic timer so history replays correctly.
    let verified = false;
    let attempts = 0;
    const maxAttempts = 5;
    const verifyDelayMs = 10_000; // 10 seconds between polls

    while (!verified && attempts < maxAttempts) {
      attempts++;

      // Deterministic Temporal timer — safe for workflow replay.
      await sleep(verifyDelayMs);

      const verifyResult = await verifyPaymentActivity(
        transactionId,
        input.gateway
      );

      if (verifyResult.success) {
        verified = true;
      } else if (attempts >= maxAttempts) {
        throw new Error('Payment verification timeout after ' + maxAttempts + ' attempts');
      }
    }

    // Step 3: Update payment status to completed
    await updatePaymentStatusActivity(transactionId, 'completed', {
      amount: input.amount,
      gateway: input.gateway,
    });

    // Step 4: Update billing status to paid (the activity itself refuses to
    // mark an under-covered invoice paid)
    if (Number.isInteger(billingId) && billingId > 0) {
      await updateBillingStatusActivity(billingId, 'paid');
    }

    // Step 5: Send success notification
    await sendPaymentNotificationActivity(
      userId,
      transactionId,
      'success'
    );

    return {
      success: true,
      transactionId,
    };
  } catch (error) {
    console.error('[PaymentWorkflow] Error:', error);

    // Compensation: Mark payment as failed
    if (transactionId) {
      await updatePaymentStatusActivity(transactionId, 'failed', {
        amount: input.amount,
        gateway: input.gateway,
      });
      await sendPaymentNotificationActivity(
        userId,
        transactionId,
        'failed'
      );
    }

    return {
      success: false,
      transactionId,
      error: error instanceof Error ? error.message : 'Payment workflow failed',
    };
  }
}

/**
 * Refund Workflow
 * 
 * Handles payment refunds with proper compensation
 */
export async function refundWorkflow(
  transactionId: string,
  gateway: 'mpesa' | 'airtel' | 'tigo',
  userId: number,
  billingId: number
): Promise<PaymentWorkflowResult> {
  try {
    // Step 1: Process refund with gateway
    const refundResult = await refundPaymentActivity(transactionId, gateway);

    if (!refundResult.success) {
      throw new Error(refundResult.error || 'Refund failed');
    }

    // The refund activity has already marked the payment 'refunded' after
    // gateway confirmation — do not overwrite that status here.

    // Step 2: Revert billing status
    await updateBillingStatusActivity(billingId, 'issued');

    // Step 3: Notify user
    await sendPaymentNotificationActivity(userId, transactionId, 'failed');

    return {
      success: true,
      transactionId,
    };
  } catch (error) {
    console.error('[RefundWorkflow] Error:', error);
    return {
      success: false,
      transactionId,
      error: error instanceof Error ? error.message : 'Refund workflow failed',
    };
  }
}

/**
 * Workflow Configuration (for Temporal Worker)
 * 
 * This would be used to configure the Temporal worker:
 * 
 * ```typescript
 * import { Worker } from '@temporalio/worker';
 * import * as activities from './payment-activities';
 * 
 * const worker = await Worker.create({
 *   workflowsPath: require.resolve('./payment-workflow'),
 *   activities,
 *   taskQueue: 'payment-processing',
 *   maxConcurrentActivityTaskExecutions: 10,
 * });
 * 
 * await worker.run();
 * ```
 */
export const WORKFLOW_CONFIG = {
  taskQueue: 'payment-processing',
  workflowId: (billingId: number) => `payment-${billingId}-${Date.now()}`,
  retryPolicy: {
    initialInterval: '1s',
    backoffCoefficient: 2,
    maximumInterval: '60s',
    maximumAttempts: 5,
  },
  workflowExecutionTimeout: '10m',
  workflowRunTimeout: '5m',
  workflowTaskTimeout: '30s',
};
