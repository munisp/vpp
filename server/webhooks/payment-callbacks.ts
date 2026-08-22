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
import { resolveGatewayEnvironment } from '../payment-gateways/environment';

// Environment configuration - single authoritative source, never a request value
const PAYMENTS_ENV = resolveGatewayEnvironment();

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
  let newStatus: 'completed' | 'failed' =
    callbackData.status === 'completed' ? 'completed' : 'failed';

  // IDEMPOTENCY CHECK: Only process if status is transitioning from pending
  // Prevent duplicate processing of callbacks
  if (previousStatus === 'completed' || previousStatus === 'failed') {
    console.log(`[PaymentCallback] Payment ${pmt.id} already in terminal state: ${previousStatus}, skipping`);
    return false;
  }

  // The callback amount is authoritative for how much the customer was
  // debited. If it does not match the amount owed, the payment is NOT settled:
  // completing it would credit an invoice or a token that was not paid for.
  const callbackAmountCents =
    typeof callbackData.amount === 'number' ? Math.round(callbackData.amount * 100) : null;

  if (newStatus === 'completed' && callbackAmountCents !== null && callbackAmountCents !== pmt.amount) {
    console.error(
      `[PaymentCallback] Amount mismatch on payment ${pmt.id}: callback ${callbackAmountCents} vs expected ${pmt.amount} cents; holding for reconciliation`
    );
    await db
      .update(payments)
      .set({
        metadata: JSON.stringify({
          ...(pmt.metadata ? JSON.parse(pmt.metadata) : {}),
          callback: callbackData,
          amountMismatch: { expected: pmt.amount, received: callbackAmountCents },
          gateway,
          environment: PAYMENTS_ENV,
        }),
      })
      .where(eq(payments.id, pmt.id));
    return false;
  }

  // Update payment status atomically. affectedRows tells us whether THIS call
  // performed the transition; concurrent duplicate callbacks see 0 rows and
  // must not run the post-payment actions again.
  const result = await db
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

  if ((result.rowCount ?? 0) === 0) {
    console.log(`[PaymentCallback] Payment ${pmt.id} was settled concurrently, skipping post-payment actions`);
    return false;
  }

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
  // The payment type is a column on the payment row; metadata is only a
  // fallback for records written by older callers.
  const paymentType = payment.paymentType || metadata.paymentType || 'invoice';

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
      case 'token_purchase': {
        // The energy quantity is the one the customer bought and paid for; it is
        // never re-derived from a hardcoded tariff. A token code can only come
        // from a certified STS vending system, so the paid-for token is recorded
        // as pending issuance instead of inventing a code that no meter accepts.
        const purchasedKwh = Number(metadata.energyKwh);

        if (!Number.isInteger(purchasedKwh) || purchasedKwh <= 0) {
          console.error(
            `[PostPayment] Payment ${payment.id} is a token purchase without a valid energyKwh; token NOT issued, manual review required`
          );
          break;
        }

        const existing = await db
          .select({ id: tokens.id })
          .from(tokens)
          .where(eq(tokens.paymentId, payment.id))
          .limit(1);

        if (existing.length > 0) {
          console.log(`[PostPayment] Token already recorded for payment ${payment.id}`);
          break;
        }

        await db.insert(tokens).values({
          userId: payment.userId,
          paymentId: payment.id,
          tokenCode: `PENDING_ISSUANCE_${payment.id}`,
          energyKwh: purchasedKwh,
          amount: payment.amount,
          validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year expiry
          status: 'pending_issuance',
          createdAt: new Date(),
        });
        console.log(
          `[PostPayment] Recorded ${purchasedKwh} kWh as pending issuance for payment ${payment.id}`
        );
        break;
      }

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
