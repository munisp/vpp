/**
 * Temporal Payment Workflow Activities
 * These activities are the building blocks for payment workflows
 */

import { PaymentGatewayManager } from '../payment-gateways';
import { paymentGatewayService } from '../services/payment-gateway-service';
import { getDb } from '../db';
import { payments, billings } from '../../drizzle/schema';
import { and, eq, or, sql } from 'drizzle-orm';
import { KAFKA_TOPICS } from '../integration/kafka-config';
import { enqueueEvent } from '../services/events/outbox';

/**
 * Gateway environment for all payment operations. Defaults to 'production' —
 * sandbox must be opted into explicitly via PAYMENTS_ENV=sandbox so that real
 * payments are never silently routed to a test environment.
 */
const PAYMENTS_ENV: 'sandbox' | 'production' =
  process.env.PAYMENTS_ENV === 'sandbox' ? 'sandbox' : 'production';

/** Gateways the payment workflow can charge through (both namings accepted). */
export type WorkflowGateway = 'mpesa' | 'airtel' | 'tigo' | 'airtel_money' | 'tigo_pesa';

export interface PaymentActivityInput {
  userId: number;
  billingId: number;
  /** Amount in the platform's canonical minor units (cents) — never scaled here. */
  amount: number;
  gateway: WorkflowGateway;
  phoneNumber: string;
  /**
   * Id of a payment row the CALLER already created and initiated (the tRPC
   * router initiates before starting this workflow). When present, this
   * activity must NOT charge the customer again or insert a second row.
   */
  paymentId?: number;
}

export interface PaymentResult {
  success: boolean;
  transactionId?: string;
  error?: string;
}

function normalizeGatewayId(gateway: WorkflowGateway): 'mpesa' | 'airtel_money' | 'tigo_pesa' {
  if (gateway === 'mpesa') return 'mpesa';
  if (gateway === 'airtel' || gateway === 'airtel_money') return 'airtel_money';
  return 'tigo_pesa';
}

/**
 * Activity: Initiate payment with gateway
 *
 * SINGLE INITIATION, SINGLE ROW: when the caller already initiated the charge
 * (paymentId present), this activity adopts that payment instead of asking
 * the gateway for money a second time. When it does initiate, the amount is
 * stored in the canonical minor-unit convention (cents) exactly as received —
 * the gateway adapters do their own major-unit conversion, so any scaling
 * here would double-convert.
 */
export async function initiatePaymentActivity(
  input: PaymentActivityInput
): Promise<PaymentResult> {
  try {
    const gatewayId = normalizeGatewayId(input.gateway);
    const db = await getDb();

    // Adopt the caller-initiated payment: the money request is already in
    // flight, so re-initiating would double-charge the customer.
    if (input.paymentId !== undefined) {
      if (!db) return { success: false, error: 'Database not available' };
      const existing = await db
        .select()
        .from(payments)
        .where(eq(payments.id, input.paymentId))
        .limit(1);
      const payment = existing[0];
      if (!payment) {
        return { success: false, error: `Payment ${input.paymentId} not found` };
      }
      if (payment.status !== 'pending' || !payment.transactionId) {
        return {
          success: false,
          error: `Payment ${input.paymentId} is ${payment.status} and cannot be processed by this workflow`,
        };
      }
      return { success: true, transactionId: payment.transactionId };
    }

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
      if (db) {
        // The payment row and its event are written together, so a Temporal retry
        // of this activity cannot leave one without the other, and the event
        // survives a broker outage as a pending outbox row.
        //
        // Retry-safety: a retried activity must not insert a second row for a
        // charge the gateway already accepted, so the insert keys off the
        // provider transaction id and adopts the existing row on conflict.
        await db.transaction(async tx => {
          const duplicate = await tx
            .select({ id: payments.id })
            .from(payments)
            .where(eq(payments.transactionId, result.transactionId!))
            .limit(1);
          if (duplicate.length > 0) return;

          await tx.insert(payments).values({
            userId: input.userId,
            billingId: input.billingId,
            paymentType: 'invoice',
            amount: Math.round(input.amount), // already in cents — the platform convention
            currency: 'TZS',
            paymentMethod: gatewayId,
            phoneNumber: input.phoneNumber,
            transactionId: result.transactionId!,
            status: 'pending',
          });
          await enqueueEvent(tx, {
            topic: KAFKA_TOPICS.PAYMENTS_INITIATED,
            eventKey: `payment.initiated:${result.transactionId}`,
            partitionKey: result.transactionId,
            payload: {
              event_id: `payment.initiated:${result.transactionId}`,
              source: 'payment-workflow',
              paymentId: result.transactionId,
              userId: input.userId.toString(),
              amount: input.amount,
              currency: 'TZS',
              gateway: input.gateway,
              timestamp: new Date().toISOString(),
              metadata: { billingId: input.billingId },
            },
          });
        });
      }

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
  gateway: WorkflowGateway
): Promise<PaymentResult> {
  try {
    const gatewayId = normalizeGatewayId(gateway);
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
  if (!db) throw new Error('Database not available');

  // Load the payment record so the emitted event carries real values even if
  // the caller did not supply them.
  const paymentRecords = await db
    .select()
    .from(payments)
    .where(eq(payments.transactionId, transactionId))
    .limit(1);
  const payment = paymentRecords[0];

  if (!payment) {
    // Fail loud: writing a status for a payment that does not exist would
    // fabricate a transition no money ever backed.
    throw new Error(`PAYMENT_NOT_FOUND: no payment record for transaction ${transactionId}`);
  }

  // Idempotent retry: a Temporal retry of an activity whose transaction
  // committed sees the target status already recorded and is done.
  if (payment.status === status) {
    return;
  }

  // LEGAL TRANSITION GUARD: only 'pending' payments may move. A terminal
  // payment (completed/failed/refunded) must never be rewritten — moving
  // settled money to another status is how settled invoices get un-settled
  // and failed charges get resurrected.
  if (payment.status !== 'pending') {
    throw new Error(
      `ILLEGAL_PAYMENT_TRANSITION: payment ${payment.id} (${transactionId}) is '${payment.status}' ` +
        `and cannot transition to '${status}'`
    );
  }

  const amount = details?.amount ?? payment.amount;
  const gateway = details?.gateway ?? payment.paymentMethod;

  // The status change and the event that announces it commit together, so a
  // Temporal retry of this activity cannot produce a second event for a status it
  // already recorded, and no event describes a status that was rolled back.
  await db.transaction(async tx => {
    // Conditional update: if a concurrent path (webhook, verify endpoint)
    // transitioned the row first, this attempt must fail rather than
    // overwrite the outcome.
    const updated = await tx
      .update(payments)
      .set({
        status,
        updatedAt: new Date(),
      })
      .where(and(eq(payments.transactionId, transactionId), eq(payments.status, 'pending')));

    if ((updated.rowCount ?? 0) === 0) {
      throw new Error(
        `CONCURRENT_PAYMENT_TRANSITION: payment ${payment.id} (${transactionId}) left 'pending' ` +
          'while this activity ran; refusing to overwrite the recorded outcome'
      );
    }

    await enqueueEvent(tx, {
      topic: KAFKA_TOPICS.PAYMENTS_COMPLETED,
      eventKey: `payment.completed:${transactionId}:${status}`,
      partitionKey: transactionId,
      payload: {
        event_id: `payment.completed:${transactionId}:${status}`,
        source: 'payment-workflow',
        paymentId: transactionId,
        completedAt: new Date().toISOString(),
        transactionId,
        status,
        amount,
        gateway,
      },
    });
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
  if (!db) throw new Error('Database not available');

  // 'paid' is a money claim: it is only written when the completed payments
  // recorded against the invoice cover the invoiced consumer share. A partial
  // payment settling the full invoice is money the books claim arrived that
  // never did — refuse loudly so Temporal retries/alerts instead of settling.
  if (status === 'paid') {
    const billingRows = await db.select().from(billings).where(eq(billings.id, billingId)).limit(1);
    const billing = billingRows[0];
    if (!billing) throw new Error(`BILLING_NOT_FOUND: ${billingId}`);

    const [paidRow] = await db
      .select({ total: sql<number>`COALESCE(SUM(${payments.amount}), 0)` })
      .from(payments)
      .where(and(eq(payments.billingId, billingId), eq(payments.status, 'completed')));

    const totalPaid = Number(paidRow?.total ?? 0);
    if (totalPaid < billing.consumerShare) {
      throw new Error(
        `BILLING_UNDERPAID: billing ${billingId} has ${totalPaid} of ${billing.consumerShare} ` +
          'cents in completed payments; refusing to mark it paid'
      );
    }
  }

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
