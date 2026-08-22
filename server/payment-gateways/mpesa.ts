import {
  BasePaymentGateway,
  PaymentRequest,
  PaymentResponse,
  PaymentStatusResponse,
  PaymentCallbackData,
} from './base';
import { toGatewayMajorUnits } from '../_core/paymentGateway';

interface MpesaCredentials {
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  passkey: string;
  callbackUrl: string;
}

/**
 * M-Pesa (Safaricom) Payment Gateway Implementation
 * Implements STK Push (Lipa Na M-Pesa Online) integration
 */
export class MpesaGateway extends BasePaymentGateway {
  readonly gatewayId = 'mpesa' as const;
  readonly gatewayName = 'M-Pesa';

  private accessToken: string = '';
  private tokenExpiry: number = 0;

  protected getBaseUrl(): string {
    return this.environment === 'production'
      ? 'https://api.safaricom.co.ke'
      : 'https://sandbox.safaricom.co.ke';
  }

  private get creds(): MpesaCredentials {
    return this.credentials as MpesaCredentials;
  }

  /**
   * Get OAuth access token
   */
  private async getAccessToken(): Promise<string> {
    // Return cached token if still valid
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const auth = Buffer.from(`${this.creds.consumerKey}:${this.creds.consumerSecret}`).toString('base64');

    const response = await fetch(`${this.getBaseUrl()}/oauth/v1/generate?grant_type=client_credentials`, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
      },
    });

    if (!response.ok) {
      throw new Error('Failed to get M-Pesa access token');
    }

    const data = await response.json();
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + (parseInt(data.expires_in) - 60) * 1000; // Refresh 1 min before expiry

    return this.accessToken;
  }

  /**
   * Generate password for STK Push
   */
  private generatePassword(timestamp: string): string {
    const str = `${this.creds.shortcode}${this.creds.passkey}${timestamp}`;
    return Buffer.from(str).toString('base64');
  }

  /**
   * Initiate STK Push payment
   */
  async initiatePayment(request: PaymentRequest): Promise<PaymentResponse> {
    this.ensureInitialized();

    const token = await this.getAccessToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = this.generatePassword(timestamp);

    // Format phone number (remove + and ensure 254 prefix)
    let phone = request.phoneNumber.replace(/\D/g, '');
    if (phone.startsWith('0')) {
      phone = '254' + phone.slice(1);
    } else if (phone.startsWith('254')) {
      // Already formatted
    } else if (phone.startsWith('+254')) {
      phone = phone.slice(1);
    }

    const payload = {
      BusinessShortCode: this.creds.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: toGatewayMajorUnits(request.amount),
      PartyA: phone,
      PartyB: this.creds.shortcode,
      PhoneNumber: phone,
      CallBackURL: this.creds.callbackUrl,
      AccountReference: request.accountReference,
      TransactionDesc: request.transactionDesc,
    };

    try {
      const response = await fetch(`${this.getBaseUrl()}/mpesa/stkpush/v1/processrequest`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (data.ResponseCode === '0') {
        return {
          success: true,
          checkoutRequestId: data.CheckoutRequestID,
          transactionId: data.MerchantRequestID,
          message: data.ResponseDescription || 'Payment initiated successfully',
          rawResponse: data,
        };
      } else {
        return {
          success: false,
          message: data.ResponseDescription || data.errorMessage || 'Payment initiation failed',
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
  async queryPaymentStatus(checkoutRequestId: string): Promise<PaymentStatusResponse> {
    this.ensureInitialized();

    const token = await this.getAccessToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = this.generatePassword(timestamp);

    const payload = {
      BusinessShortCode: this.creds.shortcode,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    };

    try {
      const response = await fetch(`${this.getBaseUrl()}/mpesa/stkpushquery/v1/query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      let status: 'pending' | 'completed' | 'failed' | 'cancelled' = 'pending';
      if (data.ResultCode === '0') {
        status = 'completed';
      } else if (data.ResultCode === '1032') {
        status = 'cancelled';
      } else if (data.ResultCode) {
        status = 'failed';
      }

      return {
        success: true,
        status,
        transactionId: checkoutRequestId,
        message: data.ResultDesc || data.ResponseDescription || 'Query successful',
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
   * Process M-Pesa callback
   */
  async processCallback(callbackData: any): Promise<PaymentCallbackData> {
    const body = callbackData.Body?.stkCallback;
    
    if (!body) {
      throw new Error('Invalid M-Pesa callback format');
    }

    const resultCode = body.ResultCode;
    const checkoutRequestId = body.CheckoutRequestID;
    const merchantRequestId = body.MerchantRequestID;

    let status: 'completed' | 'failed' | 'cancelled' = 'failed';
    if (resultCode === 0) {
      status = 'completed';
    } else if (resultCode === 1032) {
      status = 'cancelled';
    }

    // Extract callback metadata
    const metadata: Record<string, any> = {};
    if (body.CallbackMetadata?.Item) {
      body.CallbackMetadata.Item.forEach((item: any) => {
        metadata[item.Name] = item.Value;
      });
    }

    return {
      transactionId: metadata.MpesaReceiptNumber || merchantRequestId,
      checkoutRequestId,
      amount: metadata.Amount ? metadata.Amount * 100 : 0, // Convert to cents
      phoneNumber: metadata.PhoneNumber || '',
      status,
      resultCode: resultCode.toString(),
      resultDesc: body.ResultDesc,
      metadata,
    };
  }

  /**
   * Validate M-Pesa credentials
   */
  async validateCredentials(): Promise<{ valid: boolean; message: string }> {
    try {
      this.ensureInitialized();
      await this.getAccessToken();
      return {
        valid: true,
        message: 'M-Pesa credentials are valid',
      };
    } catch (error: any) {
      return {
        valid: false,
        message: error.message || 'Invalid M-Pesa credentials',
      };
    }
  }
}
