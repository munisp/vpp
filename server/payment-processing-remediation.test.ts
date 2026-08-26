import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AirtelMoneyGateway } from './payment-gateways/airtel';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe('Airtel production routing', () => {
  it('refuses production payment attempts without an explicitly configured non-UAT endpoint', async () => {
    delete process.env.AIRTEL_PRODUCTION_BASE_URL;
    const gateway = new AirtelMoneyGateway();
    await gateway.initialize(
      { clientId: 'id', clientSecret: 'secret', merchantCode: 'merchant', callbackUrl: 'https://callback.example' },
      'production'
    );

    await expect(
      gateway.initiatePayment({
        amount: 100,
        phoneNumber: '255700000000',
        accountReference: 'test',
        transactionDesc: 'test payment',
      })
    ).rejects.toThrow('AIRTEL_PRODUCTION_BASE_URL must be configured');
  });

  it('rejects an attempt to configure the UAT host as a production endpoint', async () => {
    process.env.AIRTEL_PRODUCTION_BASE_URL = 'https://openapiuat.airtel.africa';
    const gateway = new AirtelMoneyGateway();
    await gateway.initialize(
      { clientId: 'id', clientSecret: 'secret', merchantCode: 'merchant', callbackUrl: 'https://callback.example' },
      'production'
    );

    await expect(
      gateway.initiatePayment({
        amount: 100,
        phoneNumber: '255700000000',
        accountReference: 'test',
        transactionDesc: 'test payment',
      })
    ).rejects.toThrow('must not point to the Airtel UAT endpoint');
  });
});

describe('payment-processing durability', () => {
  it('persists a pending payment before provider initiation and retains ambiguous outcomes', () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, 'routers/paymentProcessing.ts'), 'utf8');
    const persistedAt = source.indexOf("await tx.insert(payments).values({");
    const providerCallAt = source.indexOf('PaymentGatewayManager.initiatePayment(');
    expect(persistedAt).toBeGreaterThan(-1);
    expect(providerCallAt).toBeGreaterThan(persistedAt);
    expect(source).toContain('pg_advisory_xact_lock(${inv.id})');
    expect(source).toContain("providerOutcome: 'unknown'");
    expect(source).toContain('reconciliationRequired: true');
  });
});
