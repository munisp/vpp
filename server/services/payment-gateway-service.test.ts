/**
 * Payment Gateway Service Tests
 * 
 * Basic test suite for payment gateway functionality
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the database
vi.mock('../db', () => ({
  getDb: vi.fn(() => Promise.resolve({
    insert: vi.fn(() => ({
      values: vi.fn(() => Promise.resolve([{ insertId: 1 }])),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{
            id: 1,
            userId: 1,
            amount: 10000,
            currency: 'TZS',
            status: 'completed',
            paymentMethod: 'mpesa',
            transactionId: 'TEST123',
            metadata: '{}',
          }])),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    })),
  })),
}));

// Mock payment services
vi.mock('./mpesa-service', () => ({
  mpesaService: {
    initiatePayment: vi.fn(() => Promise.resolve({
      success: true,
      checkoutRequestId: 'CHECKOUT123',
      merchantRequestId: 'MERCHANT123',
      message: 'Success',
    })),
    queryPaymentStatus: vi.fn(() => Promise.resolve({
      success: true,
      resultCode: 0,
      resultDesc: 'Success',
    })),
  },
}));

vi.mock('./airtel-money-service', () => ({
  airtelMoneyService: {
    initiatePayment: vi.fn(() => Promise.resolve({
      success: true,
      transactionId: 'AIRTEL123',
      referenceId: 'REF123',
      message: 'Success',
    })),
    queryPaymentStatus: vi.fn(() => Promise.resolve({
      success: true,
      status: 'completed',
    })),
  },
}));

vi.mock('./tigo-pesa-service', () => ({
  tigoPesaService: {
    initiatePayment: vi.fn(() => Promise.resolve({
      success: true,
      transactionId: 'TIGO123',
      referenceId: 'REF123',
      message: 'Success',
    })),
    queryPaymentStatus: vi.fn(() => Promise.resolve({
      success: true,
      status: 'completed',
    })),
  },
}));

describe('PaymentGatewayService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initiatePayment', () => {
    it('should initiate M-Pesa payment successfully', async () => {
      const { paymentGatewayService } = await import('./payment-gateway-service');
      
      const result = await paymentGatewayService.initiatePayment({
        gateway: 'mpesa',
        phoneNumber: '254712345678',
        amount: 10000,
        currency: 'TZS',
        accountReference: 'TEST001',
        transactionDesc: 'Test payment',
        userId: 1,
        paymentType: 'invoice',
      });

      expect(result.success).toBe(true);
      expect(result.paymentId).toBeDefined();
      expect(result.checkoutRequestId).toBe('CHECKOUT123');
    });

    it('should initiate Airtel Money payment successfully', async () => {
      const { paymentGatewayService } = await import('./payment-gateway-service');
      
      const result = await paymentGatewayService.initiatePayment({
        gateway: 'airtel_money',
        phoneNumber: '255712345678',
        amount: 10000,
        currency: 'TZS',
        accountReference: 'TEST001',
        transactionDesc: 'Test payment',
        userId: 1,
        paymentType: 'invoice',
      });

      expect(result.success).toBe(true);
      expect(result.paymentId).toBeDefined();
      expect(result.transactionId).toBe('AIRTEL123');
    });
  });

  describe('queryPaymentStatus', () => {
    it('should return payment status', async () => {
      const { paymentGatewayService } = await import('./payment-gateway-service');
      
      const result = await paymentGatewayService.queryPaymentStatus(1);

      expect(result.success).toBe(true);
      expect(result.status).toBe('completed');
      expect(result.amount).toBe(10000);
    });
  });

  describe('processRefund', () => {
    it('should refuse an unconfirmable M-Pesa refund and flag manual review', async () => {
      const { paymentGatewayService } = await import('./payment-gateway-service');

      // The mocked payment has no mpesaReceiptNumber in its metadata, so the
      // gateway cannot confirm a reversal: the refund must fail honestly and
      // be flagged for manual review — never reported as refunded.
      const result = await paymentGatewayService.processRefund(1, 'Customer request');

      expect(result.success).toBe(false);
      expect(result.error).toContain('refund_not_supported');
      expect(result.refundId).toBeDefined();
      expect(result.refundId).toMatch(/^REF-1-/);
    });
  });

  describe('getPaymentStats', () => {
    it('should return payment statistics', async () => {
      const { paymentGatewayService } = await import('./payment-gateway-service');
      
      const result = await paymentGatewayService.getPaymentStats(1);

      expect(result).toHaveProperty('total');
      expect(result).toHaveProperty('completed');
      expect(result).toHaveProperty('pending');
      expect(result).toHaveProperty('failed');
      expect(result).toHaveProperty('totalAmount');
    });
  });
});
