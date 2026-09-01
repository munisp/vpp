/**
 * Payment Gateway Webhook Handlers
 *
 * Handles callbacks from payment gateways (M-Pesa, Airtel Money, Tigo Pesa,
 * Paystack, Flutterwave).
 * Production-ready with idempotency, environment configuration, and post-payment actions
 */

import { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { PaymentGatewayManager } from '../payment-gateways';
import { getDb } from '../db';
import { payments, billings, paymentGatewayLogs, tokens, users } from '../../drizzle/schema';
import { eq, and, or, sql } from 'drizzle-orm';
import { sendPushNotification } from '../_core/sendNotification';
import { resolveGatewayEnvironment } from '../payment-gateways/environment';
import { issuePrepaidTokenForPayment } from '../services/prepaid-issuance-entry';
import { paystackService } from '../services/paystack-service';
import { flutterwaveService } from '../services/flutterwave-service';

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
 * Resolve the payment row a gateway callback refers to.
 *
 * At initiation the stored `payments.transactionId` is the reference the
 * provider returns FIRST (M-Pesa: MerchantRequestID or CheckoutRequestID,
 * recorded both in the column and in metadata). A success callback instead
 * carries the final receipt (M-Pesa: MpesaReceiptNumber), which never equals
 * those initiation references — so a receipt-only lookup settles nothing.
 * Resolution order:
 *   1. exact transactionId hit (Airtel/Tigo/Paystack/Flutterwave references,
 *      M-Pesa failure callbacks keyed by MerchantRequestID, settled rows)
 *   2. M-Pesa: match the callback's CheckoutRequestID against the stored
 *      transactionId or the metadata references written at initiation.
 */
async function resolvePaymentForCallback(db: any, callbackData: any): Promise<any | null> {
  const direct = await db
    .select()
    .from(payments)
    .where(eq(payments.transactionId, callbackData.transactionId))
    .limit(1);
  if (direct.length > 0) return direct[0];

  const checkoutRequestId = callbackData.checkoutRequestId;
  if (checkoutRequestId) {
    const byCheckout = await db
      .select()
      .from(payments)
      .where(
        or(
          eq(payments.transactionId, checkoutRequestId),
          sql`${payments.metadata} ->> 'gatewayReference' = ${checkoutRequestId}`,
          sql`${payments.metadata} ->> 'checkoutRequestId' = ${checkoutRequestId}`
        )
      )
      .limit(1);
    if (byCheckout.length > 0) return byCheckout[0];
  }

  const merchantRequestId = callbackData.metadata?.MerchantRequestID || callbackData.merchantRequestId;
  if (merchantRequestId) {
    const byMerchant = await db
      .select()
      .from(payments)
      .where(
        or(
          eq(payments.transactionId, merchantRequestId),
          sql`${payments.metadata} ->> 'merchantRequestId' = ${merchantRequestId}`
        )
      )
      .limit(1);
    if (byMerchant.length > 0) return byMerchant[0];
  }

  return null;
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

  const pmt = await resolvePaymentForCallback(db, callbackData);

  if (!pmt) {
    console.warn(`Payment not found for transaction: ${callbackData.transactionId}`);
    return false;
  }

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
  // Gateway adapters already normalise the provider's major-unit amount to
  // cents (`PaymentCallbackData.amount`); scaling again here would make every
  // genuine callback look like a 100x overpayment and settle nothing.
  const callbackAmountCents =
    typeof callbackData.amount === 'number' ? Math.round(callbackData.amount) : null;

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
  //
  // On settlement the provider's final receipt becomes the transactionId
  // (M-Pesa: MpesaReceiptNumber), replacing the initiation reference the row
  // was created with — the receipt is what reversals and customer support
  // quote. The initiation references stay in metadata for audit.
  const mpesaReceipt =
    gateway === 'mpesa' && newStatus === 'completed'
      ? callbackData.metadata?.MpesaReceiptNumber ?? callbackData.transactionId
      : undefined;

  const result = await db
    .update(payments)
    .set({
      status: newStatus,
      ...(callbackData.transactionId ? { transactionId: callbackData.transactionId } : {}),
      metadata: JSON.stringify({
        ...(pmt.metadata ? JSON.parse(pmt.metadata) : {}),
        callback: callbackData,
        processedAt: new Date().toISOString(),
        gateway,
        environment: PAYMENTS_ENV,
        // The reversal API keys off the M-Pesa receipt number; persist it on
        // the row so refunds can target the original transaction.
        ...(mpesaReceipt ? { mpesaReceiptNumber: mpesaReceipt } : {}),
        // Flutterwave refunds target the numeric transaction id, learned from
        // the webhook payload.
        ...(gateway === 'flutterwave' && callbackData.flutterwaveTransactionId
          ? { flutterwaveTransactionId: callbackData.flutterwaveTransactionId }
          : {}),
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
 * Mark a billing paid only when the completed payments recorded against it
 * cover the invoiced consumer share. Anything less leaves the invoice
 * 'issued' — a partially paid invoice reported as paid is money the books
 * claim arrived that never did.
 */
export async function settleBillingIfCovered(
  db: any,
  billingId: number,
  paymentMethod?: string | null,
  transactionId?: string | null
): Promise<{ paid: boolean; totalPaidCents: number; dueCents: number }> {
  const billingRows = await db
    .select()
    .from(billings)
    .where(eq(billings.id, billingId))
    .limit(1);
  const billing = billingRows[0];
  if (!billing) {
    console.error(`[PostPayment] Billing ${billingId} not found; cannot settle`);
    return { paid: false, totalPaidCents: 0, dueCents: 0 };
  }

  const [paidRow] = await db
    .select({ total: sql<number>`COALESCE(SUM(${payments.amount}), 0)` })
    .from(payments)
    .where(and(eq(payments.billingId, billingId), eq(payments.status, 'completed')));

  const totalPaidCents = Number(paidRow?.total ?? 0);
  const dueCents = billing.consumerShare;

  if (totalPaidCents >= dueCents) {
    await db
      .update(billings)
      .set({
        status: 'paid',
        paidAt: new Date(),
        ...(paymentMethod ? { paymentMethod } : {}),
        ...(transactionId ? { transactionId } : {}),
      })
      .where(and(
        eq(billings.id, billingId),
        // Idempotent - only settle an invoice that is still outstanding
        or(eq(billings.status, 'issued'), eq(billings.status, 'overdue'))
      ));
    return { paid: true, totalPaidCents, dueCents };
  }

  return { paid: false, totalPaidCents, dueCents };
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
        // An invoice is only settled when the COMPLETED payments against it
        // cover the invoiced consumer share; a partial payment is real money
        // received but does not pay the invoice off.
        if (payment.billingId) {
          const settlement = await settleBillingIfCovered(
            db,
            payment.billingId,
            payment.paymentMethod,
            callbackData.transactionId
          );
          if (settlement.paid) {
            console.log(`[PostPayment] Billing ${payment.billingId} marked as paid`);
          } else {
            console.warn(
              `[PostPayment] Billing ${payment.billingId} partially paid: ` +
                `${settlement.totalPaidCents}/${settlement.dueCents} cents; invoice remains issued`
            );
          }
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
          .select({ id: tokens.id, status: tokens.status })
          .from(tokens)
          .where(eq(tokens.paymentId, payment.id))
          .limit(1);

        if (existing.length > 0 && existing[0].status !== 'pending_issuance') {
          console.log(`[PostPayment] Token already recorded for payment ${payment.id}`);
          break;
        }

        // Vend through the prepaid account layer when the payer has one: it posts
        // the purchase to the ledger and produces a code the customer's meter
        // accepts. Idempotent per payment, so a replayed callback returns the
        // token already vended rather than issuing a second one.
        const prepaid = await issuePrepaidTokenForPayment({ paymentId: payment.id });
        if (prepaid.issued) {
          console.log(`[PostPayment] Vended prepaid token for payment ${payment.id}`);
          break;
        }
        console.log(
          `[PostPayment] Payment ${payment.id} not vended (${prepaid.reason ?? 'no prepaid account'}); ` +
            `retry scheduled: ${prepaid.retryScheduled}`
        );

        if (existing.length > 0) break;

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

      case 'p2p_trade': {
        // A confirmed buyer payment is recorded against its trade. The trade is
        // still not complete: the seller cannot be paid, so the state written
        // is 'buyer paid, seller unpaid' rather than executed.
        const { recordBuyerPaymentSettled } = await import('../services/p2p-settlement');
        try {
          const result = await recordBuyerPaymentSettled({
            id: payment.id,
            userId: payment.userId,
            amount: payment.amount,
            currency: payment.currency ?? null,
            transactionId: payment.transactionId ?? null,
            p2pTradeId: payment.p2pTradeId ?? null,
            paymentMethod: payment.paymentMethod ?? null,
            metadata: payment.metadata ?? null,
          });
          console.log(
            `[PostPayment] Trade ${result.buyTradeId} recorded as ${result.settlement} in settlement ${result.settlementId}; seller payout unavailable; ledger entry ${result.ledgerPosting.state}`
          );
        } catch (error) {
          // The buyer's money moved and the platform cannot say which trade it
          // paid for. Logging alone would lose that, so the unattributed
          // payment is marked on the row itself for reconciliation.
          const reason = error instanceof Error ? error.message : String(error);
          console.error(
            `[PostPayment] P2P payment ${payment.id} could not be attributed to a trade:`,
            error
          );
          await db
            .update(payments)
            .set({
              metadata: JSON.stringify({
                ...metadata,
                settlementUnresolved: reason,
                settlementUnresolvedAt: new Date().toISOString(),
              }),
            })
            .where(eq(payments.id, payment.id));
        }
        break;
      }

      case 'subscription':
        // Update user's last activity (subscription tracking via metadata)
        console.log(`[PostPayment] Subscription payment processed for user ${payment.userId}`);
        break;

      default:
        console.log(`[PostPayment] Unknown payment type: ${paymentType}`);
    }

    // Send confirmation to the user. A P2P purchase is deliberately not called
    // successful here: the buyer has paid, but the seller has not been paid and
    // the energy has not been evidenced, so the trade is not done.
    await sendPushNotification(
      payment.userId,
      {
        title: paymentType === 'p2p_trade' ? 'Payment received' : 'Payment Successful',
        body:
          paymentType === 'p2p_trade'
            ? `Your payment of ${payment.amount} ${payment.currency || 'TZS'} was confirmed by your provider. The trade completes once the energy delivery and the seller's payout are recorded.`
            : `Your payment of ${payment.amount} ${payment.currency || 'TZS'} has been processed successfully.`,
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

// ---------------------------------------------------------------------------
// Paystack / Flutterwave webhooks
//
// Both providers authenticate webhooks with secrets only the platform and the
// provider know. FAIL-CLOSED: when the secret is unset the webhook is refused
// with 503 (a loud misconfiguration) — an unverifiable payment notification is
// rejected, never accepted.
//
// NOTE: paymentGatewayLogs.gateway is a pg enum limited to the three
// mobile-money gateways, so these events are not written to that table; the
// payment row's metadata records the verified callback for audit.
// ---------------------------------------------------------------------------

/** Raw bytes the provider signed, mirroring verify-signature.ts. */
function webhookBodyBytes(req: Request): Buffer {
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (raw && Buffer.isBuffer(raw)) return raw;
  return Buffer.from(JSON.stringify(req.body ?? {}), 'utf8');
}

function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Paystack webhook: verifies HMAC-SHA512 of the raw body in the
 * `x-paystack-signature` header (keyed with PAYSTACK_SECRET_KEY), then handles
 * `charge.success` by VERIFYING the transaction against the Paystack API before
 * settling — a webhook alone is a claim, not a confirmation.
 */
export async function handlePaystackCallback(req: Request, res: Response) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    console.error('[PaystackWebhook] PAYSTACK_SECRET_KEY is not set; refusing unverifiable webhook');
    res.status(503).json({
      error: 'PAYSTACK_NOT_CONFIGURED',
      message: 'Paystack webhook verification is not configured (PAYSTACK_SECRET_KEY unset).',
    });
    return;
  }

  const signature = req.header('x-paystack-signature');
  const expected = createHmac('sha512', secret).update(webhookBodyBytes(req)).digest('hex');
  if (!signature || !safeEqualHex(signature, expected)) {
    console.error('[PaystackWebhook] Signature mismatch; rejecting');
    res.status(401).json({ error: 'INVALID_SIGNATURE', message: 'Paystack signature verification failed.' });
    return;
  }

  try {
    const event = req.body;
    if (event?.event === 'charge.success' && event.data?.reference) {
      const reference: string = event.data.reference;

      // Confirm with the gateway itself before any money is recorded.
      const verification = await paystackService.queryPaymentStatus(reference);
      if (!verification.success || verification.status !== 'completed') {
        console.error(
          `[PaystackWebhook] charge.success for ${reference} did not verify as completed ` +
            `(${verification.status ?? verification.error}); not settling`
        );
        res.status(200).json({ received: true, settled: false });
        return;
      }

      // Paystack reports kobo; the platform stores kobo for NGN — unscaled.
      await updatePaymentFromCallback(
        {
          transactionId: reference,
          amount: verification.amount,
          status: 'completed',
          metadata: { paystackEvent: event },
        },
        'paystack'
      );
    }

    res.status(200).json({ received: true });
  } catch (error: any) {
    console.error('[PaystackWebhook] Processing error:', error);
    res.status(500).json({ error: 'PROCESSING_FAILED', message: error.message || 'Failed to process webhook' });
  }
}

/**
 * Flutterwave webhook: the `verif-hash` header must equal the
 * FLUTTERWAVE_SECRET_HASH configured on the Flutterwave dashboard. A
 * successful charge is then VERIFIED against the Flutterwave API before
 * settling.
 */
export async function handleFlutterwaveCallback(req: Request, res: Response) {
  const secretHash = process.env.FLUTTERWAVE_SECRET_HASH;
  if (!secretHash) {
    console.error('[FlutterwaveWebhook] FLUTTERWAVE_SECRET_HASH is not set; refusing unverifiable webhook');
    res.status(503).json({
      error: 'FLUTTERWAVE_NOT_CONFIGURED',
      message: 'Flutterwave webhook verification is not configured (FLUTTERWAVE_SECRET_HASH unset).',
    });
    return;
  }

  const verifHash = req.header('verif-hash');
  if (!verifHash || !safeEqualHex(verifHash, secretHash)) {
    console.error('[FlutterwaveWebhook] verif-hash mismatch; rejecting');
    res.status(401).json({ error: 'INVALID_SIGNATURE', message: 'Flutterwave verif-hash verification failed.' });
    return;
  }

  try {
    const event = req.body;
    const data = event?.data;
    if (data?.status === 'successful' && (data.tx_ref || data.id)) {
      // Confirm with the gateway itself before any money is recorded. The
      // numeric id is preferred for verification; tx_ref is our stored handle.
      const verification = data.id !== undefined
        ? await flutterwaveService.verifyTransaction(String(data.id))
        : await flutterwaveService.queryPaymentStatus(String(data.tx_ref));

      if (!verification.success || verification.status !== 'completed') {
        console.error(
          `[FlutterwaveWebhook] successful charge for ${data.tx_ref} did not verify as completed ` +
            `(${verification.status ?? verification.error}); not settling`
        );
        res.status(200).json({ received: true, settled: false });
        return;
      }

      // Flutterwave reports MAJOR units (naira); the platform stores minor
      // units (kobo), so the verified amount is scaled exactly once here.
      const amountCents =
        typeof verification.amount === 'number' ? Math.round(verification.amount * 100) : undefined;

      await updatePaymentFromCallback(
        {
          transactionId: String(data.tx_ref),
          amount: amountCents,
          status: 'completed',
          flutterwaveTransactionId:
            verification.transactionId ?? (data.id !== undefined ? String(data.id) : undefined),
          metadata: { flutterwaveEvent: event },
        },
        'flutterwave'
      );
    }

    res.status(200).json({ received: true });
  } catch (error: any) {
    console.error('[FlutterwaveWebhook] Processing error:', error);
    res.status(500).json({ error: 'PROCESSING_FAILED', message: error.message || 'Failed to process webhook' });
  }
}
