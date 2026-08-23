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
import { observing, type Observation } from '../services/degraded-operation';

// Register all payment gateways
PaymentGatewayFactory.register('mpesa', MpesaGateway);
PaymentGatewayFactory.register('airtel_money', AirtelMoneyGateway);
PaymentGatewayFactory.register('tigo_pesa', TigoPesaGateway);

/**
 * These gateways report a refusal in the response rather than by throwing, so a
 * returned `success: false` is a reachable-but-not-working provider — recorded as
 * one faulted call, which is what lets a run of refusals open an outage.
 */
function observeResponse(response: { success: boolean }): Observation {
  return response.success ? 'reachable' : 'faulted';
}

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
   * Whether this gateway can be asked for money at all: credentials are stored
   * for the environment and marked active. Callers resolve this before they
   * reserve anything, so a configuration gap is refused as a precondition
   * instead of surfacing as a failed charge.
   */
  static async isConfigured(
    gatewayId: 'mpesa' | 'airtel_money' | 'tigo_pesa',
    environment: 'sandbox' | 'production' = 'sandbox'
  ): Promise<{ configured: boolean; reason?: string }> {
    if (this.gateways.has(`${gatewayId}_${environment}`)) return { configured: true };
    const credentials = await credDb.getPaymentCredentials(gatewayId, environment);
    if (!credentials) {
      return { configured: false, reason: `No ${environment} credentials are stored for ${gatewayId}.` };
    }
    if (credentials.isActive !== 'true') {
      return { configured: false, reason: `The ${gatewayId} ${environment} gateway is stored but not active.` };
    }
    return { configured: true };
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
      // Observed here rather than inside each gateway: this is the one place every
      // provider's outbound call passes through, so posture reflects real money
      // traffic instead of a prober the provider answers while payments fail.
      const response = await observing(
        {
          dependency: 'payment_gateway',
          observedBy: 'server',
          operation: `${gatewayId} initiate payment`,
          resultObservation: observeResponse,
        },
        () => gateway.initiatePayment(request)
      );

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
      const response = await observing(
        {
          dependency: 'payment_gateway',
          observedBy: 'server',
          operation: `${gatewayId} query status`,
          resultObservation: observeResponse,
        },
        () => gateway.queryPaymentStatus(transactionId)
      );

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

      // Mobile money refunds require the provider's B2C/disbursement API,
      // which needs separate credentials and an approval workflow that is not
      // integrated here. No money moves, so this is reported as a failed
      // refund needing manual disbursement — never as a successful one.
      console.error(
        `[PaymentGateway] ${gatewayId} refund for payment ${paymentId} requires the disbursement API; queued for manual processing, funds NOT returned`
      );

      await credDb.logPaymentGatewayRequest({
        paymentId,
        gateway: gatewayId,
        requestType: 'REFUND',
        requestPayload: { transactionId, amount, reason },
        responsePayload: { refundId, status: 'manual_disbursement_required', environment },
        status: 'failed',
        errorMessage: 'refund_requires_manual_disbursement',
      });

      return {
        success: false,
        refundId,
        error: `${gatewayId} refunds require manual disbursement: no automated reversal API is integrated, so payment ${paymentId} has NOT been refunded.`,
      };
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
