/**
 * Unified Payment Gateway Service
 * 
 * Handles payments across multiple gateways: M-Pesa, Airtel Money, Tigo Pesa
 */

import { mpesaService } from './mpesa-service';
import { airtelMoneyService } from './airtel-money-service';
import { tigoPesaService } from './tigo-pesa-service';
import { getDb } from '../db';
import { payments } from '../../drizzle/schema';
import { eq } from 'drizzle-orm';

export type PaymentGateway = 'mpesa' | 'airtel_money' | 'tigo_pesa';

export interface PaymentRequest {
  gateway: PaymentGateway;
  phoneNumber: string;
  amount: number; // in cents
  currency: 'TZS' | 'NGN' | 'USD';
  accountReference: string;
  transactionDesc: string;
  userId: number;
  paymentType: 'invoice' | 'token_purchase' | 'monthly_fee';
  billingId?: number;
}

export interface PaymentResponse {
  success: boolean;
  paymentId?: number;
  transactionId?: string;
  checkoutRequestId?: string;
  message?: string;
  error?: string;
}

class PaymentGatewayService {
  /**
   * Initiate payment through the appropriate gateway
   */
  async initiatePayment(request: PaymentRequest): Promise<PaymentResponse> {
    try {
      // Create payment record
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      const paymentRecord = await db.insert(payments).values({
        userId: request.userId,
        billingId: request.billingId,
        paymentType: request.paymentType,
        amount: request.amount,
        currency: request.currency,
        paymentMethod: request.gateway,
        phoneNumber: request.phoneNumber,
        status: 'pending',
        metadata: JSON.stringify({
          accountReference: request.accountReference,
          transactionDesc: request.transactionDesc,
        }),
      });

      const paymentId = paymentRecord[0]?.insertId;
      if (!paymentId) throw new Error('Failed to create payment record');

      // Route to appropriate gateway
      let gatewayResponse;
      
      switch (request.gateway) {
        case 'mpesa':
          gatewayResponse = await mpesaService.initiatePayment({
            phoneNumber: request.phoneNumber,
            amount: request.amount / 100, // Convert cents to currency units
            accountReference: request.accountReference,
            transactionDesc: request.transactionDesc,
          });
          
          if (gatewayResponse.success && gatewayResponse.checkoutRequestId) {
            // Update payment with checkout request ID
            await db
              .update(payments)
              .set({
                transactionId: gatewayResponse.checkoutRequestId,
                metadata: JSON.stringify({
                  accountReference: request.accountReference,
                  transactionDesc: request.transactionDesc,
                  merchantRequestId: gatewayResponse.merchantRequestId,
                  checkoutRequestId: gatewayResponse.checkoutRequestId,
                }),
              })
              .where(eq(payments.id, paymentId));

            return {
              success: true,
              paymentId,
              transactionId: gatewayResponse.checkoutRequestId,
              checkoutRequestId: gatewayResponse.checkoutRequestId,
              message: gatewayResponse.message,
            };
          } else {
            // Mark payment as failed
            await db
              .update(payments)
              .set({ status: 'failed' })
              .where(eq(payments.id, paymentId));

            return {
              success: false,
              paymentId,
              error: gatewayResponse.error,
            };
          }

        case 'airtel_money':
          gatewayResponse = await airtelMoneyService.initiatePayment({
            phoneNumber: request.phoneNumber,
            amount: request.amount / 100,
            accountReference: request.accountReference,
            transactionDesc: request.transactionDesc,
          });
          
          if (gatewayResponse.success && gatewayResponse.transactionId) {
            await db
              .update(payments)
              .set({
                transactionId: gatewayResponse.transactionId,
                metadata: JSON.stringify({
                  accountReference: request.accountReference,
                  transactionDesc: request.transactionDesc,
                  referenceId: gatewayResponse.referenceId,
                }),
              })
              .where(eq(payments.id, paymentId));

            return {
              success: true,
              paymentId,
              transactionId: gatewayResponse.transactionId,
              message: gatewayResponse.message,
            };
          } else {
            await db
              .update(payments)
              .set({ status: 'failed' })
              .where(eq(payments.id, paymentId));

            return {
              success: false,
              paymentId,
              error: gatewayResponse.error,
            };
          }

        case 'tigo_pesa':
          gatewayResponse = await tigoPesaService.initiatePayment({
            phoneNumber: request.phoneNumber,
            amount: request.amount / 100,
            accountReference: request.accountReference,
            transactionDesc: request.transactionDesc,
          });
          
          if (gatewayResponse.success && gatewayResponse.transactionId) {
            await db
              .update(payments)
              .set({
                transactionId: gatewayResponse.transactionId,
                metadata: JSON.stringify({
                  accountReference: request.accountReference,
                  transactionDesc: request.transactionDesc,
                  referenceId: gatewayResponse.referenceId,
                }),
              })
              .where(eq(payments.id, paymentId));

            return {
              success: true,
              paymentId,
              transactionId: gatewayResponse.transactionId,
              message: gatewayResponse.message,
            };
          } else {
            await db
              .update(payments)
              .set({ status: 'failed' })
              .where(eq(payments.id, paymentId));

            return {
              success: false,
              paymentId,
              error: gatewayResponse.error,
            };
          }

        default:
          throw new Error(`Unsupported payment gateway: ${request.gateway}`);
      }
    } catch (error: any) {
      console.error('[PaymentGateway] Payment initiation error:', error);
      return {
        success: false,
        error: error.message || 'Payment initiation failed',
      };
    }
  }

  /**
   * Query payment status
   */
  async queryPaymentStatus(paymentId: number): Promise<{
    success: boolean;
    status: 'pending' | 'completed' | 'failed' | 'refunded';
    amount?: number;
    transactionId?: string;
    error?: string;
  }> {
    try {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      const paymentRecords = await db
        .select()
        .from(payments)
        .where(eq(payments.id, paymentId))
        .limit(1);

      if (paymentRecords.length === 0) {
        return {
          success: false,
          status: 'failed',
          error: 'Payment not found',
        };
      }

      const payment = paymentRecords[0];

      // If payment is still pending and has a transaction ID, query the gateway
      if (payment.status === 'pending' && payment.transactionId) {
        switch (payment.paymentMethod) {
          case 'mpesa':
            const mpesaStatus = await mpesaService.queryPaymentStatus(payment.transactionId);
            
            if (mpesaStatus.success) {
              // Update payment status
              await db
                .update(payments)
                .set({ status: 'completed' })
                .where(eq(payments.id, paymentId));

              return {
                success: true,
                status: 'completed',
                amount: payment.amount,
                transactionId: payment.transactionId,
              };
            } else if (mpesaStatus.resultCode && mpesaStatus.resultCode !== 1032) {
              // 1032 is "Request cancelled by user", keep as pending
              // Other codes mean failed
              await db
                .update(payments)
                .set({ status: 'failed' })
                .where(eq(payments.id, paymentId));

              return {
                success: false,
                status: 'failed',
                error: mpesaStatus.resultDesc,
              };
            }
            break;

          case 'airtel_money':
            const airtelStatus = await airtelMoneyService.queryPaymentStatus(payment.transactionId);
            
            if (airtelStatus.success && airtelStatus.status === 'completed') {
              await db
                .update(payments)
                .set({ status: 'completed' })
                .where(eq(payments.id, paymentId));

              return {
                success: true,
                status: 'completed',
                amount: payment.amount,
                transactionId: payment.transactionId,
              };
            } else if (airtelStatus.status === 'failed') {
              await db
                .update(payments)
                .set({ status: 'failed' })
                .where(eq(payments.id, paymentId));

              return {
                success: false,
                status: 'failed',
                error: airtelStatus.resultDesc,
              };
            }
            break;

          case 'tigo_pesa':
            const tigoStatus = await tigoPesaService.queryPaymentStatus(payment.transactionId);
            
            if (tigoStatus.success && tigoStatus.status === 'completed') {
              await db
                .update(payments)
                .set({ status: 'completed' })
                .where(eq(payments.id, paymentId));

              return {
                success: true,
                status: 'completed',
                amount: payment.amount,
                transactionId: payment.transactionId,
              };
            } else if (tigoStatus.status === 'failed') {
              await db
                .update(payments)
                .set({ status: 'failed' })
                .where(eq(payments.id, paymentId));

              return {
                success: false,
                status: 'failed',
                error: tigoStatus.resultDesc,
              };
            }
            break;
        }
      }

      return {
        success: true,
        status: payment.status as any,
        amount: payment.amount,
        transactionId: payment.transactionId || undefined,
      };
    } catch (error: any) {
      console.error('[PaymentGateway] Status query error:', error);
      return {
        success: false,
        status: 'failed',
        error: error.message || 'Status query failed',
      };
    }
  }

  /**
   * Process refund
   */
  async processRefund(paymentId: number, reason: string): Promise<{
    success: boolean;
    refundId?: string;
    error?: string;
  }> {
    try {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      const paymentRecords = await db
        .select()
        .from(payments)
        .where(eq(payments.id, paymentId))
        .limit(1);

      if (paymentRecords.length === 0) {
        return {
          success: false,
          error: 'Payment not found',
        };
      }

      const payment = paymentRecords[0];

      if (payment.status !== 'completed') {
        return {
          success: false,
          error: 'Only completed payments can be refunded',
        };
      }

      // Process refund through the appropriate gateway
      let refundResult: { success: boolean; refundId?: string; error?: string } = { success: false };
      const refundId = `REF-${paymentId}-${Date.now()}`;

      switch (payment.paymentMethod) {
        case 'mpesa':
          // M-Pesa B2C API for refunds
          // Note: M-Pesa refunds require B2C API which needs separate credentials
          // For now, we mark as refunded and log for manual processing
          console.log('[PaymentGateway] M-Pesa refund requires B2C API - marking for manual processing');
          refundResult = { success: true, refundId };
          break;

        case 'airtel_money':
          // Airtel Money refund API
          // Note: Airtel Money refunds require disbursement API
          console.log('[PaymentGateway] Airtel Money refund requires disbursement API - marking for manual processing');
          refundResult = { success: true, refundId };
          break;

        case 'tigo_pesa':
          // Tigo Pesa refund API
          // Note: Tigo Pesa refunds require disbursement API
          console.log('[PaymentGateway] Tigo Pesa refund requires disbursement API - marking for manual processing');
          refundResult = { success: true, refundId };
          break;

        default:
          return { success: false, error: `Unsupported payment method for refund: ${payment.paymentMethod}` };
      }

      if (!refundResult.success) {
        return { success: false, error: refundResult.error || 'Refund failed at gateway' };
      }

      // Update payment status to refunded
      await db
        .update(payments)
        .set({
          status: 'refunded',
          metadata: JSON.stringify({
            ...JSON.parse(payment.metadata || '{}'),
            refundReason: reason,
            refundedAt: new Date().toISOString(),
            refundId,
            refundStatus: 'pending_manual_processing',
          }),
        })
        .where(eq(payments.id, paymentId));

      console.log('[PaymentGateway] Payment marked for refund:', {
        paymentId,
        amount: payment.amount,
        reason,
        refundId,
      });

      return {
        success: true,
        refundId,
      };
    } catch (error: any) {
      console.error('[PaymentGateway] Refund error:', error);
      return {
        success: false,
        error: error.message || 'Refund failed',
      };
    }
  }

  /**
   * Get payment statistics
   */
  async getPaymentStats(userId?: number): Promise<{
    total: number;
    completed: number;
    pending: number;
    failed: number;
    totalAmount: number;
  }> {
    try {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      let allPayments;
      
      if (userId) {
        allPayments = await db
          .select()
          .from(payments)
          .where(eq(payments.userId, userId));
      } else {
        allPayments = await db.select().from(payments);
      }

      const stats = {
        total: allPayments.length,
        completed: allPayments.filter(p => p.status === 'completed').length,
        pending: allPayments.filter(p => p.status === 'pending').length,
        failed: allPayments.filter(p => p.status === 'failed').length,
        totalAmount: allPayments
          .filter(p => p.status === 'completed')
          .reduce((sum, p) => sum + p.amount, 0),
      };

      return stats;
    } catch (error: any) {
      console.error('[PaymentGateway] Stats error:', error);
      return {
        total: 0,
        completed: 0,
        pending: 0,
        failed: 0,
        totalAmount: 0,
      };
    }
  }
}

// Singleton instance
export const paymentGatewayService = new PaymentGatewayService();
