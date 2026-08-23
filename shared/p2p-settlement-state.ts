/**
 * One vocabulary for what the platform can prove about a P2P trade.
 *
 * A trade has four independent legs — the buyer's payment, the delivered
 * energy, the seller's payout and the reconciliation — and each carries its own
 * evidence. They are rendered separately on purpose: a confirmed payment is not
 * a delivered kWh, a dispatched setpoint is not a measured export, and neither
 * is money reaching the seller. Collapsing them into one "settled" badge is the
 * failure this module exists to prevent, so the PWA and the native app read
 * from the same labels here.
 */

export type SettlementLegTone = 'good' | 'warning' | 'danger' | 'neutral';

export interface SettlementLeg {
  label: string;
  detail: string;
  tone: SettlementLegTone;
}

export type SettlementState =
  | 'buyer_paid_seller_unpaid'
  | 'delivery_evidenced'
  | 'complete'
  | 'unresolved';

export type DeliveryEvidence = 'unmeasured' | 'unverified' | 'measured' | 'not_delivered';

export type PayoutEvidence = 'unavailable_no_provider' | 'requested' | 'evidenced';

export type ReconciliationOutcome = 'pending' | 'matched' | 'mismatch';

export function settlementStateLeg(state: SettlementState): SettlementLeg {
  switch (state) {
    case 'buyer_paid_seller_unpaid':
      return {
        label: 'Buyer paid, seller unpaid',
        detail:
          'The provider confirmed the buyer’s payment. The trade is not finished: the energy and the seller’s payout still have to be evidenced.',
        tone: 'warning',
      };
    case 'delivery_evidenced':
      return {
        label: 'Energy measured',
        detail:
          'Metered telemetry shows the traded energy was exported. The seller has still not been paid.',
        tone: 'warning',
      };
    case 'complete':
      return {
        label: 'Complete',
        detail:
          'Payment, measured delivery and the seller’s payout are all evidenced by their providers.',
        tone: 'good',
      };
    case 'unresolved':
      return {
        label: 'Unresolved',
        detail:
          'The evidence for this trade does not agree. It is held for operator review and is not counted as settled.',
        tone: 'danger',
      };
  }
}

export function deliveryLeg(evidence: DeliveryEvidence): SettlementLeg {
  switch (evidence) {
    case 'unmeasured':
      return {
        label: 'Not measured yet',
        detail:
          'No delivery measurement has been taken. Dispatching an export setpoint is not evidence that energy flowed.',
        tone: 'neutral',
      };
    case 'unverified':
      return {
        label: 'Too little telemetry',
        detail:
          'The asset reported too few readings over the transfer window to measure the delivered energy. This is neither proof of delivery nor proof of failure.',
        tone: 'warning',
      };
    case 'measured':
      return {
        label: 'Measured',
        detail: 'The exported energy was integrated from the asset’s own readings.',
        tone: 'good',
      };
    case 'not_delivered':
      return {
        label: 'Not delivered',
        detail:
          'The asset reported enough readings to measure the window, and the energy exported fell short of the traded amount.',
        tone: 'danger',
      };
  }
}

export function payoutLeg(evidence: PayoutEvidence): SettlementLeg {
  switch (evidence) {
    case 'unavailable_no_provider':
      return {
        label: 'No payout provider',
        detail:
          'This deployment has no disbursement provider, so the platform cannot pay the seller and will not pretend it has. The buyer’s money stays where the provider put it.',
        tone: 'danger',
      };
    case 'requested':
      return {
        label: 'Payout requested',
        detail:
          'A disbursement was requested from the provider. It is not evidence that the seller received the money.',
        tone: 'warning',
      };
    case 'evidenced':
      return {
        label: 'Payout evidenced',
        detail: 'The provider confirmed the disbursement with its own reference.',
        tone: 'good',
      };
  }
}

export function reconciliationLeg(outcome: ReconciliationOutcome): SettlementLeg {
  switch (outcome) {
    case 'pending':
      return {
        label: 'Reconciliation pending',
        detail: 'One or more legs are still unevidenced, so nothing has been reconciled.',
        tone: 'neutral',
      };
    case 'matched':
      return {
        label: 'Reconciled',
        detail:
          'The payment row, the measured delivery and the payout reference were re-read independently and agree.',
        tone: 'good',
      };
    case 'mismatch':
      return {
        label: 'Mismatch',
        detail:
          'Re-reading the evidence found a disagreement. An operator has to resolve it; the trade is not settled.',
        tone: 'danger',
      };
  }
}

/**
 * The single sentence to show beside a trade. It never claims completion from
 * one leg: the buyer's payment being confirmed is reported as exactly that.
 */
export function settlementHeadline(row: {
  state: SettlementState;
  delivery: DeliveryEvidence;
  sellerPayout: PayoutEvidence;
}): SettlementLeg {
  if (row.state === 'complete') return settlementStateLeg('complete');
  if (row.state === 'unresolved') return settlementStateLeg('unresolved');
  if (row.delivery === 'not_delivered') return deliveryLeg('not_delivered');
  if (row.sellerPayout === 'unavailable_no_provider') return payoutLeg('unavailable_no_provider');
  return settlementStateLeg(row.state);
}

export function formatWh(wh: number): string {
  return wh >= 1000 ? `${(wh / 1000).toFixed(2)} kWh` : `${wh} Wh`;
}

export function formatMoneyCents(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}
