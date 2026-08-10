import {
  BasePaymentGateway,
  PaymentRequest,
  PaymentResponse,
  PaymentStatusResponse,
  PaymentCallbackData,
} from './base';

interface TigoCredentials {
  apiKey: string;
  apiSecret: string;
  merchantNumber: string;
  callbackUrl: string;
}

/**
 * Tigo Pesa Payment Gateway Implementation
 */
export class TigoPesaGateway extends BasePaymentGateway {
  readonly gatewayId = 'tigo_pesa' as const;
  readonly gatewayName = 'Tigo Pesa';

  protected getBaseUrl(): string {
    return this.environment === 'production'
      ? 'https://api.tigo.co.tz' // Replace with actual production URL
      : 'https://sandbox.tigo.co.tz'; // Replace with actual sandbox URL
  }

  private get creds(): TigoCredentials {
    return this.credentials as TigoCredentials;
  }

  /**
   * Generate authorization header
   */
  private getAuthHeader(): string {
    const auth = `${this.creds.apiKey}:${this.creds.apiSecret}`;
    return `Basic ${Buffer.from(auth).toString('base64')}`;
  }

  /**
   * Initiate Tigo Pesa payment
   */
  async initiatePayment(request: PaymentRequest): Promise<PaymentResponse> {
    this.ensureInitialized();

    // Format phone number
    let phone = request.phoneNumber.replace(/\D/g, '');
    if (phone.startsWith('0')) {
      phone = '255' + phone.slice(1);
    }

    const transactionId = `TGO${Date.now()}${Math.random().toString(36).substring(7)}`;

    const payload = {
      MerchantNumber: this.creds.merchantNumber,
      CustomerMSISDN: phone,
      Amount: Math.round(request.amount / 100), // Convert cents to shillings
      TransactionRefNumber: transactionId,
      Remarks: request.transactionDesc,
      CallBackUrl: this.creds.callbackUrl,
    };

    try {
      const response = await fetch(`${this.getBaseUrl()}/v1/tigo/payment/request`, {
        method: 'POST',
        headers: {
          'Authorization': this.getAuthHeader(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (data.ResponseCode === '0' || data.ResponseCode === '200') {
        return {
          success: true,
          transactionId: data.TransactionID || transactionId,
          message: data.ResponseDescription || 'Payment initiated successfully',
          rawResponse: data,
        };
      } else {
        return {
          success: false,
          message: data.ResponseDescription || 'Payment initiation failed',
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

    try {
      const response = await fetch(
        `${this.getBaseUrl()}/v1/tigo/payment/status?TransactionID=${transactionId}`,
        {
          method: 'GET',
          headers: {
            'Authorization': this.getAuthHeader(),
            'Content-Type': 'application/json',
          },
        }
      );

      const data = await response.json();

      let status: 'pending' | 'completed' | 'failed' | 'cancelled' = 'pending';
      
      if (data.Status === 'COMPLETED' || data.Status === 'SUCCESS') {
        status = 'completed';
      } else if (data.Status === 'FAILED') {
        status = 'failed';
      } else if (data.Status === 'CANCELLED') {
        status = 'cancelled';
      }

      return {
        success: true,
        status,
        transactionId,
        amount: data.Amount ? data.Amount * 100 : undefined,
        phoneNumber: data.CustomerMSISDN,
        message: data.ResponseDescription || 'Query successful',
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
   * Process Tigo Pesa callback
   */
  async processCallback(callbackData: any): Promise<PaymentCallbackData> {
    if (!callbackData.TransactionID) {
      throw new Error('Invalid Tigo Pesa callback format');
    }

    let status: 'completed' | 'failed' | 'cancelled' = 'failed';
    if (callbackData.Status === 'COMPLETED' || callbackData.Status === 'SUCCESS') {
      status = 'completed';
    } else if (callbackData.Status === 'CANCELLED') {
      status = 'cancelled';
    }

    return {
      transactionId: callbackData.TransactionID,
      amount: callbackData.Amount ? callbackData.Amount * 100 : 0,
      phoneNumber: callbackData.CustomerMSISDN || '',
      status,
      resultCode: callbackData.ResponseCode,
      resultDesc: callbackData.ResponseDescription,
      metadata: callbackData,
    };
  }

  /**
   * Validate Tigo Pesa credentials
   */
  async validateCredentials(): Promise<{ valid: boolean; message: string }> {
    try {
      this.ensureInitialized();
      
      // Try to make a simple API call to validate credentials
      const response = await fetch(`${this.getBaseUrl()}/v1/tigo/health`, {
        method: 'GET',
        headers: {
          'Authorization': this.getAuthHeader(),
        },
      });

      if (response.ok) {
        return {
          valid: true,
          message: 'Tigo Pesa credentials are valid',
        };
      } else {
        return {
          valid: false,
          message: 'Invalid Tigo Pesa credentials',
        };
      }
    } catch (error: any) {
      return {
        valid: false,
        message: error.message || 'Invalid Tigo Pesa credentials',
      };
    }
  }
}
