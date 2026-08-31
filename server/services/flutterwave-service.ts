/**
 * Flutterwave v3 API Integration Service
 *
 * Handles Flutterwave standard payment initialization, transaction
 * verification, and refunds.
 * API Documentation: https://developer.flutterwave.com/v3.0/reference
 *
 * ANTI-MOCKWARE DISCIPLINE: this service never simulates a payment. When the
 * secret key is not configured every method fails loud with
 * `flutterwave_not_configured` and makes NO network call.
 */

import axios from 'axios';

export interface FlutterwaveConfig {
  secretKey: string;
  baseUrl: string;
}

export interface FlutterwavePaymentRequest {
  txRef: string;
  /** Amount in MAJOR currency units (e.g. NGN naira, not kobo). */
  amount: number;
  currency?: string; // defaults to NGN
  customer: {
    email: string;
    phonenumber?: string;
    name?: string;
  };
  redirectUrl?: string;
}

export interface FlutterwavePaymentResponse {
  success: boolean;
  txRef?: string;
  paymentLink?: string;
  message?: string;
  error?: string;
}

export interface FlutterwaveStatusResponse {
  success: boolean;
  status?: 'pending' | 'completed' | 'failed';
  resultDesc?: string;
  transactionId?: string; // Flutterwave's numeric transaction id, as a string
  amount?: number; // major units, as reported by Flutterwave
  error?: string;
}

export interface FlutterwaveRefundResponse {
  success: boolean;
  refundId?: string;
  message?: string;
  error?: string;
}

/** The fields of a Flutterwave POST /payments response this service reads. */
interface FlutterwaveInitializeApiResponse {
  status: string; // 'success' | 'error'
  message?: string;
  data?: {
    link?: string;
  };
}

/** The fields of a Flutterwave verify response this service reads. */
interface FlutterwaveVerifyApiResponse {
  status: string; // 'success' | 'error'
  message?: string;
  data?: {
    id?: number;
    tx_ref?: string;
    status?: string; // 'successful' | 'failed' | 'pending' | ...
    amount?: number;
    currency?: string;
  };
}

/** The fields of a Flutterwave POST /transactions/:id/refund response this service reads. */
interface FlutterwaveRefundApiResponse {
  status: string; // 'success' | 'error'
  message?: string;
  data?: {
    id?: number;
    status?: string;
    amount_refunded?: number;
  };
}

const NOT_CONFIGURED_ERROR = 'flutterwave_not_configured: FLUTTERWAVE_SECRET_KEY is not set';

class FlutterwaveService {
  /**
   * Read config from the environment lazily so deployments (and tests) can set
   * or rotate the key without reconstructing the service.
   */
  private getConfig(): FlutterwaveConfig | null {
    const secretKey = process.env.FLUTTERWAVE_SECRET_KEY;
    if (!secretKey) return null;
    return {
      secretKey,
      baseUrl: process.env.FLUTTERWAVE_BASE_URL || 'https://api.flutterwave.com/v3',
    };
  }

  private headers(secretKey: string) {
    return {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Initialize a standard payment. Flutterwave returns a hosted checkout link;
   * the tx_ref we generate is our reconciliation handle until Flutterwave
   * reports its numeric transaction id via webhook/redirect.
   */
  async initiatePayment(request: FlutterwavePaymentRequest): Promise<FlutterwavePaymentResponse> {
    const config = this.getConfig();
    if (!config) {
      console.error('[Flutterwave] Not configured: FLUTTERWAVE_SECRET_KEY is not set');
      return { success: false, error: NOT_CONFIGURED_ERROR };
    }

    if (!request.customer?.email) {
      // Flutterwave rejects a standard payment without a customer email; fail
      // here rather than sending a request guaranteed to be refused.
      return {
        success: false,
        error: 'flutterwave_invalid_request: customer email is required to initialize a payment',
      };
    }

    try {
      const payload: Record<string, unknown> = {
        tx_ref: request.txRef,
        amount: request.amount, // major units (e.g. naira)
        currency: request.currency || 'NGN',
        customer: request.customer,
      };
      if (request.redirectUrl) payload.redirect_url = request.redirectUrl;

      console.log('[Flutterwave] Initializing payment:', {
        txRef: request.txRef,
        amount: request.amount,
        currency: payload.currency,
      });

      const response = await axios.post<FlutterwaveInitializeApiResponse>(
        `${config.baseUrl}/payments`,
        payload,
        { headers: this.headers(config.secretKey), timeout: 30000 }
      );

      const data = response.data;
      if (data.status === 'success' && data.data?.link) {
        console.log('[Flutterwave] Payment initialized:', request.txRef);
        return {
          success: true,
          txRef: request.txRef,
          paymentLink: data.data.link,
          message: data.message || 'Payment initialized',
        };
      }

      console.error('[Flutterwave] Payment initialization refused:', data);
      return {
        success: false,
        error: data.message || 'Flutterwave payment initialization failed',
      };
    } catch (error: any) {
      console.error('[Flutterwave] Payment initialization error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message || 'Payment initiation failed',
      };
    }
  }

  /**
   * Map Flutterwave's data.status onto the platform's status vocabulary.
   * Only 'successful' maps to completed; 'failed' maps to failed; anything
   * else stays pending — never assume.
   */
  private mapStatus(flwStatus: string | undefined): 'pending' | 'completed' | 'failed' {
    if (flwStatus === 'successful') return 'completed';
    if (flwStatus === 'failed') return 'failed';
    return 'pending';
  }

  /**
   * Verify a transaction by Flutterwave's numeric transaction id.
   * GET /transactions/:id/verify
   */
  async verifyTransaction(transactionId: string): Promise<FlutterwaveStatusResponse> {
    const config = this.getConfig();
    if (!config) {
      console.error('[Flutterwave] Not configured: FLUTTERWAVE_SECRET_KEY is not set');
      return { success: false, error: NOT_CONFIGURED_ERROR };
    }

    try {
      const response = await axios.get<FlutterwaveVerifyApiResponse>(
        `${config.baseUrl}/transactions/${encodeURIComponent(transactionId)}/verify`,
        { headers: this.headers(config.secretKey), timeout: 30000 }
      );

      const data = response.data;
      if (data.status !== 'success' || !data.data) {
        console.error('[Flutterwave] Verify refused:', data);
        return {
          success: false,
          error: data.message || 'Flutterwave transaction verification failed',
        };
      }

      return {
        success: true,
        status: this.mapStatus(data.data.status),
        resultDesc: data.message,
        transactionId: data.data.id !== undefined ? String(data.data.id) : undefined,
        amount: data.data.amount,
      };
    } catch (error: any) {
      console.error('[Flutterwave] Verify error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message || 'Payment query failed',
      };
    }
  }

  /**
   * Query payment status by our tx_ref — what the platform stores at
   * initiation time, before Flutterwave's numeric id is known.
   * GET /transactions/verify_by_reference?tx_ref=...
   */
  async queryPaymentStatus(txRef: string): Promise<FlutterwaveStatusResponse> {
    const config = this.getConfig();
    if (!config) {
      console.error('[Flutterwave] Not configured: FLUTTERWAVE_SECRET_KEY is not set');
      return { success: false, error: NOT_CONFIGURED_ERROR };
    }

    try {
      const response = await axios.get<FlutterwaveVerifyApiResponse>(
        `${config.baseUrl}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`,
        { headers: this.headers(config.secretKey), timeout: 30000 }
      );

      const data = response.data;
      if (data.status !== 'success' || !data.data) {
        console.error('[Flutterwave] Status query refused:', data);
        return {
          success: false,
          error: data.message || 'Flutterwave status query failed',
        };
      }

      return {
        success: true,
        status: this.mapStatus(data.data.status),
        resultDesc: data.message,
        transactionId: data.data.id !== undefined ? String(data.data.id) : undefined,
        amount: data.data.amount,
      };
    } catch (error: any) {
      console.error('[Flutterwave] Status query error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message || 'Payment query failed',
      };
    }
  }

  /**
   * Refund a transaction by Flutterwave's numeric transaction id.
   * POST /transactions/:id/refund — succeeds only when Flutterwave accepts
   * the refund (status === 'success').
   */
  async processRefund(
    transactionId: string,
    amount: number,
    reason?: string
  ): Promise<FlutterwaveRefundResponse> {
    const config = this.getConfig();
    if (!config) {
      console.error('[Flutterwave] Not configured: FLUTTERWAVE_SECRET_KEY is not set');
      return { success: false, error: NOT_CONFIGURED_ERROR };
    }

    try {
      const response = await axios.post<FlutterwaveRefundApiResponse>(
        `${config.baseUrl}/transactions/${encodeURIComponent(transactionId)}/refund`,
        {
          amount, // major units
          ...(reason ? { comments: reason } : {}),
        },
        { headers: this.headers(config.secretKey), timeout: 30000 }
      );

      const data = response.data;
      if (data.status === 'success' && data.data) {
        console.log('[Flutterwave] Refund accepted:', data.data.id);
        return {
          success: true,
          refundId: data.data.id !== undefined ? String(data.data.id) : undefined,
          message: data.message || 'Refund accepted by Flutterwave',
        };
      }

      console.error('[Flutterwave] Refund rejected:', data);
      return {
        success: false,
        error: data.message || 'Flutterwave refund rejected by gateway',
      };
    } catch (error: any) {
      console.error('[Flutterwave] Refund error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message || 'Refund request failed',
      };
    }
  }
}

// Singleton instance
export const flutterwaveService = new FlutterwaveService();
