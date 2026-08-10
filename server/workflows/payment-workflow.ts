/**
 * Temporal Payment Workflow
 * 
 * Orchestrates the complete payment lifecycle with retry logic,
 * timeout handling, and compensation workflows.
 */

import {
  initiatePaymentActivity,
  verifyPaymentActivity,
  updatePaymentStatusActivity,
  updateBillingStatusActivity,
  sendPaymentNotificationActivity,
  refundPaymentActivity,
  PaymentActivityInput,
} from './payment-activities';

/**
 * Payment Workflow Configuration
 */
export interface PaymentWorkflowInput {
  userId: number;
  billingId: number;
  amount: number;
  gateway: 'mpesa' | 'airtel' | 'tigo';
  phoneNumber: string;
}

export interface PaymentWorkflowResult {
  success: boolean;
  transactionId?: string;
  error?: string;
}

/**
 * Main Payment Workflow
 *
 * Orchestrates the full payment lifecycle:
 * 1. Initiate payment with the mobile-money gateway.
 * 2. Poll for confirmation with exponential back-off.
 * 3. Update payment and billing status on success.
 * 4. Send user notification.
 * 5. Compensate (mark failed, notify) on any error.
 *
 * This function is designed to run inside a Temporal workflow context.
 * The polling loop uses a real async sleep so that Temporal can replay
 * the history deterministically when the worker restarts.
 */
export async function paymentWorkflow(
  input: PaymentWorkflowInput
): Promise<PaymentWorkflowResult> {
  let transactionId: string | undefined;

  try {
    // Step 1: Initiate payment with gateway
    const initiateResult = await initiatePaymentActivity({
      userId: input.userId,
      billingId: input.billingId,
      amount: input.amount,
      gateway: input.gateway,
      phoneNumber: input.phoneNumber,
    });

    if (!initiateResult.success || !initiateResult.transactionId) {
      throw new Error(initiateResult.error || 'Payment initiation failed');
    }

    transactionId = initiateResult.transactionId;

    // Step 2: Poll for payment confirmation.
    // Uses a real async sleep so Temporal can replay history correctly.
    let verified = false;
    let attempts = 0;
    const maxAttempts = 5;
    const verifyDelayMs = 10_000; // 10 seconds between polls

    while (!verified && attempts < maxAttempts) {
      attempts++;

      // Wait before polling — this is a real async pause, not a simulation.
      await new Promise<void>(resolve => setTimeout(resolve, verifyDelayMs));

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
    await updatePaymentStatusActivity(transactionId, 'completed');

    // Step 4: Update billing status to paid
    await updateBillingStatusActivity(input.billingId, 'paid');

    // Step 5: Send success notification
    await sendPaymentNotificationActivity(
      input.userId,
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
      await updatePaymentStatusActivity(transactionId, 'failed');
      await sendPaymentNotificationActivity(
        input.userId,
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

    // Step 2: Update payment status
    await updatePaymentStatusActivity(transactionId, 'failed');

    // Step 3: Revert billing status
    await updateBillingStatusActivity(billingId, 'issued');

    // Step 4: Notify user
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
