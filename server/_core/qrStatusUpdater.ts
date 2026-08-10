/**
 * Background service for updating QR transaction statuses.
 *
 * Queries the REAL payment gateways (via PaymentGatewayManager, which is
 * backed by database-stored gateway credentials) for the status of pending
 * QR transactions and updates qrCodeHistory accordingly. Nothing is
 * simulated: if a gateway cannot be resolved for a transaction it is skipped,
 * and on any gateway error the status is left as 'pending'.
 */

import { eq, and, lt } from "drizzle-orm";
import { getDb } from "../db";
import { qrCodeHistory } from "../../drizzle/qr-history-schema";
import { payments } from "../../drizzle/schema";
import { PaymentGatewayManager } from "../payment-gateways";

type GatewayId = "mpesa" | "airtel_money" | "tigo_pesa";

const PAYMENTS_ENV = (process.env.PAYMENTS_ENV || "sandbox") as "sandbox" | "production";

/**
 * Resolve the payment gateway and gateway reference for a QR transaction.
 *
 * QR transactions do not store a gateway column, so we resolve the linked
 * payment record by its transaction reference and read the real payment
 * method from it. Returns null when no resolvable gateway exists — the
 * caller must skip the transaction rather than guess.
 */
async function resolveGatewayForTransaction(
  reference: string | null
): Promise<{ gateway: GatewayId; gatewayReference: string } | null> {
  if (!reference) return null;

  const db = await getDb();
  if (!db) return null;

  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.transactionId, reference))
    .limit(1);

  if (!payment) return null;

  const method = payment.paymentMethod;
  if (method !== "mpesa" && method !== "airtel_money" && method !== "tigo_pesa") {
    return null;
  }

  // M-Pesa status queries require the CheckoutRequestID, which is stored in
  // the payment metadata at initiation time when available.
  let gatewayReference = reference;
  if (payment.metadata) {
    try {
      const metadata = JSON.parse(payment.metadata);
      if (typeof metadata.checkoutRequestId === "string" && metadata.checkoutRequestId.length > 0) {
        gatewayReference = metadata.checkoutRequestId;
      }
    } catch {
      console.warn(
        `[QR Status Updater] Unparseable payment metadata for transaction ${payment.id}; using transaction reference`
      );
    }
  }

  return { gateway: method, gatewayReference };
}

/**
 * Query the real payment gateway for the current status of a transaction.
 * Returns null when the gateway cannot be resolved or the query fails — in
 * both cases the transaction must remain 'pending'.
 */
async function checkPaymentGatewayStatus(
  reference: string | null
): Promise<{ status: "completed" | "failed" | "pending"; gatewayReference?: string } | null> {
  const resolved = await resolveGatewayForTransaction(reference);
  if (!resolved) {
    console.warn(
      `[QR Status Updater] No resolvable payment gateway for reference "${reference ?? "(none)"}" — skipping`
    );
    return null;
  }

  try {
    const result = await PaymentGatewayManager.queryPaymentStatus(
      resolved.gateway,
      resolved.gatewayReference,
      PAYMENTS_ENV
    );

    if (result.status === "completed") {
      return {
        status: "completed",
        gatewayReference: result.transactionId ?? resolved.gatewayReference,
      };
    }
    if (result.status === "failed" || result.status === "cancelled") {
      return {
        status: "failed",
        gatewayReference: result.transactionId ?? resolved.gatewayReference,
      };
    }
    return { status: "pending", gatewayReference: resolved.gatewayReference };
  } catch (error) {
    console.error(
      `[QR Status Updater] Gateway status query failed (${resolved.gateway}, ref ${resolved.gatewayReference}):`,
      error
    );
    return null;
  }
}

/**
 * Update status for a single QR transaction
 */
async function updateTransactionStatus(transactionId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) {
    console.warn("[QR Status Updater] Database not available");
    return false;
  }

  try {
    // Get current transaction
    const [transaction] = await db
      .select()
      .from(qrCodeHistory)
      .where(eq(qrCodeHistory.id, transactionId))
      .limit(1);

    if (!transaction) {
      console.warn(`[QR Status Updater] Transaction ${transactionId} not found`);
      return false;
    }

    // Skip if already completed or failed
    if (transaction.status === "completed" || transaction.status === "failed") {
      return false;
    }

    // Query the real payment gateway
    const gatewayStatus = await checkPaymentGatewayStatus(transaction.reference);

    // Unresolvable gateway or query error: leave status untouched ('pending')
    if (!gatewayStatus || gatewayStatus.status === "pending") {
      return false;
    }

    // Update transaction status
    await db
      .update(qrCodeHistory)
      .set({
        status: gatewayStatus.status,
        completedAt: gatewayStatus.status === "completed" ? new Date() : transaction.completedAt,
        updatedAt: new Date(),
      })
      .where(eq(qrCodeHistory.id, transactionId));

    console.log(
      `[QR Status Updater] Updated transaction ${transactionId}: ${transaction.status} → ${gatewayStatus.status}` +
        (gatewayStatus.gatewayReference ? ` (gateway ref ${gatewayStatus.gatewayReference})` : "")
    );

    return true;
  } catch (error) {
    console.error(`[QR Status Updater] Error updating transaction ${transactionId}:`, error);
    return false;
  }
}

/**
 * Process all pending QR transactions
 * Updates status for transactions that are still pending
 */
export async function processPendingTransactions(): Promise<{
  processed: number;
  updated: number;
  failed: number;
}> {
  const db = await getDb();
  if (!db) {
    console.warn("[QR Status Updater] Database not available");
    return { processed: 0, updated: 0, failed: 0 };
  }

  try {
    // Get all pending transactions
    const pendingTransactions = await db
      .select()
      .from(qrCodeHistory)
      .where(eq(qrCodeHistory.status, "pending"))
      .limit(100); // Process in batches

    let updated = 0;
    let failed = 0;

    for (const transaction of pendingTransactions) {
      const success = await updateTransactionStatus(transaction.id);
      if (success) {
        updated++;
      } else {
        failed++;
      }
    }

    console.log(
      `[QR Status Updater] Processed ${pendingTransactions.length} transactions: ${updated} updated, ${failed} skipped/unchanged`
    );

    return {
      processed: pendingTransactions.length,
      updated,
      failed,
    };
  } catch (error) {
    console.error("[QR Status Updater] Error processing pending transactions:", error);
    return { processed: 0, updated: 0, failed: 0 };
  }
}

/**
 * Auto-expire old pending transactions
 * Marks transactions as expired if they've been pending for too long
 */
export async function expireOldTransactions(maxAgeHours: number = 24): Promise<number> {
  const db = await getDb();
  if (!db) {
    console.warn("[QR Status Updater] Database not available");
    return 0;
  }

  try {
    const expiryDate = new Date();
    expiryDate.setHours(expiryDate.getHours() - maxAgeHours);

    await db
      .update(qrCodeHistory)
      .set({
        status: "expired",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(qrCodeHistory.status, "pending"),
          lt(qrCodeHistory.createdAt, expiryDate)
        )
      );

    console.log(`[QR Status Updater] Expired old transactions`);

    return 0; // Return count not available in Drizzle
  } catch (error) {
    console.error("[QR Status Updater] Error expiring old transactions:", error);
    return 0;
  }
}

/**
 * Start background job to process pending transactions
 * Runs every 5 minutes
 */
export function startStatusUpdateJob() {
  console.log("[QR Status Updater] Starting background job (5 minute interval)");

  // Run immediately on startup
  processPendingTransactions();
  expireOldTransactions();

  // Then run every 5 minutes
  setInterval(async () => {
    await processPendingTransactions();
    await expireOldTransactions();
  }, 5 * 60 * 1000); // 5 minutes
}
