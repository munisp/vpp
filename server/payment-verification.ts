import { PaymentGatewayManager } from './payment-gateways';
import { getDb } from './db';
import { payments, paymentGatewayLogs } from '../drizzle/schema';
import { eq } from 'drizzle-orm';

/**
 * Real-time Payment Verification Service
 * Verifies payments with actual gateway APIs
 */
export class PaymentVerificationService {
  /**
   * Verify a payment with the gateway in real-time
   */
  static async verifyPayment(paymentId: number): Promise<{
    verified: boolean;
    matched: boolean;
    dbAmount: number;
    gatewayAmount?: number;
    dbStatus: string;
    gatewayStatus?: string;
    discrepancy?: string;
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

    // Check if we have a transaction ID
    if (!paymentRecord.transactionId) {
      return {
        verified: false,
        matched: false,
        dbAmount: paymentRecord.amount,
        dbStatus: paymentRecord.status,
        discrepancy: 'No gateway transaction ID',
      };
    }

    try {
      // Query gateway for transaction status
      // Determine environment from metadata or default to sandbox
      const environment: 'sandbox' | 'production' = 'sandbox'; // TODO: Get from payment metadata
      const statusResponse = await PaymentGatewayManager.queryPaymentStatus(
        paymentRecord.paymentMethod as 'mpesa' | 'airtel_money' | 'tigo_pesa',
        paymentRecord.transactionId,
        environment
      );

      // Log the verification attempt (only for mobile money gateways)
      if (['mpesa', 'airtel_money', 'tigo_pesa'].includes(paymentRecord.paymentMethod)) {
        await db.insert(paymentGatewayLogs).values({
          paymentId: paymentId,
          gateway: paymentRecord.paymentMethod as 'mpesa' | 'airtel_money' | 'tigo_pesa',
          requestType: 'VERIFY',
          requestPayload: JSON.stringify({ transactionId: paymentRecord.transactionId }),
          responsePayload: JSON.stringify(statusResponse),
          status: statusResponse.success ? 'success' : 'failed',
          errorMessage: statusResponse.success ? null : statusResponse.message,
        });
      }

      if (!statusResponse.success) {
        return {
          verified: false,
          matched: false,
          dbAmount: paymentRecord.amount,
          dbStatus: paymentRecord.status,
          discrepancy: `Gateway query failed: ${statusResponse.message}`,
        };
      }

      // Compare amounts and status
      const gatewayAmount = statusResponse.amount || 0;
      const amountMatches = Math.abs(paymentRecord.amount - gatewayAmount) < 10; // Allow 10 cent tolerance
      const statusMatches = this.statusMatches(paymentRecord.status, statusResponse.status);

      let discrepancy: string | undefined;
      if (!amountMatches) {
        discrepancy = `Amount mismatch: DB=${paymentRecord.amount}, Gateway=${gatewayAmount}`;
      } else if (!statusMatches) {
        discrepancy = `Status mismatch: DB=${paymentRecord.status}, Gateway=${statusResponse.status}`;
      }

      return {
        verified: true,
        matched: amountMatches && statusMatches,
        dbAmount: paymentRecord.amount,
        gatewayAmount,
        dbStatus: paymentRecord.status,
        gatewayStatus: statusResponse.status,
        discrepancy,
      };
    } catch (error: any) {
      // Log the error (only for mobile money gateways)
      if (['mpesa', 'airtel_money', 'tigo_pesa'].includes(paymentRecord.paymentMethod)) {
        await db.insert(paymentGatewayLogs).values({
          paymentId: paymentId,
          gateway: paymentRecord.paymentMethod as 'mpesa' | 'airtel_money' | 'tigo_pesa',
          requestType: 'VERIFY',
          requestPayload: JSON.stringify({ transactionId: paymentRecord.transactionId }),
          responsePayload: null,
          status: 'failed',
          errorMessage: error.message,
        });
      }

      return {
        verified: false,
        matched: false,
        dbAmount: paymentRecord.amount,
        dbStatus: paymentRecord.status,
        discrepancy: `Verification error: ${error.message}`,
      };
    }
  }

  /**
   * Batch verify multiple payments
   */
  static async batchVerifyPayments(paymentIds: number[]): Promise<Map<number, any>> {
    const results = new Map();

    for (const paymentId of paymentIds) {
      try {
        const result = await this.verifyPayment(paymentId);
        results.set(paymentId, result);
      } catch (error: any) {
        results.set(paymentId, {
          verified: false,
          matched: false,
          discrepancy: error.message,
        });
      }
    }

    return results;
  }

  /**
   * Check if statuses match (accounting for different naming conventions)
   */
  private static statusMatches(dbStatus: string, gatewayStatus: string): boolean {
    const normalize = (status: string) => status.toLowerCase().trim();

    const db = normalize(dbStatus);
    const gw = normalize(gatewayStatus);

    // Direct match
    if (db === gw) return true;

    // Common mappings
    const statusMap: Record<string, string[]> = {
      completed: ['success', 'successful', 'paid', 'confirmed'],
      pending: ['processing', 'initiated', 'in_progress'],
      failed: ['failure', 'rejected', 'declined', 'error'],
      cancelled: ['canceled', 'aborted', 'void'],
    };

    for (const [key, values] of Object.entries(statusMap)) {
      if ((db === key && values.includes(gw)) || (gw === key && values.includes(db))) {
        return true;
      }
    }

    return false;
  }

  /**
   * Schedule automatic verification for recent payments
   */
  static async verifyRecentPayments(hoursBack: number = 24): Promise<{
    total: number;
    verified: number;
    matched: number;
    discrepancies: number;
  }> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const cutoffDate = new Date();
    cutoffDate.setHours(cutoffDate.getHours() - hoursBack);

    // Get recent payments
    const recentPayments = await db
      .select()
      .from(payments)
      .where(eq(payments.status, 'completed')); // Only verify completed payments

    const paymentIds = recentPayments
      .filter(p => new Date(p.createdAt) >= cutoffDate)
      .map(p => p.id);

    const results = await this.batchVerifyPayments(paymentIds);

    let verified = 0;
    let matched = 0;
    let discrepancies = 0;

    for (const result of Array.from(results.values())) {
      if (result.verified) verified++;
      if (result.matched) matched++;
      if (result.discrepancy) discrepancies++;
    }

    return {
      total: paymentIds.length,
      verified,
      matched,
      discrepancies,
    };
  }
}
