/**
 * Payment Gateway Framework
 * 
 * Extensible framework for integrating multiple payment gateways.
 * Each gateway implements the IPaymentGateway interface.
 */

export interface PaymentRequest {
  amount: number; // Amount in cents
  phoneNumber: string;
  accountReference: string;
  transactionDesc: string;
  metadata?: Record<string, any>;
}

export interface PaymentResponse {
  success: boolean;
  transactionId?: string;
  checkoutRequestId?: string;
  message: string;
  rawResponse?: any;
}

export interface PaymentStatusResponse {
  success: boolean;
  status: 'pending' | 'completed' | 'failed' | 'cancelled';
  transactionId?: string;
  amount?: number; // Amount in cents
  phoneNumber?: string;
  completedAt?: Date;
  message: string;
  rawResponse?: any;
}

export interface PaymentCallbackData {
  transactionId: string;
  checkoutRequestId?: string;
  amount: number; // Amount in cents
  phoneNumber: string;
  status: 'completed' | 'failed' | 'cancelled';
  resultCode?: string;
  resultDesc?: string;
  metadata?: Record<string, any>;
}

/**
 * Base interface that all payment gateways must implement
 */
export interface IPaymentGateway {
  /**
   * Gateway identifier
   */
  readonly gatewayId: 'mpesa' | 'airtel_money' | 'tigo_pesa' | string;

  /**
   * Gateway display name
   */
  readonly gatewayName: string;

  /**
   * Initialize the gateway with credentials
   */
  initialize(credentials: Record<string, any>, environment: 'sandbox' | 'production'): Promise<void>;

  /**
   * Initiate a payment request
   */
  initiatePayment(request: PaymentRequest): Promise<PaymentResponse>;

  /**
   * Query payment status
   */
  queryPaymentStatus(transactionId: string): Promise<PaymentStatusResponse>;

  /**
   * Process callback/webhook from payment gateway
   */
  processCallback(callbackData: any): Promise<PaymentCallbackData>;

  /**
   * Validate credentials by making a test API call
   */
  validateCredentials(): Promise<{ valid: boolean; message: string }>;
}

/**
 * Base abstract class with common functionality
 */
export abstract class BasePaymentGateway implements IPaymentGateway {
  abstract readonly gatewayId: 'mpesa' | 'airtel_money' | 'tigo_pesa' | string;
  abstract readonly gatewayName: string;

  protected credentials: Record<string, any> = {};
  protected environment: 'sandbox' | 'production' = 'sandbox';
  protected initialized = false;

  async initialize(credentials: Record<string, any>, environment: 'sandbox' | 'production'): Promise<void> {
    this.credentials = credentials;
    this.environment = environment;
    this.initialized = true;
  }

  protected ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(`${this.gatewayName} gateway not initialized`);
    }
  }

  protected getBaseUrl(): string {
    // Override in subclasses
    return '';
  }

  protected async makeRequest(
    method: 'GET' | 'POST' | 'PUT',
    endpoint: string,
    data?: any,
    headers?: Record<string, string>
  ): Promise<any> {
    const url = `${this.getBaseUrl()}${endpoint}`;

    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: data ? JSON.stringify(data) : undefined,
    });

    const responseData = await response.json();

    if (!response.ok) {
      throw new Error(`API request failed: ${responseData.message || response.statusText}`);
    }

    return responseData;
  }

  abstract initiatePayment(request: PaymentRequest): Promise<PaymentResponse>;
  abstract queryPaymentStatus(transactionId: string): Promise<PaymentStatusResponse>;
  abstract processCallback(callbackData: any): Promise<PaymentCallbackData>;
  abstract validateCredentials(): Promise<{ valid: boolean; message: string }>;
}

/**
 * Payment Gateway Factory
 * Creates and manages payment gateway instances
 */
export class PaymentGatewayFactory {
  private static gateways: Map<string, new () => IPaymentGateway> = new Map();

  /**
   * Register a payment gateway implementation
   */
  static register(gatewayId: string, gatewayClass: new () => IPaymentGateway): void {
    this.gateways.set(gatewayId, gatewayClass);
  }

  /**
   * Create a gateway instance
   */
  static create(gatewayId: string): IPaymentGateway {
    const GatewayClass = this.gateways.get(gatewayId);
    if (!GatewayClass) {
      throw new Error(`Payment gateway '${gatewayId}' not registered`);
    }
    return new GatewayClass();
  }

  /**
   * Get all registered gateway IDs
   */
  static getRegisteredGateways(): string[] {
    return Array.from(this.gateways.keys());
  }
}
