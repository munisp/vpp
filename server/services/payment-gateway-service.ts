/**
 * Unified Payment Gateway Service
 * 
 * Handles payments across multiple gateways: M-Pesa, Airtel Money, Tigo Pesa
 */

import axios from 'axios';
import { mpesaService } from './mpesa-service';
import { airtelMoneyService } from './airtel-money-service';
import { tigoPesaService } from './tigo-pesa-service';
import { getDb } from '../db';
import { payments, paymentCredentials } from '../../drizzle/schema';
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

      // Process refund through the appropriate gateway. A refund only succeeds
      // when the gateway confirms it; otherwise the payment is flagged for
      // manual review and NEVER marked as refunded.
      const refundId = `REF-${paymentId}-${Date.now()}`;
      const existingMetadata = JSON.parse(payment.metadata || '{}');

      let refundResult: { success: boolean; refundId?: string; error?: string };

      switch (payment.paymentMethod) {
        case 'mpesa':
          refundResult = await this.attemptMpesaReversal(payment, existingMetadata, reason);
          break;

        case 'airtel_money':
        case 'tigo_pesa':
          // Neither provider integration exposes an automated refund/reversal
          // endpoint in this codebase, so a refund cannot be gateway-confirmed.
          console.warn(`[PaymentGateway] ${payment.paymentMethod} does not support automated refunds - flagging for manual review`);
          refundResult = { success: false, error: 'refund_not_supported' };
          break;

        default:
          return { success: false, error: `Unsupported payment method for refund: ${payment.paymentMethod}` };
      }

      if (!refundResult.success) {
        // Gateway could not confirm the refund: flag for manual review, keep
        // the payment status unchanged, and report the failure honestly.
        await db
          .update(payments)
          .set({
            metadata: JSON.stringify({
              ...existingMetadata,
              refundReason: reason,
              refundRequestedAt: new Date().toISOString(),
              refundId,
              refundStatus: 'manual_review_required',
              refundError: refundResult.error,
            }),
          })
          .where(eq(payments.id, paymentId));

        return {
          success: false,
          error: refundResult.error || 'refund_not_supported',
          refundId,
        };
      }

      // Gateway confirmed the refund — safe to mark as refunded.
      await db
        .update(payments)
        .set({
          status: 'refunded',
          metadata: JSON.stringify({
            ...existingMetadata,
            refundReason: reason,
            refundedAt: new Date().toISOString(),
            refundId: refundResult.refundId || refundId,
            refundStatus: 'confirmed',
          }),
        })
        .where(eq(payments.id, paymentId));

      console.log('[PaymentGateway] Refund confirmed by gateway:', {
        paymentId,
        amount: payment.amount,
        reason,
        refundId: refundResult.refundId || refundId,
      });

      return {
        success: true,
        refundId: refundResult.refundId || refundId,
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
   * Attempt a real M-Pesa TransactionReversal via the Daraja API.
   *
   * Uses the same credential store and OAuth flow as MPesaService, plus the
   * initiator credentials required by the reversal endpoint. Returns success
   * only when the gateway accepts the reversal (ResponseCode '0'); any other
   * outcome is a failure so the caller can flag the payment for manual review.
   */
  private async attemptMpesaReversal(
    payment: { id: number; amount: number; transactionId: string | null },
    metadata: Record<string, any>,
    reason: string
  ): Promise<{ success: boolean; refundId?: string; error?: string }> {
    try {
      // The reversal API needs the original M-Pesa receipt number (e.g. QK123ABC),
      // which is stored in payment metadata when the STK callback completes.
      const mpesaReceiptNumber = metadata.mpesaReceiptNumber;
      if (!mpesaReceiptNumber) {
        return {
          success: false,
          error: 'refund_not_supported: original M-Pesa receipt number not recorded for this payment',
        };
      }

      const db = await getDb();
      if (!db) throw new Error('Database not available');

      const creds = await db
        .select()
        .from(paymentCredentials)
        .where(eq(paymentCredentials.gateway, 'mpesa'))
        .limit(1);

      if (!creds || creds.length === 0) {
        return { success: false, error: 'M-Pesa credentials not configured' };
      }

      const credentials = JSON.parse(creds[0].credentials);
      const apiUrl = credentials.apiUrl || 'https://api.safaricom.co.ke';
      const initiator = credentials.initiator || process.env.MPESA_INITIATOR;
      const securityCredential = credentials.securityCredential || process.env.MPESA_SECURITY_CREDENTIAL;
      const callbackUrl = credentials.callbackUrl || process.env.MPESA_CALLBACK_URL;

      if (!initiator || !securityCredential) {
        return {
          success: false,
          error: 'refund_not_supported: M-Pesa reversal initiator credentials not configured',
        };
      }

      // OAuth token (same flow as MPesaService.generateToken)
      const auth = Buffer.from(`${credentials.consumerKey}:${credentials.consumerSecret}`).toString('base64');
      const tokenResponse = await axios.get<{ access_token: string }>(
        `${apiUrl}/oauth/v1/generate?grant_type=client_credentials`,
        { headers: { Authorization: `Basic ${auth}` }, timeout: 15000 }
      );
      const accessToken = tokenResponse.data.access_token;

      const response = await axios.post(
        `${apiUrl}/mpesa/reversal/v1/request`,
        {
          Initiator: initiator,
          SecurityCredential: securityCredential,
          CommandID: 'TransactionReversal',
          TransactionID: mpesaReceiptNumber,
          Amount: Math.round(payment.amount / 100), // cents -> currency units
          ReceiverParty: credentials.shortcode,
          RecieverIdentifierType: '11',
          ResultURL: callbackUrl,
          QueueTimeOutURL: callbackUrl,
          Remarks: reason,
          Occasion: `Refund for payment ${payment.id}`,
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );

      const data = response.data;
      if (data.ResponseCode === '0' || data.ResponseCode === 0) {
        // Gateway accepted the reversal; completion is confirmed asynchronously
        // via the ResultURL callback, which reconciles against this ID.
        return {
          success: true,
          refundId: data.ConversationID || data.OriginatorConversationID,
        };
      }

      console.error('[PaymentGateway] M-Pesa reversal rejected:', data);
      return {
        success: false,
        error: data.ResponseDescription || data.errorMessage || 'M-Pesa reversal rejected by gateway',
      };
    } catch (error: any) {
      console.error('[PaymentGateway] M-Pesa reversal error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.errorMessage || error.message || 'M-Pesa reversal request failed',
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
