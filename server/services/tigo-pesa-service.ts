/**
 * Tigo Pesa API Integration Service
 * 
 * Handles payment initiation and status queries for Tigo Pesa
 * API Documentation: https://developer.tigo.com/
 */

import { randomBytes } from 'crypto';

export interface TigoPesaConfig {
  username: string;
  password: string;
  apiKey: string;
  apiUrl: string;
  billerCode: string;
  environment: 'sandbox' | 'production';
}

export interface TigoPaymentRequest {
  phoneNumber: string;
  amount: number; // in currency units
  accountReference: string;
  transactionDesc: string;
}

export interface TigoPaymentResponse {
  success: boolean;
  transactionId?: string;
  referenceId?: string;
  message?: string;
  error?: string;
}

export interface TigoStatusResponse {
  success: boolean;
  status?: 'pending' | 'completed' | 'failed';
  resultCode?: string;
  resultDesc?: string;
}

class TigoPesaService {
  private config: TigoPesaConfig;

  constructor() {
    this.config = {
      username: process.env.TIGO_USERNAME || '',
      password: process.env.TIGO_PASSWORD || '',
      apiKey: process.env.TIGO_API_KEY || '',
      apiUrl: process.env.TIGO_API_URL || 'https://secure.tigo.com/v1',
      billerCode: process.env.TIGO_BILLER_CODE || '',
      environment: (process.env.TIGO_ENVIRONMENT as 'sandbox' | 'production') || 'sandbox',
    };
  }

  /**
   * Get authentication header
   */
  private getAuthHeader(): string {
    const credentials = Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64');
    return `Basic ${credentials}`;
  }

  /**
   * Initiate payment request
   */
  async initiatePayment(request: TigoPaymentRequest): Promise<TigoPaymentResponse> {
    try {
      // Format phone number (remove country code if present)
      let phoneNumber = request.phoneNumber.replace(/\D/g, '');
      if (phoneNumber.startsWith('255')) {
        phoneNumber = phoneNumber.substring(3);
      }

      const referenceId = `TXN-${Date.now()}-${randomBytes(8).toString('hex')}`;

      const payload = {
        MasterMerchant: {
          account: this.config.billerCode,
          pin: this.config.password,
          id: this.config.username,
        },
        Subscriber: {
          account: phoneNumber,
          countryCode: '255',
          country: 'TZA',
          firstName: 'Customer',
          lastName: 'Name',
        },
        redirectUri: `${process.env.APP_URL}/api/webhooks/tigo`,
        callbackUri: `${process.env.APP_URL}/api/webhooks/tigo`,
        language: 'eng',
        terminalId: '001',
        originPayment: {
          amount: request.amount.toString(),
          currencyCode: 'TZS',
          tax: '0',
          fee: '0',
        },
        LocalPayment: {
          amount: request.amount.toString(),
          currencyCode: 'TZS',
        },
        transactionRefId: referenceId,
        exchangeRate: '1',
        remarks: request.transactionDesc,
      };

      const response = await fetch(`${this.config.apiUrl}/tigo/payment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': this.getAuthHeader(),
          'apikey': this.config.apiKey,
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (response.ok && data.status === 'success') {
        console.log('[Tigo Pesa] Payment initiated:', referenceId);
        
        return {
          success: true,
          transactionId: data.transactionId || referenceId,
          referenceId: referenceId,
          message: data.message || 'Payment initiated successfully',
        };
      } else {
        console.error('[Tigo Pesa] Payment initiation failed:', data);
        
        return {
          success: false,
          error: data.message || data.error || 'Payment initiation failed',
        };
      }
    } catch (error: any) {
      console.error('[Tigo Pesa] Payment initiation error:', error);
      return {
        success: false,
        error: error.message || 'Payment initiation failed',
      };
    }
  }

  /**
   * Query payment status
   */
  async queryPaymentStatus(transactionId: string): Promise<TigoStatusResponse> {
    try {
      const response = await fetch(
        `${this.config.apiUrl}/tigo/payment/status/${transactionId}`,
        {
          method: 'GET',
          headers: {
            'Authorization': this.getAuthHeader(),
            'apikey': this.config.apiKey,
          },
        }
      );

      const data = await response.json();

      if (response.ok) {
        const status = data.status?.toLowerCase();
        
        let mappedStatus: 'pending' | 'completed' | 'failed' = 'pending';
        if (status === 'success' || status === 'completed') {
          mappedStatus = 'completed';
        } else if (status === 'failed' || status === 'error') {
          mappedStatus = 'failed';
        }

        return {
          success: true,
          status: mappedStatus,
          resultCode: data.code,
          resultDesc: data.message,
        };
      } else {
        console.error('[Tigo Pesa] Status query failed:', data);
        
        return {
          success: false,
          resultDesc: data.message || 'Status query failed',
        };
      }
    } catch (error: any) {
      console.error('[Tigo Pesa] Status query error:', error);
      return {
        success: false,
        resultDesc: error.message || 'Status query failed',
      };
    }
  }

  /**
   * Validate configuration
   */
  validateConfig(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!this.config.username) {
      errors.push('TIGO_USERNAME is not configured');
    }
    if (!this.config.password) {
      errors.push('TIGO_PASSWORD is not configured');
    }
    if (!this.config.apiKey) {
      errors.push('TIGO_API_KEY is not configured');
    }
    if (!this.config.billerCode) {
      errors.push('TIGO_BILLER_CODE is not configured');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

// Singleton instance
export const tigoPesaService = new TigoPesaService();
