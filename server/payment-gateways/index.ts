/**
 * Payment Gateway Manager
 * 
 * Central manager for all payment gateway operations.
 * Handles gateway initialization, payment processing, and callbacks.
 */

import { IPaymentGateway, PaymentGatewayFactory, PaymentRequest, PaymentResponse, PaymentStatusResponse, PaymentCallbackData } from './base';
import { MpesaGateway } from './mpesa';
import { AirtelMoneyGateway } from './airtel';
import { TigoPesaGateway } from './tigo';
import * as credDb from '../payment-credentials-db';

// Register all payment gateways
PaymentGatewayFactory.register('mpesa', MpesaGateway);
PaymentGatewayFactory.register('airtel_money', AirtelMoneyGateway);
PaymentGatewayFactory.register('tigo_pesa', TigoPesaGateway);

/**
 * Payment Gateway Manager
 */
export class PaymentGatewayManager {
  private static gateways: Map<string, IPaymentGateway> = new Map();

  /**
   * Get or create a gateway instance
   */
  private static async getGateway(
    gatewayId: 'mpesa' | 'airtel_money' | 'tigo_pesa',
    environment: 'sandbox' | 'production'
  ): Promise<IPaymentGateway> {
    const key = `${gatewayId}_${environment}`;

    // Return cached instance if available
    if (this.gateways.has(key)) {
      return this.gateways.get(key)!;
    }

    // Get credentials from database
    const credentials = await credDb.getPaymentCredentials(gatewayId, environment);
    
    if (!credentials) {
      throw new Error(`No ${environment} credentials found for ${gatewayId}`);
    }

    if (credentials.isActive !== 'true') {
      throw new Error(`${gatewayId} gateway is not active`);
    }

    // Create and initialize gateway
    const gateway = PaymentGatewayFactory.create(gatewayId);
    await gateway.initialize(credentials.credentials, environment);

    // Cache the instance
    this.gateways.set(key, gateway);

    return gateway;
  }

  /**
   * Initiate a payment
   */
  static async initiatePayment(
    gatewayId: 'mpesa' | 'airtel_money' | 'tigo_pesa',
    request: PaymentRequest,
    environment: 'sandbox' | 'production' = 'sandbox'
  ): Promise<PaymentResponse> {
    const gateway = await this.getGateway(gatewayId, environment);
    
    // Log the request
    await credDb.logPaymentGatewayRequest({
      paymentId: 0,
      gateway: gatewayId,
      requestType: 'INITIATE_PAYMENT',
      requestPayload: request,
      status: 'pending',
    });

    try {
      const response = await gateway.initiatePayment(request);

      // Log the response
      await credDb.logPaymentGatewayRequest({
        paymentId: 0,
        gateway: gatewayId,
        requestType: 'INITIATE_PAYMENT',
        requestPayload: request,
        responsePayload: response,
        status: response.success ? 'success' : 'failed',
        errorMessage: response.success ? undefined : response.message,
      });

      return response;
    } catch (error: any) {
      // Log the error
      await credDb.logPaymentGatewayRequest({
        paymentId: 0,
        gateway: gatewayId,
        requestType: 'INITIATE_PAYMENT',
        requestPayload: request,
        status: 'failed',
        errorMessage: error.message,
      });

      throw error;
    }
  }

  /**
   * Query payment status
   */
  static async queryPaymentStatus(
    gatewayId: 'mpesa' | 'airtel_money' | 'tigo_pesa',
    transactionId: string,
    environment: 'sandbox' | 'production' = 'sandbox'
  ): Promise<PaymentStatusResponse> {
    const gateway = await this.getGateway(gatewayId, environment);
    
    try {
      const response = await gateway.queryPaymentStatus(transactionId);

      // Log the query
      await credDb.logPaymentGatewayRequest({
        paymentId: 0,
        gateway: gatewayId,
        requestType: 'QUERY_STATUS',
        requestPayload: { transactionId },
        responsePayload: response,
        status: response.success ? 'success' : 'failed',
      });

      return response;
    } catch (error: any) {
      await credDb.logPaymentGatewayRequest({
        paymentId: 0,
        gateway: gatewayId,
        requestType: 'QUERY_STATUS',
        requestPayload: { transactionId },
        status: 'failed',
        errorMessage: error.message,
      });

      throw error;
    }
  }

  /**
   * Process payment callback
   */
  static async processCallback(
    gatewayId: 'mpesa' | 'airtel_money' | 'tigo_pesa',
    callbackData: any,
    environment: 'sandbox' | 'production' = 'sandbox'
  ): Promise<PaymentCallbackData> {
    const gateway = await this.getGateway(gatewayId, environment);
    
    try {
      const result = await gateway.processCallback(callbackData);

      // Log the callback
      await credDb.logPaymentGatewayRequest({
        paymentId: 0,
        gateway: gatewayId,
        requestType: 'CALLBACK',
        requestPayload: callbackData,
        responsePayload: result,
        status: result.status === 'completed' ? 'success' : 'failed',
      });

      return result;
    } catch (error: any) {
      await credDb.logPaymentGatewayRequest({
        paymentId: 0,
        gateway: gatewayId,
        requestType: 'CALLBACK',
        requestPayload: callbackData,
        status: 'failed',
        errorMessage: error.message,
      });

      throw error;
    }
  }

  /**
   * Validate gateway credentials
   */
  static async validateCredentials(
    gatewayId: 'mpesa' | 'airtel_money' | 'tigo_pesa',
    environment: 'sandbox' | 'production' = 'sandbox'
  ): Promise<{ valid: boolean; message: string }> {
    try {
      const gateway = await this.getGateway(gatewayId, environment);
      return await gateway.validateCredentials();
    } catch (error: any) {
      return {
        valid: false,
        message: error.message || 'Validation failed',
      };
    }
  }

  /**
   * Process a refund for a payment
   */
  static async processRefund(
    gatewayId: 'mpesa' | 'airtel_money' | 'tigo_pesa',
    paymentId: number,
    transactionId: string,
    amount: number,
    reason: string,
    environment: 'sandbox' | 'production' = 'sandbox'
  ): Promise<{ success: boolean; refundId?: string; error?: string }> {
    const refundId = `REF-${paymentId}-${Date.now()}`;

    try {
      // Log the refund request
      await credDb.logPaymentGatewayRequest({
        paymentId,
        gateway: gatewayId,
        requestType: 'REFUND',
        requestPayload: { transactionId, amount, reason },
        status: 'pending',
      });

      // Note: Mobile money refunds typically require B2C/disbursement APIs
      // which need separate credentials and approval workflows.
      // For now, we mark for manual processing and log the request.
      console.log(`[PaymentGateway] ${gatewayId} refund requires disbursement API - marking for manual processing`);

      // Log successful refund initiation
      await credDb.logPaymentGatewayRequest({
        paymentId,
        gateway: gatewayId,
        requestType: 'REFUND',
        requestPayload: { transactionId, amount, reason },
        responsePayload: { refundId, status: 'pending_manual_processing' },
        status: 'success',
      });

      return { success: true, refundId };
    } catch (error: any) {
      await credDb.logPaymentGatewayRequest({
        paymentId,
        gateway: gatewayId,
        requestType: 'REFUND',
        requestPayload: { transactionId, amount, reason },
        status: 'failed',
        errorMessage: error.message,
      });

      return { success: false, error: error.message };
    }
  }

  /**
   * Clear cached gateway instances (useful after credential updates)
   */
  static clearCache(): void {
    this.gateways.clear();
  }

  /**
   * Get list of supported gateways
   */
  static getSupportedGateways(): string[] {
    return PaymentGatewayFactory.getRegisteredGateways();
  }
}

// Export gateway classes for direct use if needed
export { MpesaGateway, AirtelMoneyGateway, TigoPesaGateway };
export * from './base';
