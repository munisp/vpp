import { getDb } from './db';
import {
  payments,
  paymentReconciliations,
  reconciliationReports,
  reconciliationAuditLogs,
  InsertPaymentReconciliation,
  InsertReconciliationAuditLog,
} from '../drizzle/schema';
import { eq, and, gte, lte, desc, count, sum } from 'drizzle-orm';
import { PaymentGatewayManager } from './payment-gateways';
import { resolveGatewayEnvironment } from './payment-gateways/environment';

/**
 * Map a stored payment method to the gateway that can be queried for it.
 * Methods without a status API (bank transfer, card) return null.
 */
function toGatewayId(paymentMethod: string): 'mpesa' | 'airtel_money' | 'tigo_pesa' | null {
  switch (paymentMethod) {
    case 'mpesa':
      return 'mpesa';
    case 'airtel_money':
      return 'airtel_money';
    case 'tigo_pesa':
      return 'tigo_pesa';
    default:
      return null;
  }
}

/**
 * Payment Reconciliation Engine
 * Automatically matches payments with gateway records
 */
export class PaymentReconciliationEngine {
  /**
   * Reconcile a single payment
   */
  static async reconcilePayment(paymentId: number): Promise<{
    status: 'matched' | 'unmatched' | 'discrepancy';
    reconciliationId: number;
    details?: string;
  }> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Get payment from database
    const payment = await db
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId))
      .limit(1);

    if (!payment.length) {
      throw new Error(`Payment ${paymentId} not found`);
    }

    const paymentRecord = payment[0];

    // Reconciliation compares the local record against what the gateway says.
    // Local data is never used as the gateway side of the comparison: doing so
    // would report every locally-asserted payment as externally confirmed.
    let gatewayData: { amount?: number; status: string; timestamp?: Date } | null = null;
    let reconciliationStatus: 'matched' | 'unmatched' | 'discrepancy';
    let details = '';

    const gateway = toGatewayId(paymentRecord.paymentMethod);

    if (!paymentRecord.transactionId) {
      reconciliationStatus = 'unmatched';
      details = 'No transaction ID from gateway';
    } else if (!gateway) {
      // Bank transfers and cards have no queryable status API here, so they
      // stay unmatched until an operator reconciles them from a statement.
      reconciliationStatus = 'unmatched';
      details = `${paymentRecord.paymentMethod} payments require manual reconciliation against the bank statement`;
    } else {
      try {
        const statusResponse = await PaymentGatewayManager.queryPaymentStatus(
          gateway,
          paymentRecord.transactionId,
          resolveGatewayEnvironment()
        );

        if (!statusResponse.success) {
          reconciliationStatus = 'unmatched';
          details = `Gateway could not confirm the transaction: ${statusResponse.message}`;
        } else {
          gatewayData = {
            amount:
              typeof statusResponse.amount === 'number'
                ? Math.round(statusResponse.amount * 100)
                : undefined,
            status: statusResponse.status,
            timestamp: statusResponse.completedAt,
          };

          const amountMismatch =
            typeof gatewayData.amount === 'number' && gatewayData.amount !== paymentRecord.amount;
          const statusDiffers =
            this.normalizeStatus(gatewayData.status) !== paymentRecord.status;

          if (amountMismatch || statusDiffers) {
            reconciliationStatus = 'discrepancy';
            details = [
              amountMismatch
                ? `amount differs (gateway ${gatewayData.amount} vs ledger ${paymentRecord.amount} cents)`
                : null,
              statusDiffers
                ? `status differs (gateway ${gatewayData.status} vs ledger ${paymentRecord.status})`
                : null,
            ]
              .filter(Boolean)
              .join('; ');
          } else {
            reconciliationStatus = 'matched';
            details = `Gateway confirmed ${gatewayData.status}`;
          }
        }
      } catch (error: any) {
        // An unreachable or unconfigured gateway means the payment is NOT
        // reconciled; it is surfaced, never silently counted as matched.
        reconciliationStatus = 'unmatched';
        details = `Gateway query failed: ${error?.message || String(error)}`;
      }
    }

    // Calculate differences
    const amountDifference =
      typeof gatewayData?.amount === 'number' ? gatewayData.amount - paymentRecord.amount : 0;
    const statusMismatch = gatewayData
      ? this.normalizeStatus(gatewayData.status) !== paymentRecord.status
      : false;
    const timeDifference = gatewayData?.timestamp
      ? Math.abs((new Date(gatewayData.timestamp).getTime() - paymentRecord.createdAt.getTime()) / 1000)
      : 0;

    // Create reconciliation record
    const reconciliationData: InsertPaymentReconciliation = {
      paymentId,
      reconciliationDate: new Date(),
      status: reconciliationStatus,
      gatewayTransactionId: paymentRecord.transactionId || null,
      gatewayAmount: gatewayData?.amount ?? null,
      gatewayStatus: gatewayData?.status || null,
      gatewayTimestamp: gatewayData?.timestamp ? new Date(gatewayData.timestamp) : null,
      dbAmount: paymentRecord.amount,
      dbStatus: paymentRecord.status,
      dbTimestamp: paymentRecord.createdAt,
      amountDifference,
      statusMismatch,
      timeDifference,
      metadata: JSON.stringify({ gatewayData }),
    };

    const result = await db.insert(paymentReconciliations).values(reconciliationData);
    const reconciliationId = result[0] ? result[0].insertId : 0;

    // Create audit log
    await this.createAuditLog({
      reconciliationId,
      action: reconciliationStatus === 'matched' ? 'matched' : 'flagged_discrepancy',
      performedBy: null, // System
      notes: details,
      newStatus: reconciliationStatus,
    });

    return {
      status: reconciliationStatus,
      reconciliationId,
      details,
    };
  }

  /**
   * Reconcile all payments in a date range
   */
  static async reconcilePayments(startDate: Date, endDate: Date): Promise<{
    total: number;
    matched: number;
    unmatched: number;
    discrepancies: number;
  }> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const paymentsToReconcile = await db
      .select()
      .from(payments)
      .where(
        and(
          gte(payments.createdAt, startDate),
          lte(payments.createdAt, endDate)
        )
      );

    let matched = 0;
    let unmatched = 0;
    let discrepancies = 0;

    for (const payment of paymentsToReconcile) {
      try {
        const result = await this.reconcilePayment(payment.id);
        if (result.status === 'matched') matched++;
        else if (result.status === 'unmatched') unmatched++;
        else if (result.status === 'discrepancy') discrepancies++;
      } catch (error) {
        console.error(`Failed to reconcile payment ${payment.id}:`, error);
        unmatched++;
      }
    }

    return {
      total: paymentsToReconcile.length,
      matched,
      unmatched,
      discrepancies,
    };
  }

  /**
   * Generate daily reconciliation report
   */
  static async generateDailyReport(date: Date): Promise<number> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    // Run reconciliation
    const reconciliationResults = await this.reconcilePayments(startOfDay, endOfDay);

    // Get reconciliation records for the day
    const reconciliations = await db
      .select()
      .from(paymentReconciliations)
      .where(
        and(
          gte(paymentReconciliations.reconciliationDate, startOfDay),
          lte(paymentReconciliations.reconciliationDate, endOfDay)
        )
      );

    // Calculate amounts
    let totalAmount = 0;
    let matchedAmount = 0;
    let discrepancyAmount = 0;
    const gatewayBreakdown: Record<string, any> = {};

    for (const rec of reconciliations) {
      totalAmount += rec.dbAmount || 0;
      
      if (rec.status === 'matched') {
        matchedAmount += rec.dbAmount || 0;
      } else if (rec.status === 'discrepancy') {
        discrepancyAmount += Math.abs(rec.amountDifference || 0);
      }

      // Group by gateway (get from payment)
      const payment = await db
        .select()
        .from(payments)
        .where(eq(payments.id, rec.paymentId))
        .limit(1);

      if (payment.length) {
        const gateway = payment[0].paymentMethod;
        if (!gatewayBreakdown[gateway]) {
          gatewayBreakdown[gateway] = { matched: 0, unmatched: 0, amount: 0 };
        }
        gatewayBreakdown[gateway].amount += rec.dbAmount || 0;
        if (rec.status === 'matched') {
          gatewayBreakdown[gateway].matched++;
        } else {
          gatewayBreakdown[gateway].unmatched++;
        }
      }
    }

    // Create report
    const report = await db.insert(reconciliationReports).values({
      reportDate: date,
      reportType: 'daily',
      totalPayments: reconciliationResults.total,
      matchedPayments: reconciliationResults.matched,
      unmatchedPayments: reconciliationResults.unmatched,
      discrepancies: reconciliationResults.discrepancies,
      totalAmount,
      matchedAmount,
      discrepancyAmount,
      gatewayBreakdown: JSON.stringify(gatewayBreakdown),
      generatedBy: null, // System
    });

    return 1; // Return success
  }

  /**
   * Manually resolve a reconciliation discrepancy
   */
  static async resolveDiscrepancy(
    reconciliationId: number,
    resolvedBy: number,
    notes: string,
    newStatus: 'matched' | 'unmatched'
  ): Promise<void> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Update reconciliation
    await db
      .update(paymentReconciliations)
      .set({
        status: newStatus,
        resolvedBy,
        resolvedAt: new Date(),
        resolutionNotes: notes,
      })
      .where(eq(paymentReconciliations.id, reconciliationId));

    // Create audit log
    await this.createAuditLog({
      reconciliationId,
      action: 'resolved',
      performedBy: resolvedBy,
      notes,
      previousStatus: 'discrepancy',
      newStatus,
    });
  }

  /**
   * Get reconciliation status for a payment
   */
  static async getReconciliationStatus(paymentId: number) {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const reconciliations = await db
      .select()
      .from(paymentReconciliations)
      .where(eq(paymentReconciliations.paymentId, paymentId))
      .orderBy(desc(paymentReconciliations.createdAt))
      .limit(1);

    return reconciliations.length ? reconciliations[0] : null;
  }

  /**
   * Get unresolved discrepancies
   */
  static async getUnresolvedDiscrepancies() {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    return await db
      .select()
      .from(paymentReconciliations)
      .where(eq(paymentReconciliations.status, 'discrepancy'))
      .orderBy(desc(paymentReconciliations.createdAt));
  }

  /**
   * Create audit log entry
   */
  private static async createAuditLog(data: InsertReconciliationAuditLog): Promise<void> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    await db.insert(reconciliationAuditLogs).values(data);
  }

  /**
   * Normalize payment status from different gateways
   */
  private static normalizeStatus(gatewayStatus: string): string {
    const normalized = gatewayStatus.toLowerCase();
    if (normalized.includes('success') || normalized.includes('complete')) {
      return 'completed';
    }
    if (normalized.includes('fail')) {
      return 'failed';
    }
    if (normalized.includes('pending')) {
      return 'pending';
    }
    return gatewayStatus;
  }
}
