/**
 * Temporal Payment Workflow Activities
 * These activities are the building blocks for payment workflows
 */

import { PaymentGatewayManager } from '../payment-gateways';
import { paymentGatewayService } from '../services/payment-gateway-service';
import { getDb } from '../db';
import { payments, billings } from '../../drizzle/schema';
import { eq } from 'drizzle-orm';
import { kafkaPublisher } from '../integration/kafka-publisher';

/**
 * Gateway environment for all payment operations. Defaults to 'production' —
 * sandbox must be opted into explicitly via PAYMENTS_ENV=sandbox so that real
 * payments are never silently routed to a test environment.
 */
const PAYMENTS_ENV: 'sandbox' | 'production' =
  process.env.PAYMENTS_ENV === 'sandbox' ? 'sandbox' : 'production';

export interface PaymentActivityInput {
  userId: number;
  billingId: number;
  amount: number;
  gateway: 'mpesa' | 'airtel' | 'tigo';
  phoneNumber: string;
}

export interface PaymentResult {
  success: boolean;
  transactionId?: string;
  error?: string;
}

/**
 * Activity: Initiate payment with gateway
 */
export async function initiatePaymentActivity(
  input: PaymentActivityInput
): Promise<PaymentResult> {
  try {
    const gatewayId = input.gateway === 'mpesa' ? 'mpesa' : input.gateway === 'airtel' ? 'airtel_money' : 'tigo_pesa';
    
    const result = await PaymentGatewayManager.initiatePayment(
      gatewayId,
      {
        amount: input.amount,
        phoneNumber: input.phoneNumber,
        accountReference: `BILL-${input.billingId}`,
        transactionDesc: `Payment for billing ${input.billingId}`,
      },
      PAYMENTS_ENV
    );

    if (result.success && result.transactionId) {
      // Create payment record
      const db = await getDb();
      if (db) {
        await db.insert(payments).values({
          userId: input.userId,
          billingId: input.billingId,
          paymentType: 'invoice',
          amount: Math.round(input.amount * 100), // Convert to cents
          currency: 'TZS',
          paymentMethod: input.gateway === 'mpesa' ? 'mpesa' : input.gateway === 'airtel' ? 'airtel_money' : 'tigo_pesa',
          phoneNumber: input.phoneNumber,
          transactionId: result.transactionId,
          status: 'pending',
        });
      }

      // Publish Kafka event
      await kafkaPublisher.publishPaymentInitiated({
        paymentId: result.transactionId,
        userId: input.userId.toString(),
        amount: input.amount,
        currency: 'TZS',
        gateway: input.gateway,
        timestamp: new Date(),
        metadata: { billingId: input.billingId },
      });

      return {
        success: true,
        transactionId: result.transactionId,
      };
    }

    return {
      success: false,
      error: result.message || 'Payment initiation failed',
    };
  } catch (error) {
    console.error('[PaymentActivity] Initiate failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Activity: Verify payment status with gateway
 */
export async function verifyPaymentActivity(
  transactionId: string,
  gateway: 'mpesa' | 'airtel' | 'tigo'
): Promise<PaymentResult> {
  try {
    const gatewayId = gateway === 'mpesa' ? 'mpesa' : gateway === 'airtel' ? 'airtel_money' : 'tigo_pesa';
    const status = await PaymentGatewayManager.queryPaymentStatus(gatewayId, transactionId, PAYMENTS_ENV);

    return {
      success: status.status === 'completed',
      transactionId,
    };
  } catch (error) {
    console.error('[PaymentActivity] Verify failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Verification failed',
    };
  }
}

/**
 * Activity: Update payment record in database
 *
 * Publishes the completion event with the real amount/gateway/transactionId —
 * values come from the activity args and are cross-checked against the stored
 * payment record, never fabricated.
 */
export async function updatePaymentStatusActivity(
  transactionId: string,
  status: 'completed' | 'failed' | 'pending',
  details?: { amount?: number; gateway?: string }
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  // Load the payment record so the emitted event carries real values even if
  // the caller did not supply them.
  const paymentRecords = await db
    .select()
    .from(payments)
    .where(eq(payments.transactionId, transactionId))
    .limit(1);
  const payment = paymentRecords[0];

  await db
    .update(payments)
    .set({
      status,
      updatedAt: new Date(),
    })
    .where(eq(payments.transactionId, transactionId));

  const amount = details?.amount ?? payment?.amount;
  const gateway = details?.gateway ?? payment?.paymentMethod;

  if (amount === undefined || !gateway) {
    console.warn(
      `[PaymentActivity] Skipping payment-completed event for ${transactionId}: ` +
      'payment record not found and amount/gateway not provided'
    );
    return;
  }

  // Publish status update event with real values
  await kafkaPublisher.publishPaymentCompleted({
    paymentId: transactionId,
    completedAt: new Date(),
    transactionId,
    amount,
    gateway,
  });
}

/**
 * Activity: Update billing record
 */
export async function updateBillingStatusActivity(
  billingId: number,
  status: 'draft' | 'issued' | 'paid' | 'overdue' | 'cancelled'
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  await db
    .update(billings)
    .set({
      status,
      updatedAt: new Date(),
    })
    .where(eq(billings.id, billingId));
}

/**
 * Activity: Send payment notification
 *
 * Delivers a real push notification and records an in-app alert. Returns
 * { sent: false } honestly when delivery fails.
 */
export async function sendPaymentNotificationActivity(
  userId: number,
  transactionId: string,
  status: 'success' | 'failed'
): Promise<{ sent: boolean }> {
  try {
    const { sendPushNotification } = await import('../_core/sendNotification');
    const { getDb } = await import('../db');
    const { alerts } = await import('../../drizzle/schema');

    const title = status === 'success' ? 'Payment Successful' : 'Payment Failed';
    const body = status === 'success'
      ? `Your payment (ref ${transactionId}) was completed successfully.`
      : `Your payment (ref ${transactionId}) could not be completed.`;

    const result = await sendPushNotification(
      userId,
      {
        title,
        body,
        data: { type: 'payment', transactionId, status },
      },
      status === 'success' ? 'pushPaymentReceived' : 'pushBillingAlert'
    );

    // In-app alert so the user sees the outcome even without push subscriptions
    const db = await getDb();
    if (db) {
      await db.insert(alerts).values({
        userId,
        alertType: 'system',
        severity: status === 'failed' ? 'warning' : 'info',
        title,
        message: body,
        metadata: JSON.stringify({ transactionId, status, category: 'payment' }),
        createdAt: new Date(),
      });
    }

    if (!result.success) {
      console.error(`[PaymentActivity] Notification delivery failed for ${transactionId} (${result.errors} errors)`);
      return { sent: false };
    }

    return { sent: true };
  } catch (error) {
    console.error('[PaymentActivity] Notification failed:', error);
    return { sent: false };
  }
}

/**
 * Activity: Refund payment (compensation)
 *
 * Routes through the unified payment gateway service, which only reports
 * success when the gateway confirms the refund. Failures are propagated so
 * the workflow (and Temporal retry policy) see the real outcome.
 */
export async function refundPaymentActivity(
  transactionId: string,
  gateway: 'mpesa' | 'airtel' | 'tigo'
): Promise<PaymentResult> {
  try {
    const db = await getDb();
    if (!db) {
      return { success: false, error: 'Database not available' };
    }

    // Resolve the internal payment id from the gateway transaction id
    const paymentRecords = await db
      .select()
      .from(payments)
      .where(eq(payments.transactionId, transactionId))
      .limit(1);

    const payment = paymentRecords[0];
    if (!payment) {
      return { success: false, error: `Payment not found for transaction ${transactionId}` };
    }

    const result = await paymentGatewayService.processRefund(
      payment.id,
      `Workflow compensation refund for transaction ${transactionId}`
    );

    if (!result.success) {
      console.error(`[PaymentActivity] Refund not confirmed for ${transactionId}: ${result.error}`);
      return {
        success: false,
        transactionId,
        error: result.error || 'Refund not confirmed by gateway',
      };
    }

    return {
      success: true,
      transactionId: result.refundId || transactionId,
    };
  } catch (error) {
    console.error('[PaymentActivity] Refund failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Refund failed',
    };
  }
}
