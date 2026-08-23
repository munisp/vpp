import { describe, expect, it } from 'vitest';
import {
  deliveryLeg,
  formatMoneyCents,
  formatWh,
  payoutLeg,
  reconciliationLeg,
  settlementHeadline,
} from '@shared/p2p-settlement-state';

describe('settlement headline', () => {
  it('never reads as complete because the buyer paid', () => {
    const leg = settlementHeadline({
      state: 'buyer_paid_seller_unpaid',
      delivery: 'unmeasured',
      sellerPayout: 'unavailable_no_provider',
    });
    expect(leg.label).toBe('No payout provider');
    expect(leg.tone).toBe('danger');
  });

  it('leads with an undelivered measurement over the payout state', () => {
    const leg = settlementHeadline({
      state: 'buyer_paid_seller_unpaid',
      delivery: 'not_delivered',
      sellerPayout: 'unavailable_no_provider',
    });
    expect(leg.label).toBe('Not delivered');
  });

  it('reads as complete only from the complete state', () => {
    expect(
      settlementHeadline({ state: 'complete', delivery: 'measured', sellerPayout: 'evidenced' })
        .label
    ).toBe('Complete');
  });

  it('keeps an unresolved trade out of the settled reading', () => {
    const leg = settlementHeadline({
      state: 'unresolved',
      delivery: 'measured',
      sellerPayout: 'evidenced',
    });
    expect(leg.tone).toBe('danger');
  });
});

describe('legs distinguish missing evidence from failure', () => {
  it('reads thin telemetry as neither delivered nor breached', () => {
    expect(deliveryLeg('unverified').tone).toBe('warning');
    expect(deliveryLeg('unmeasured').tone).toBe('neutral');
    expect(deliveryLeg('measured').tone).toBe('good');
    expect(deliveryLeg('not_delivered').tone).toBe('danger');
  });

  it('reads a requested payout as unproven, not paid', () => {
    expect(payoutLeg('requested').tone).toBe('warning');
    expect(payoutLeg('evidenced').tone).toBe('good');
  });

  it('reads pending reconciliation as unknown rather than agreed', () => {
    expect(reconciliationLeg('pending').tone).toBe('neutral');
    expect(reconciliationLeg('mismatch').tone).toBe('danger');
    expect(reconciliationLeg('matched').tone).toBe('good');
  });
});

describe('units', () => {
  it('shows Wh below a kWh and kWh above it', () => {
    expect(formatWh(400)).toBe('400 Wh');
    expect(formatWh(2500)).toBe('2.50 kWh');
  });

  it('renders cents as major units with the currency', () => {
    expect(formatMoneyCents(123456, 'TZS')).toBe('1234.56 TZS');
  });
});
