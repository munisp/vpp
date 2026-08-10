/**
 * Airtel Money API Integration Service
 * 
 * Handles payment initiation and status queries for Airtel Money
 * API Documentation: https://developers.airtel.africa/documentation
 */

export interface AirtelMoneyConfig {
  clientId: string;
  clientSecret: string;
  apiUrl: string;
  environment: 'sandbox' | 'production';
}

export interface AirtelPaymentRequest {
  phoneNumber: string;
  amount: number; // in currency units
  accountReference: string;
  transactionDesc: string;
}

export interface AirtelPaymentResponse {
  success: boolean;
  transactionId?: string;
  referenceId?: string;
  message?: string;
  error?: string;
}

export interface AirtelStatusResponse {
  success: boolean;
  status?: 'pending' | 'completed' | 'failed';
  resultCode?: number;
  resultDesc?: string;
}

class AirtelMoneyService {
  private config: AirtelMoneyConfig;
  private accessToken: string | null = null;
  private tokenExpiry: Date | null = null;

  constructor() {
    this.config = {
      clientId: process.env.AIRTEL_CLIENT_ID || '',
      clientSecret: process.env.AIRTEL_CLIENT_SECRET || '',
      apiUrl: process.env.AIRTEL_API_URL || 'https://openapiuat.airtel.africa',
      environment: (process.env.AIRTEL_ENVIRONMENT as 'sandbox' | 'production') || 'sandbox',
    };
  }

  /**
   * Get OAuth access token
   */
  private async getAccessToken(): Promise<string> {
    // Check if token is still valid
    if (this.accessToken && this.tokenExpiry && this.tokenExpiry > new Date()) {
      return this.accessToken;
    }

    try {
      const response = await fetch(`${this.config.apiUrl}/auth/oauth2/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          grant_type: 'client_credentials',
        }),
      });

      if (!response.ok) {
        throw new Error(`Token request failed: ${response.statusText}`);
      }

      const data = await response.json();
      
      if (!data.access_token) {
        throw new Error('No access token in response');
      }
      
      this.accessToken = data.access_token;
      // Set expiry to 5 minutes before actual expiry for safety
      const expiresIn = (data.expires_in || 3600) - 300;
      this.tokenExpiry = new Date(Date.now() + expiresIn * 1000);

      console.log('[Airtel Money] Access token obtained');
      return this.accessToken as string;
    } catch (error: any) {
      console.error('[Airtel Money] Token generation error:', error);
      throw new Error(`Failed to get Airtel Money access token: ${error.message}`);
    }
  }

  /**
   * Initiate payment request
   */
  async initiatePayment(request: AirtelPaymentRequest): Promise<AirtelPaymentResponse> {
    try {
      const token = await this.getAccessToken();

      // Format phone number (remove country code if present)
      let phoneNumber = request.phoneNumber.replace(/\D/g, '');
      if (phoneNumber.startsWith('255')) {
        phoneNumber = phoneNumber.substring(3);
      }

      const payload = {
        reference: request.accountReference,
        subscriber: {
          country: 'TZ', // Tanzania
          currency: 'TZS',
          msisdn: phoneNumber,
        },
        transaction: {
          amount: request.amount,
          country: 'TZ',
          currency: 'TZS',
          id: `TXN-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        },
      };

      const response = await fetch(`${this.config.apiUrl}/merchant/v1/payments/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-Country': 'TZ',
          'X-Currency': 'TZS',
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (response.ok && data.status?.code === '200') {
        console.log('[Airtel Money] Payment initiated:', data.data?.transaction?.id);
        
        return {
          success: true,
          transactionId: data.data?.transaction?.id,
          referenceId: data.data?.transaction?.reference,
          message: data.status?.message || 'Payment initiated successfully',
        };
      } else {
        console.error('[Airtel Money] Payment initiation failed:', data);
        
        return {
          success: false,
          error: data.status?.message || 'Payment initiation failed',
        };
      }
    } catch (error: any) {
      console.error('[Airtel Money] Payment initiation error:', error);
      return {
        success: false,
        error: error.message || 'Payment initiation failed',
      };
    }
  }

  /**
   * Query payment status
   */
  async queryPaymentStatus(transactionId: string): Promise<AirtelStatusResponse> {
    try {
      const token = await this.getAccessToken();

      const response = await fetch(
        `${this.config.apiUrl}/standard/v1/payments/${transactionId}`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-Country': 'TZ',
            'X-Currency': 'TZS',
          },
        }
      );

      const data = await response.json();

      if (response.ok) {
        const status = data.data?.transaction?.status?.toLowerCase();
        
        let mappedStatus: 'pending' | 'completed' | 'failed' = 'pending';
        if (status === 'ts' || status === 'success') {
          mappedStatus = 'completed';
        } else if (status === 'tf' || status === 'failed') {
          mappedStatus = 'failed';
        }

        return {
          success: true,
          status: mappedStatus,
          resultCode: data.status?.code,
          resultDesc: data.status?.message,
        };
      } else {
        console.error('[Airtel Money] Status query failed:', data);
        
        return {
          success: false,
          resultDesc: data.status?.message || 'Status query failed',
        };
      }
    } catch (error: any) {
      console.error('[Airtel Money] Status query error:', error);
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

    if (!this.config.clientId) {
      errors.push('AIRTEL_CLIENT_ID is not configured');
    }
    if (!this.config.clientSecret) {
      errors.push('AIRTEL_CLIENT_SECRET is not configured');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

// Singleton instance
export const airtelMoneyService = new AirtelMoneyService();
