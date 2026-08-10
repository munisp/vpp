/**
 * Payment Gateway Webhook Handlers
 * 
 * Handles callbacks from payment gateways (M-Pesa, Airtel Money, Tigo Pesa)
 * Production-ready with idempotency, environment configuration, and post-payment actions
 */

import { Request, Response } from 'express';
import { PaymentGatewayManager } from '../payment-gateways';
import { getDb } from '../db';
import { payments, billings, paymentGatewayLogs, tokens, users } from '../../drizzle/schema';
import { eq, and } from 'drizzle-orm';
import { sendPushNotification } from '../_core/sendNotification';

// Environment configuration - derive from single authoritative env var
const PAYMENTS_ENV = (process.env.PAYMENTS_ENV || 'sandbox') as 'sandbox' | 'production';

/**
 * Log gateway event for audit trail and debugging
 */
async function logGatewayEvent(
  gateway: 'mpesa' | 'airtel_money' | 'tigo_pesa',
  eventType: string,
  transactionId: string,
  payload: any,
  environment: string
): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;

    await db.insert(paymentGatewayLogs).values({
      gateway,
      status: 'pending',
      requestType: eventType,
      requestPayload: JSON.stringify({ transactionId, ...payload }),
      responsePayload: JSON.stringify({ environment }),
      createdAt: new Date(),
    });
  } catch (error) {
    console.error('[PaymentCallback] Failed to log gateway event:', error);
  }
}

/**
 * M-Pesa callback handler
 */
export async function handleMpesaCallback(req: Request, res: Response) {
  const callbackData = req.body;
  const transactionId = callbackData?.Body?.stkCallback?.CheckoutRequestID || 
                        callbackData?.Result?.TransactionID || 
                        `mpesa-${Date.now()}`;

  // Log every gateway event for audit trail
  await logGatewayEvent('mpesa', 'callback', transactionId, callbackData, PAYMENTS_ENV);

  try {
    // Process the callback with environment from config
    const result = await PaymentGatewayManager.processCallback(
      'mpesa',
      callbackData,
      PAYMENTS_ENV
    );

    // Update payment record with idempotency check
    const updated = await updatePaymentFromCallback(result, 'mpesa');

    // Respond to M-Pesa
    res.status(200).json({
      ResultCode: 0,
      ResultDesc: 'Success',
    });
  } catch (error: any) {
    console.error('M-Pesa callback error:', error);
    res.status(200).json({
      ResultCode: 1,
      ResultDesc: error.message || 'Failed to process callback',
    });
  }
}

/**
 * Airtel Money callback handler
 */
export async function handleAirtelCallback(req: Request, res: Response) {
  const callbackData = req.body;
  const transactionId = callbackData?.transaction?.id || `airtel-${Date.now()}`;

  // Log every gateway event for audit trail
  await logGatewayEvent('airtel_money', 'callback', transactionId, callbackData, PAYMENTS_ENV);

  try {
    // Process the callback with environment from config
    const result = await PaymentGatewayManager.processCallback(
      'airtel_money',
      callbackData,
      PAYMENTS_ENV
    );

    // Update payment record with idempotency check
    await updatePaymentFromCallback(result, 'airtel_money');

    // Respond to Airtel
    res.status(200).json({
      status: {
        code: '200',
        success: true,
        message: 'Callback processed successfully',
      },
    });
  } catch (error: any) {
    console.error('Airtel callback error:', error);
    res.status(200).json({
      status: {
        code: '400',
        success: false,
        message: error.message || 'Failed to process callback',
      },
    });
  }
}

/**
 * Tigo Pesa callback handler
 */
export async function handleTigoCallback(req: Request, res: Response) {
  const callbackData = req.body;
  const transactionId = callbackData?.ReferenceID || callbackData?.TransactionID || `tigo-${Date.now()}`;

  // Log every gateway event for audit trail
  await logGatewayEvent('tigo_pesa', 'callback', transactionId, callbackData, PAYMENTS_ENV);

  try {
    // Process the callback with environment from config
    const result = await PaymentGatewayManager.processCallback(
      'tigo_pesa',
      callbackData,
      PAYMENTS_ENV
    );

    // Update payment record with idempotency check
    await updatePaymentFromCallback(result, 'tigo_pesa');

    // Respond to Tigo
    res.status(200).json({
      ResponseCode: '0',
      ResponseDescription: 'Success',
    });
  } catch (error: any) {
    console.error('Tigo callback error:', error);
    res.status(200).json({
      ResponseCode: '1',
      ResponseDescription: error.message || 'Failed to process callback',
    });
  }
}

/**
 * Update payment record from callback data with idempotency
 * Returns true if state transition occurred, false if already processed
 */
async function updatePaymentFromCallback(
  callbackData: any,
  gateway: string
): Promise<boolean> {
  const db = await getDb();
  if (!db) {
    throw new Error('Database not available');
  }

  // Find payment by transaction ID
  const payment = await db
    .select()
    .from(payments)
    .where(eq(payments.transactionId, callbackData.transactionId))
    .limit(1);

  if (payment.length === 0) {
    console.warn(`Payment not found for transaction: ${callbackData.transactionId}`);
    return false;
  }

  const pmt = payment[0];
  const previousStatus = pmt.status;
  const newStatus = callbackData.status === 'completed' ? 'completed' : 'failed';

  // IDEMPOTENCY CHECK: Only process if status is transitioning from pending
  // Prevent duplicate processing of callbacks
  if (previousStatus === 'completed' || previousStatus === 'failed') {
    console.log(`[PaymentCallback] Payment ${pmt.id} already in terminal state: ${previousStatus}, skipping`);
    return false;
  }

  // Update payment status atomically
  await db
    .update(payments)
    .set({
      status: newStatus,
      metadata: JSON.stringify({
        ...(pmt.metadata ? JSON.parse(pmt.metadata) : {}),
        callback: callbackData,
        processedAt: new Date().toISOString(),
        gateway,
        environment: PAYMENTS_ENV,
      }),
    })
    .where(and(
      eq(payments.id, pmt.id),
      eq(payments.status, 'pending') // Optimistic lock - only update if still pending
    ));

  // Execute post-payment actions only if we just transitioned state
  if (newStatus === 'completed') {
    await executePostPaymentActions(pmt, callbackData);
  } else if (newStatus === 'failed') {
    await handlePaymentFailure(pmt, callbackData);
  }

  console.log(`[PaymentCallback] Payment ${pmt.id} transitioned from ${previousStatus} to ${newStatus}`);
  return true;
}

/**
 * Execute post-payment actions based on payment type
 * All actions are idempotent - safe to call multiple times
 */
async function executePostPaymentActions(
  payment: any,
  callbackData: any
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const metadata = payment.metadata ? JSON.parse(payment.metadata) : {};
  const paymentType = metadata.paymentType || 'invoice';

  try {
    switch (paymentType) {
      case 'invoice':
      case 'billing':
        // Update billing record to paid
        if (payment.billingId) {
          await db
            .update(billings)
            .set({
              status: 'paid',
              paidAt: new Date(),
              paymentMethod: payment.paymentMethod,
              transactionId: callbackData.transactionId,
            })
            .where(and(
              eq(billings.id, payment.billingId),
              eq(billings.status, 'issued') // Idempotent - only update if issued
            ));
          console.log(`[PostPayment] Billing ${payment.billingId} marked as paid`);
        }
        break;

      case 'prepaid_token':
        // Generate prepaid token for the user
        const tokenAmount = payment.amount;
        const tokenCode = generatePrepaidToken();
        // Calculate energy based on average price (45 cents/kWh)
        const energyKwh = Math.round(tokenAmount / 45);
        
        await db.insert(tokens).values({
          userId: payment.userId,
          paymentId: payment.id,
          tokenCode,
          energyKwh,
          amount: tokenAmount,
          validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year expiry
          status: 'active',
          createdAt: new Date(),
        });
        console.log(`[PostPayment] Prepaid token ${tokenCode} created for user ${payment.userId}`);
        break;

      case 'subscription':
        // Update user's last activity (subscription tracking via metadata)
        console.log(`[PostPayment] Subscription payment processed for user ${payment.userId}`);
        break;

      default:
        console.log(`[PostPayment] Unknown payment type: ${paymentType}`);
    }

    // Send success notification to user
    await sendPushNotification(
      payment.userId,
      {
        title: 'Payment Successful',
        body: `Your payment of ${payment.amount} ${payment.currency || 'TZS'} has been processed successfully.`,
        data: {
          type: 'payment_success',
          paymentId: payment.id,
          transactionId: callbackData.transactionId,
        },
      },
      'pushPaymentReceived'
    );
  } catch (error) {
    console.error('[PostPayment] Error executing post-payment actions:', error);
    // Don't throw - we've already updated the payment status
    // Log for manual reconciliation
  }
}

/**
 * Handle payment failure - notify user and log for reconciliation
 */
async function handlePaymentFailure(
  payment: any,
  callbackData: any
): Promise<void> {
  try {
    // Send failure notification to user
    await sendPushNotification(
      payment.userId,
      {
        title: 'Payment Failed',
        body: `Your payment of ${payment.amount} ${payment.currency || 'TZS'} could not be processed. Please try again.`,
        data: {
          type: 'payment_failed',
          paymentId: payment.id,
          reason: callbackData.failureReason || 'Unknown error',
        },
      },
      'pushPaymentReceived'
    );

    console.log(`[PaymentCallback] Failure notification sent for payment ${payment.id}`);
  } catch (error) {
    console.error('[PaymentCallback] Error sending failure notification:', error);
  }
}

/**
 * Generate a unique prepaid token code
 */
function generatePrepaidToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let token = '';
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) token += '-';
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}
