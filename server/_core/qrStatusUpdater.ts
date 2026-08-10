/**
 * Background service for updating QR transaction statuses
 * Simulates checking payment gateway status and updating transaction records
 */

import { eq, and, lt } from "drizzle-orm";
import { getDb } from "../db";
import { qrCodeHistory } from "../../drizzle/qr-history-schema";

/**
 * Check payment gateway status (simulated)
 * In production, this would call actual payment gateway APIs
 */
async function checkPaymentGatewayStatus(transactionId: number): Promise<{
  status: "completed" | "failed" | "pending";
  gatewayReference?: string;
}> {
  // Simulate API call delay
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Simulate 80% success rate, 10% failure, 10% still pending
  const random = Math.random();
  if (random < 0.8) {
    return {
      status: "completed",
      gatewayReference: `GW-${Date.now()}-${transactionId}`,
    };
  } else if (random < 0.9) {
    return {
      status: "failed",
      gatewayReference: `GW-${Date.now()}-${transactionId}`,
    };
  } else {
    return {
      status: "pending",
    };
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

    // Check payment gateway
    const gatewayStatus = await checkPaymentGatewayStatus(transactionId);

    // Update transaction status
    await db
      .update(qrCodeHistory)
      .set({
        status: gatewayStatus.status,
        updatedAt: new Date(),
      })
      .where(eq(qrCodeHistory.id, transactionId));

    console.log(
      `[QR Status Updater] Updated transaction ${transactionId}: ${transaction.status} → ${gatewayStatus.status}`
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
      `[QR Status Updater] Processed ${pendingTransactions.length} transactions: ${updated} updated, ${failed} failed`
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
 * Marks transactions as failed if they've been pending for too long
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
        status: "failed",
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
