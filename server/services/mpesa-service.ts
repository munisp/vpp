/**
 * M-Pesa API Integration Service
 * 
 * Handles M-Pesa STK Push, payment verification, and OAuth token management
 */

import axios from 'axios';
import { getDb } from '../db';
import { paymentCredentials } from '../../drizzle/schema';
import { eq } from 'drizzle-orm';

interface MPesaCredentials {
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  passkey: string;
  apiUrl: string;
  callbackUrl: string;
}

interface MPesaTokenResponse {
  access_token: string;
  expires_in: string;
}

interface MPesaStkPushRequest {
  phoneNumber: string;
  amount: number;
  accountReference: string;
  transactionDesc: string;
}

interface MPesaStkPushResponse {
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResponseCode: string;
  ResponseDescription: string;
  CustomerMessage: string;
}

interface MPesaCallbackResponse {
  Body: {
    stkCallback: {
      MerchantRequestID: string;
      CheckoutRequestID: string;
      ResultCode: number;
      ResultDesc: string;
      CallbackMetadata?: {
        Item: Array<{
          Name: string;
          Value: any;
        }>;
      };
    };
  };
}

class MPesaService {
  private accessToken: string | null = null;
  private tokenExpiry: Date | null = null;

  /**
   * Get M-Pesa credentials from database
   */
  private async getCredentials(environment: 'sandbox' | 'production' = 'production'): Promise<MPesaCredentials> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const creds = await db
      .select()
      .from(paymentCredentials)
      .where(eq(paymentCredentials.gateway, 'mpesa'))
      .limit(1);

    if (!creds || creds.length === 0) {
      throw new Error('M-Pesa credentials not configured');
    }

    const cred = creds[0];
    
    // Decrypt credentials (assuming they're stored encrypted)
    // In production, you'd decrypt these values
    const credentials = JSON.parse(cred.credentials);

    return {
      consumerKey: credentials.consumerKey,
      consumerSecret: credentials.consumerSecret,
      shortcode: credentials.shortcode,
      passkey: credentials.passkey,
      apiUrl: credentials.apiUrl || (environment === 'sandbox' 
        ? 'https://sandbox.safaricom.co.ke' 
        : 'https://api.safaricom.co.ke'),
      callbackUrl: credentials.callbackUrl,
    };
  }

  /**
   * Generate OAuth access token
   */
  private async generateToken(credentials: MPesaCredentials): Promise<string> {
    // Check if we have a valid cached token
    if (this.accessToken && this.tokenExpiry && this.tokenExpiry > new Date()) {
      return this.accessToken;
    }

    try {
      const auth = Buffer.from(`${credentials.consumerKey}:${credentials.consumerSecret}`).toString('base64');
      
      const response = await axios.get<MPesaTokenResponse>(
        `${credentials.apiUrl}/oauth/v1/generate?grant_type=client_credentials`,
        {
          headers: {
            Authorization: `Basic ${auth}`,
          },
        }
      );

      this.accessToken = response.data.access_token;
      // Set expiry to 5 minutes before actual expiry for safety
      const expiresIn = parseInt(response.data.expires_in) - 300;
      this.tokenExpiry = new Date(Date.now() + expiresIn * 1000);

      console.log('[MPesa] OAuth token generated successfully');
      return this.accessToken;
    } catch (error: any) {
      console.error('[MPesa] Token generation failed:', error.response?.data || error.message);
      throw new Error('Failed to generate M-Pesa access token');
    }
  }

  /**
   * Generate password for STK Push
   */
  private generatePassword(shortcode: string, passkey: string, timestamp: string): string {
    const data = `${shortcode}${passkey}${timestamp}`;
    return Buffer.from(data).toString('base64');
  }

  /**
   * Get current timestamp in M-Pesa format (YYYYMMDDHHmmss)
   */
  private getTimestamp(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    
    return `${year}${month}${day}${hours}${minutes}${seconds}`;
  }

  /**
   * Format phone number to M-Pesa format (254XXXXXXXXX)
   */
  private formatPhoneNumber(phone: string): string {
    // Remove any spaces, dashes, or plus signs
    let formatted = phone.replace(/[\s\-+]/g, '');
    
    // If starts with 0, replace with 254
    if (formatted.startsWith('0')) {
      formatted = '254' + formatted.substring(1);
    }
    
    // If doesn't start with 254, add it
    if (!formatted.startsWith('254')) {
      formatted = '254' + formatted;
    }
    
    return formatted;
  }

  /**
   * Initiate STK Push payment
   */
  async initiatePayment(request: MPesaStkPushRequest): Promise<{
    success: boolean;
    merchantRequestId?: string;
    checkoutRequestId?: string;
    message?: string;
    error?: string;
  }> {
    try {
      const credentials = await this.getCredentials();
      const accessToken = await this.generateToken(credentials);
      const timestamp = this.getTimestamp();
      const password = this.generatePassword(credentials.shortcode, credentials.passkey, timestamp);
      const phoneNumber = this.formatPhoneNumber(request.phoneNumber);

      const payload = {
        BusinessShortCode: credentials.shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: Math.round(request.amount),
        PartyA: phoneNumber,
        PartyB: credentials.shortcode,
        PhoneNumber: phoneNumber,
        CallBackURL: credentials.callbackUrl,
        AccountReference: request.accountReference,
        TransactionDesc: request.transactionDesc,
      };

      console.log('[MPesa] Initiating STK Push:', {
        phone: phoneNumber,
        amount: request.amount,
        reference: request.accountReference,
      });

      const response = await axios.post<MPesaStkPushResponse>(
        `${credentials.apiUrl}/mpesa/stkpush/v1/processrequest`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (response.data.ResponseCode === '0') {
        console.log('[MPesa] STK Push initiated successfully:', response.data.CheckoutRequestID);
        return {
          success: true,
          merchantRequestId: response.data.MerchantRequestID,
          checkoutRequestId: response.data.CheckoutRequestID,
          message: response.data.CustomerMessage,
        };
      } else {
        console.error('[MPesa] STK Push failed:', response.data.ResponseDescription);
        return {
          success: false,
          error: response.data.ResponseDescription,
        };
      }
    } catch (error: any) {
      console.error('[MPesa] STK Push error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.errorMessage || error.message || 'Payment initiation failed',
      };
    }
  }

  /**
   * Query payment status
   */
  async queryPaymentStatus(checkoutRequestId: string): Promise<{
    success: boolean;
    resultCode?: number;
    resultDesc?: string;
    amount?: number;
    mpesaReceiptNumber?: string;
    transactionDate?: string;
    phoneNumber?: string;
    error?: string;
  }> {
    try {
      const credentials = await this.getCredentials();
      const accessToken = await this.generateToken(credentials);
      const timestamp = this.getTimestamp();
      const password = this.generatePassword(credentials.shortcode, credentials.passkey, timestamp);

      const payload = {
        BusinessShortCode: credentials.shortcode,
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestId,
      };

      const response = await axios.post(
        `${credentials.apiUrl}/mpesa/stkpushquery/v1/query`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      console.log('[MPesa] Payment query result:', response.data);

      return {
        success: response.data.ResultCode === '0',
        resultCode: parseInt(response.data.ResultCode),
        resultDesc: response.data.ResultDesc,
      };
    } catch (error: any) {
      console.error('[MPesa] Payment query error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.errorMessage || error.message || 'Payment query failed',
      };
    }
  }

  /**
   * Process M-Pesa callback
   */
  async processCallback(callbackData: MPesaCallbackResponse): Promise<{
    success: boolean;
    checkoutRequestId: string;
    merchantRequestId: string;
    resultCode: number;
    resultDesc: string;
    amount?: number;
    mpesaReceiptNumber?: string;
    transactionDate?: string;
    phoneNumber?: string;
  }> {
    const callback = callbackData.Body.stkCallback;
    
    const result: any = {
      success: callback.ResultCode === 0,
      checkoutRequestId: callback.CheckoutRequestID,
      merchantRequestId: callback.MerchantRequestID,
      resultCode: callback.ResultCode,
      resultDesc: callback.ResultDesc,
    };

    // Extract metadata if payment was successful
    if (callback.ResultCode === 0 && callback.CallbackMetadata) {
      const metadata = callback.CallbackMetadata.Item;
      
      metadata.forEach(item => {
        switch (item.Name) {
          case 'Amount':
            result.amount = item.Value;
            break;
          case 'MpesaReceiptNumber':
            result.mpesaReceiptNumber = item.Value;
            break;
          case 'TransactionDate':
            result.transactionDate = item.Value.toString();
            break;
          case 'PhoneNumber':
            result.phoneNumber = item.Value.toString();
            break;
        }
      });
    }

    console.log('[MPesa] Callback processed:', result);
    return result;
  }

  /**
   * Validate M-Pesa credentials
   */
  async validateCredentials(credentials: MPesaCredentials): Promise<{
    valid: boolean;
    error?: string;
  }> {
    try {
      const auth = Buffer.from(`${credentials.consumerKey}:${credentials.consumerSecret}`).toString('base64');
      
      await axios.get(
        `${credentials.apiUrl}/oauth/v1/generate?grant_type=client_credentials`,
        {
          headers: {
            Authorization: `Basic ${auth}`,
          },
          timeout: 10000,
        }
      );

      return { valid: true };
    } catch (error: any) {
      console.error('[MPesa] Credential validation failed:', error.response?.data || error.message);
      return {
        valid: false,
        error: error.response?.data?.error_description || error.message || 'Invalid credentials',
      };
    }
  }
}

// Singleton instance
export const mpesaService = new MPesaService();
