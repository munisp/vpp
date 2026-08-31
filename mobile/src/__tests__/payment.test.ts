/**
 * Pure-logic tests for the payment form rules extracted from PaymentsScreen
 * (src/utils/payment.ts) and for the shared Wh->kWh label the prepaid
 * innovation screens render.
 */

import { formatCentsTzs, validatePaymentForm } from '../utils/payment';
import { kwhLabel } from '../../../shared/prepaid-state';

describe('validatePaymentForm', () => {
  it('rejects a missing phone number', () => {
    const result = validatePaymentForm({
      phoneNumber: '',
      amount: '1000',
      paymentType: 'invoice',
      energyKwh: '',
    });
    expect(result).toEqual({
      ok: false,
      reason: 'missing_fields',
      message: 'Please enter phone number and amount',
    });
  });

  it('rejects a missing amount', () => {
    const result = validatePaymentForm({
      phoneNumber: '0712345678',
      amount: '',
      paymentType: 'invoice',
      energyKwh: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_fields');
  });

  it.each(['abc', '0', '-500'])('rejects invalid amount %p', (amount) => {
    const result = validatePaymentForm({
      phoneNumber: '0712345678',
      amount,
      paymentType: 'invoice',
      energyKwh: '',
    });
    expect(result).toEqual({
      ok: false,
      reason: 'invalid_amount',
      message: 'Please enter a valid amount',
    });
  });

  it('converts a valid TZS amount to integer cents for the server', () => {
    const result = validatePaymentForm({
      phoneNumber: '0712345678',
      amount: '1500',
      paymentType: 'invoice',
      energyKwh: '',
    });
    expect(result).toEqual({
      ok: true,
      amountTzs: 1500,
      amountCents: 150000,
      energyKwhInt: undefined,
    });
  });

  it('truncates fractional TZS input the same way parseInt does', () => {
    const result = validatePaymentForm({
      phoneNumber: '0712345678',
      amount: '12.9',
      paymentType: 'invoice',
      energyKwh: '',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.amountTzs).toBe(12);
      expect(result.amountCents).toBe(1200);
    }
  });

  it('requires a positive kWh figure for token purchases', () => {
    for (const energyKwh of ['', 'abc', '0', '-3']) {
      const result = validatePaymentForm({
        phoneNumber: '0712345678',
        amount: '5000',
        paymentType: 'token_purchase',
        energyKwh,
      });
      expect(result).toEqual({
        ok: false,
        reason: 'invalid_energy',
        message: 'Please enter a valid energy amount (kWh)',
      });
    }
  });

  it('accepts a token purchase with a whole-kWh figure', () => {
    const result = validatePaymentForm({
      phoneNumber: '0712345678',
      amount: '5000',
      paymentType: 'token_purchase',
      energyKwh: '20',
    });
    expect(result).toEqual({
      ok: true,
      amountTzs: 5000,
      amountCents: 500000,
      energyKwhInt: 20,
    });
  });

  it('ignores any kWh input on non-token payments', () => {
    const result = validatePaymentForm({
      phoneNumber: '0712345678',
      amount: '5000',
      paymentType: 'invoice',
      energyKwh: 'not-a-number',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.energyKwhInt).toBeUndefined();
  });
});

describe('formatCentsTzs', () => {
  it('renders an em dash when there is no figure', () => {
    expect(formatCentsTzs(null)).toBe('—');
    expect(formatCentsTzs(undefined)).toBe('—');
  });

  it('renders whole TZS from cents', () => {
    expect(formatCentsTzs(0)).toBe('0 TZS');
    expect(formatCentsTzs(150000)).toBe('1500 TZS');
    expect(formatCentsTzs(99)).toBe('1 TZS');
  });
});

describe('kwhLabel (shared/prepaid-state, used by PrepaidEnergyScreen)', () => {
  it('keeps unknown readings unknown', () => {
    expect(kwhLabel(null)).toBeNull();
    expect(kwhLabel(undefined)).toBeNull();
  });

  it('renders whole kWh without decimals', () => {
    expect(kwhLabel(2000)).toBe('2');
    expect(kwhLabel(0)).toBe('0');
  });

  it('renders fractional kWh with two decimals', () => {
    expect(kwhLabel(2500)).toBe('2.50');
  });
});
