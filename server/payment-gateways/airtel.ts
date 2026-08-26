import {
  BasePaymentGateway,
  PaymentRequest,
  PaymentResponse,
  PaymentStatusResponse,
  PaymentCallbackData,
} from './base';
import { toGatewayMajorUnits } from '../_core/paymentGateway';

interface AirtelCredentials {
  clientId: string;
  clientSecret: string;
  merchantCode: string;
  callbackUrl: string;
}

/**
 * Airtel Money Payment Gateway Implementation
 */
export class AirtelMoneyGateway extends BasePaymentGateway {
  readonly gatewayId = 'airtel_money' as const;
  readonly gatewayName = 'Airtel Money';

  private accessToken: string = '';
  private tokenExpiry: number = 0;

  protected getBaseUrl(): string {
    const sandboxUrl = 'https://openapiuat.airtel.africa';
    if (this.environment !== 'production') return sandboxUrl;

    const configured = process.env.AIRTEL_PRODUCTION_BASE_URL?.trim();
    if (!configured) {
      throw new Error(
        'AIRTEL_PRODUCTION_BASE_URL must be configured before Airtel production payments are enabled.'
      );
    }

    let url: URL;
    try {
      url = new URL(configured);
    } catch {
      throw new Error('AIRTEL_PRODUCTION_BASE_URL must be an absolute HTTPS URL.');
    }

    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('AIRTEL_PRODUCTION_BASE_URL must be a credential-free HTTPS origin or path.');
    }
    if (url.origin === sandboxUrl) {
      throw new Error('AIRTEL_PRODUCTION_BASE_URL must not point to the Airtel UAT endpoint.');
    }

    return url.pathname === '/' ? url.origin : `${url.origin}${url.pathname.replace(/\/$/, '')}`;
  }

  private get creds(): AirtelCredentials {
    return this.credentials as AirtelCredentials;
  }

  /**
   * Get OAuth access token
   */
  private async getAccessToken(): Promise<string> {
    // Return cached token if still valid
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const response = await fetch(`${this.getBaseUrl()}/auth/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
        grant_type: 'client_credentials',
      }),
    });

    if (!response.ok) {
      throw new Error('Failed to get Airtel Money access token');
    }

    const data = await response.json();
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + (parseInt(data.expires_in) - 60) * 1000;

    return this.accessToken;
  }

  /**
   * Initiate Airtel Money payment
   */
  async initiatePayment(request: PaymentRequest): Promise<PaymentResponse> {
    this.ensureInitialized();

    const token = await this.getAccessToken();

    // Format phone number (ensure country code)
    let phone = request.phoneNumber.replace(/\D/g, '');
    if (phone.startsWith('0')) {
      phone = '255' + phone.slice(1); // Tanzania country code
    }

    const transactionId = `TXN${Date.now()}${Math.random().toString(36).substring(7)}`;

    const payload = {
      reference: transactionId,
      subscriber: {
        country: 'TZ',
        currency: 'TZS',
        msisdn: phone,
      },
      transaction: {
        amount: toGatewayMajorUnits(request.amount),
        country: 'TZ',
        currency: 'TZS',
        id: transactionId,
      },
    };

    try {
      const response = await fetch(`${this.getBaseUrl()}/merchant/v1/payments/`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Country': 'TZ',
          'X-Currency': 'TZS',
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (data.status?.code === '200' || data.status?.success === true) {
        return {
          success: true,
          transactionId: data.data?.transaction?.id || transactionId,
          message: data.status?.message || 'Payment initiated successfully',
          rawResponse: data,
        };
      } else {
        return {
          success: false,
          message: data.status?.message || 'Payment initiation failed',
          rawResponse: data,
        };
      }
    } catch (error: any) {
      return {
        success: false,
        message: error.message || 'Payment initiation failed',
      };
    }
  }

  /**
   * Query payment status
   */
  async queryPaymentStatus(transactionId: string): Promise<PaymentStatusResponse> {
    this.ensureInitialized();

    const token = await this.getAccessToken();

    try {
      const response = await fetch(`${this.getBaseUrl()}/standard/v1/payments/${transactionId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Country': 'TZ',
          'X-Currency': 'TZS',
        },
      });

      const data = await response.json();

      let status: 'pending' | 'completed' | 'failed' | 'cancelled' = 'pending';
      
      if (data.status?.code === '200' && data.data?.transaction?.status === 'TS') {
        status = 'completed';
      } else if (data.data?.transaction?.status === 'TF') {
        status = 'failed';
      } else if (data.data?.transaction?.status === 'TA') {
        status = 'cancelled';
      }

      return {
        success: true,
        status,
        transactionId,
        amount: data.data?.transaction?.amount ? data.data.transaction.amount * 100 : undefined,
        message: data.status?.message || 'Query successful',
        rawResponse: data,
      };
    } catch (error: any) {
      return {
        success: false,
        status: 'pending',
        message: error.message || 'Query failed',
      };
    }
  }

  /**
   * Process Airtel Money callback
   */
  async processCallback(callbackData: any): Promise<PaymentCallbackData> {
    const transaction = callbackData.transaction;
    
    if (!transaction) {
      throw new Error('Invalid Airtel Money callback format');
    }

    let status: 'completed' | 'failed' | 'cancelled' = 'failed';
    if (transaction.status === 'TS') {
      status = 'completed';
    } else if (transaction.status === 'TA') {
      status = 'cancelled';
    }

    return {
      transactionId: transaction.id,
      amount: transaction.amount ? transaction.amount * 100 : 0,
      phoneNumber: transaction.msisdn || '',
      status,
      resultCode: transaction.status,
      resultDesc: transaction.message || callbackData.status?.message,
      metadata: callbackData,
    };
  }

  /**
   * Validate Airtel Money credentials
   */
  async validateCredentials(): Promise<{ valid: boolean; message: string }> {
    try {
      this.ensureInitialized();
      await this.getAccessToken();
      return {
        valid: true,
        message: 'Airtel Money credentials are valid',
      };
    } catch (error: any) {
      return {
        valid: false,
        message: error.message || 'Invalid Airtel Money credentials',
      };
    }
  }
}
