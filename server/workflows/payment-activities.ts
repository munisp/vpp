/**
 * Temporal Payment Workflow Activities
 * These activities are the building blocks for payment workflows
 */

import { PaymentGatewayManager } from '../payment-gateways';
import { getDb } from '../db';
import { payments, billings } from '../../drizzle/schema';
import { eq } from 'drizzle-orm';
import { kafkaPublisher } from '../integration/kafka-publisher';

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
      'sandbox'
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
    const status = await PaymentGatewayManager.queryPaymentStatus(gatewayId, transactionId, 'sandbox');

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
 */
export async function updatePaymentStatusActivity(
  transactionId: string,
  status: 'completed' | 'failed' | 'pending'
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  await db
    .update(payments)
    .set({
      status,
      updatedAt: new Date(),
    })
    .where(eq(payments.transactionId, transactionId));

  // Publish status update event
  await kafkaPublisher.publishPaymentCompleted({
    paymentId: transactionId,
    completedAt: new Date(),
    transactionId,
    amount: 0,
    gateway: '',
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
 */
export async function sendPaymentNotificationActivity(
  userId: number,
  transactionId: string,
  status: 'success' | 'failed'
): Promise<void> {
  // This would integrate with email notification service
  console.log(`[PaymentActivity] Sending ${status} notification to user ${userId} for transaction ${transactionId}`);
  
  // Notification event (simplified)
  console.log(`[PaymentActivity] Notification sent for ${transactionId}`);
}

/**
 * Activity: Refund payment (compensation)
 */
export async function refundPaymentActivity(
  transactionId: string,
  gateway: 'mpesa' | 'airtel' | 'tigo'
): Promise<PaymentResult> {
  try {
    // In a real implementation, this would call gateway refund API
    console.log(`[PaymentActivity] Refunding transaction ${transactionId} via ${gateway}`);
    
    // Refund event (simplified)
    console.log(`[PaymentActivity] Refund processed for ${transactionId}`);

    return {
      success: true,
      transactionId,
    };
  } catch (error) {
    console.error('[PaymentActivity] Refund failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Refund failed',
    };
  }
}
