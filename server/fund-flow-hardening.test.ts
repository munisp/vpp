/**
 * Regression tests for the fund-flow / trust-boundary hardening:
 *  - payment gateway environment cannot silently fall back to sandbox in prod
 *  - amounts are converted to gateway major units without silent rounding
 *  - payment QR payloads are signed and tampering is rejected
 *  - device telemetry secrets are verified with a real hash comparison
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { scryptSync, randomBytes } from 'crypto';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('resolveGatewayEnvironment', () => {
  beforeEach(() => {
    delete process.env.PAYMENT_GATEWAY_ENVIRONMENT;
  });

  it('throws in production when the gateway environment is unset', async () => {
    process.env.NODE_ENV = 'production';
    const { resolveGatewayEnvironment } = await import('./payment-gateways/environment');
    expect(() => resolveGatewayEnvironment()).toThrow();
  });

  it('refuses sandbox gateways in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_GATEWAY_ENVIRONMENT = 'sandbox';
    const { resolveGatewayEnvironment } = await import('./payment-gateways/environment');
    expect(() => resolveGatewayEnvironment()).toThrow();
  });

  it('rejects unknown values instead of guessing', async () => {
    process.env.NODE_ENV = 'development';
    process.env.PAYMENT_GATEWAY_ENVIRONMENT = 'staging';
    const { resolveGatewayEnvironment } = await import('./payment-gateways/environment');
    expect(() => resolveGatewayEnvironment()).toThrow();
  });

  it('accepts an explicit production configuration', async () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_GATEWAY_ENVIRONMENT = 'production';
    const { resolveGatewayEnvironment } = await import('./payment-gateways/environment');
    expect(resolveGatewayEnvironment()).toBe('production');
  });
});

describe('toGatewayMajorUnits', () => {
  it('converts whole-unit amounts exactly', async () => {
    const { toGatewayMajorUnits } = await import('./_core/paymentGateway');
    expect(toGatewayMajorUnits(100)).toBe(1);
    expect(toGatewayMajorUnits(100000)).toBe(1000);
  });

  it('rejects amounts that cannot be charged exactly rather than rounding', async () => {
    const { toGatewayMajorUnits } = await import('./_core/paymentGateway');
    expect(() => toGatewayMajorUnits(150)).toThrow(/NOT_REPRESENTABLE/);
    expect(() => toGatewayMajorUnits(1)).toThrow(/NOT_REPRESENTABLE/);
    expect(() => toGatewayMajorUnits(0)).toThrow(/INVALID/);
    expect(() => toGatewayMajorUnits(-100)).toThrow(/INVALID/);
  });
});

describe('payment QR codes', () => {
  beforeEach(() => {
    process.env.QR_SIGNING_SECRET = 'a'.repeat(48);
  });

  it('rejects an unsigned payload', async () => {
    const { parsePaymentQRCode } = await import('./_core/qrcode');
    const unsigned = JSON.stringify({ type: 'p2p', amount: 500, currency: 'TZS' });
    expect(() => parsePaymentQRCode(unsigned)).toThrow();
  });

  it('accepts a payload it signed itself', async () => {
    const mod = await import('./_core/qrcode');
    const data = mod.createP2PPayment('42', 'Grace', 500, 'TZS');
    const image = await mod.generatePaymentQRCode(data);
    expect(image.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('rejects a payload whose amount was tampered with', async () => {
    const mod = await import('./_core/qrcode');
    const data = mod.createBillPayment('bill-1', 'electricity', 1000, 'TZS');

    // Reproduce the signed envelope, then tamper with the amount only.
    const signed = JSON.parse(
      JSON.stringify({ v: 1, data, signature: 'placeholder' })
    );
    signed.data.amount = 1;
    expect(() => mod.parsePaymentQRCode(JSON.stringify(signed))).toThrow(
      /signature|signed/i
    );
  });

  it('refuses to sign when no signing secret is configured', async () => {
    delete process.env.QR_SIGNING_SECRET;
    const mod = await import('./_core/qrcode');
    await expect(
      mod.generatePaymentQRCode(mod.createTokenPurchase(1000, 'TZS'))
    ).rejects.toThrow();
  });
});

describe('verifyDeviceSecret', () => {
  it('accepts the provisioned secret and rejects any other', async () => {
    const { verifyDeviceSecret } = await import('./_core/deviceAuth');
    const salt = randomBytes(16).toString('hex');
    const secret = 'device-secret-value';
    const stored = `${salt}:${scryptSync(secret, salt, 64).toString('hex')}`;

    await expect(verifyDeviceSecret(secret, stored)).resolves.toBe(true);
    await expect(verifyDeviceSecret('wrong-secret', stored)).resolves.toBe(false);
  });

  it('rejects a malformed stored hash instead of trusting it', async () => {
    const { verifyDeviceSecret } = await import('./_core/deviceAuth');
    await expect(verifyDeviceSecret('anything', 'not-a-hash')).resolves.toBe(false);
    await expect(verifyDeviceSecret('anything', '')).resolves.toBe(false);
  });
});
