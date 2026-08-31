/**
 * Paystack API Integration Service
 *
 * Handles Paystack transaction initialization, verification, and refunds.
 * API Documentation: https://paystack.com/docs/api/
 *
 * ANTI-MOCKWARE DISCIPLINE: this service never simulates a payment. When the
 * secret key is not configured every method fails loud with
 * `paystack_not_configured` and makes NO network call.
 */

import axios from 'axios';

export interface PaystackConfig {
  secretKey: string;
  baseUrl: string;
}

export interface PaystackPaymentRequest {
  email: string;
  /** Amount in kobo — Paystack's minor unit for NGN (1 NGN = 100 kobo). */
  amount: number;
  reference: string;
  callbackUrl?: string;
  currency?: string; // defaults to NGN
}

export interface PaystackPaymentResponse {
  success: boolean;
  reference?: string;
  authorizationUrl?: string;
  accessCode?: string;
  message?: string;
  error?: string;
}

export interface PaystackStatusResponse {
  success: boolean;
  status?: 'pending' | 'completed' | 'failed';
  resultDesc?: string;
  amount?: number; // kobo, as reported by Paystack
  error?: string;
}

export interface PaystackRefundResponse {
  success: boolean;
  refundId?: string;
  message?: string;
  error?: string;
}

/** The fields of a Paystack /transaction/initialize response this service reads. */
interface PaystackInitializeApiResponse {
  status: boolean;
  message?: string;
  data?: {
    authorization_url?: string;
    access_code?: string;
    reference?: string;
  };
}

/** The fields of a Paystack /transaction/verify/:reference response this service reads. */
interface PaystackVerifyApiResponse {
  status: boolean;
  message?: string;
  data?: {
    status?: string; // 'success' | 'failed' | 'abandoned' | 'pending' | ...
    reference?: string;
    amount?: number; // kobo
    gateway_response?: string;
  };
}

/** The fields of a Paystack /refund response this service reads. */
interface PaystackRefundApiResponse {
  status: boolean;
  message?: string;
  data?: {
    id?: number;
    status?: string; // 'pending' | 'processed' | 'failed' | ...
    transaction?: number;
  };
}

const NOT_CONFIGURED_ERROR = 'paystack_not_configured: PAYSTACK_SECRET_KEY is not set';

class PaystackService {
  /**
   * Read config from the environment lazily so deployments (and tests) can set
   * or rotate the key without reconstructing the service.
   */
  private getConfig(): PaystackConfig | null {
    const secretKey = process.env.PAYSTACK_SECRET_KEY;
    if (!secretKey) return null;
    return {
      secretKey,
      baseUrl: process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co',
    };
  }

  private headers(secretKey: string) {
    return {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Initialize a transaction. Paystack returns an authorization URL the
   * customer is redirected to; the reference is our reconciliation handle.
   */
  async initiatePayment(request: PaystackPaymentRequest): Promise<PaystackPaymentResponse> {
    const config = this.getConfig();
    if (!config) {
      console.error('[Paystack] Not configured: PAYSTACK_SECRET_KEY is not set');
      return { success: false, error: NOT_CONFIGURED_ERROR };
    }

    if (!request.email) {
      // Paystack rejects an initialize call without a customer email; fail
      // here rather than sending a request guaranteed to be refused.
      return {
        success: false,
        error: 'paystack_invalid_request: customer email is required to initialize a transaction',
      };
    }

    try {
      const payload: Record<string, unknown> = {
        email: request.email,
        amount: Math.round(request.amount), // kobo — must be an integer
        reference: request.reference,
        currency: request.currency || 'NGN',
      };
      if (request.callbackUrl) payload.callback_url = request.callbackUrl;

      console.log('[Paystack] Initializing transaction:', {
        email: request.email,
        amount: payload.amount,
        reference: request.reference,
      });

      const response = await axios.post<PaystackInitializeApiResponse>(
        `${config.baseUrl}/transaction/initialize`,
        payload,
        { headers: this.headers(config.secretKey), timeout: 30000 }
      );

      const data = response.data;
      if (data.status === true && data.data?.reference) {
        console.log('[Paystack] Transaction initialized:', data.data.reference);
        return {
          success: true,
          reference: data.data.reference,
          authorizationUrl: data.data.authorization_url,
          accessCode: data.data.access_code,
          message: data.message || 'Transaction initialized',
        };
      }

      console.error('[Paystack] Transaction initialization refused:', data);
      return {
        success: false,
        error: data.message || 'Paystack transaction initialization failed',
      };
    } catch (error: any) {
      console.error('[Paystack] Transaction initialization error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message || 'Payment initiation failed',
      };
    }
  }

  /**
   * Verify a transaction by reference. Paystack's data.status is the source of
   * truth: only 'success' maps to completed; 'failed'/'abandoned'/'reversed'
   * map to failed; anything else stays pending — never assume.
   */
  async queryPaymentStatus(reference: string): Promise<PaystackStatusResponse> {
    const config = this.getConfig();
    if (!config) {
      console.error('[Paystack] Not configured: PAYSTACK_SECRET_KEY is not set');
      return { success: false, error: NOT_CONFIGURED_ERROR };
    }

    try {
      const response = await axios.get<PaystackVerifyApiResponse>(
        `${config.baseUrl}/transaction/verify/${encodeURIComponent(reference)}`,
        { headers: this.headers(config.secretKey), timeout: 30000 }
      );

      const data = response.data;
      if (data.status !== true || !data.data) {
        console.error('[Paystack] Verify refused:', data);
        return {
          success: false,
          error: data.message || 'Paystack transaction verification failed',
        };
      }

      const txStatus = data.data.status;
      let mappedStatus: 'pending' | 'completed' | 'failed';
      if (txStatus === 'success') {
        mappedStatus = 'completed';
      } else if (txStatus === 'failed' || txStatus === 'abandoned' || txStatus === 'reversed') {
        mappedStatus = 'failed';
      } else {
        // 'pending', 'ongoing', 'queued', or an unknown status: stay pending.
        mappedStatus = 'pending';
      }

      return {
        success: true,
        status: mappedStatus,
        resultDesc: data.data.gateway_response || data.message,
        amount: data.data.amount,
      };
    } catch (error: any) {
      console.error('[Paystack] Verify error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message || 'Payment query failed',
      };
    }
  }

  /**
   * Refund a transaction by its reference. A refund only counts as successful
   * when Paystack accepts it (status === true); completion is asynchronous on
   * Paystack's side, mirroring the M-Pesa reversal semantics.
   */
  async processRefund(transactionReference: string, reason: string): Promise<PaystackRefundResponse> {
    const config = this.getConfig();
    if (!config) {
      console.error('[Paystack] Not configured: PAYSTACK_SECRET_KEY is not set');
      return { success: false, error: NOT_CONFIGURED_ERROR };
    }

    try {
      const response = await axios.post<PaystackRefundApiResponse>(
        `${config.baseUrl}/refund`,
        {
          transaction: transactionReference,
          merchant_note: reason,
        },
        { headers: this.headers(config.secretKey), timeout: 30000 }
      );

      const data = response.data;
      if (data.status === true && data.data) {
        console.log('[Paystack] Refund accepted:', data.data.id);
        return {
          success: true,
          refundId: data.data.id !== undefined ? String(data.data.id) : undefined,
          message: data.message || 'Refund accepted by Paystack',
        };
      }

      console.error('[Paystack] Refund rejected:', data);
      return {
        success: false,
        error: data.message || 'Paystack refund rejected by gateway',
      };
    } catch (error: any) {
      console.error('[Paystack] Refund error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message || 'Refund request failed',
      };
    }
  }
}

// Singleton instance
export const paystackService = new PaystackService();
