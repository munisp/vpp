/**
 * P2P trade settlement.
 *
 * A matched P2P trade is a promise between two participants, not a completed
 * transaction. The platform holds no client funds: there is no custody account,
 * no ledger that can debit a buyer, and no disbursement provider that can pay a
 * seller. Everything here therefore separates the states that were previously
 * collapsed into one `executed` flag:
 *
 *   matched -> buyer payment initiated -> buyer payment evidenced by the
 *   provider -> seller payout (unavailable today) -> executed
 *
 * The buyer's leg is paid through the same mobile-money gateways the rest of
 * the platform uses, so a payment is only ever recognised from a provider
 * callback. The seller's leg cannot be paid at all yet, so it is refused
 * explicitly rather than implied by a status change.
 */

import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { getDb } from '../db';
import { payments, telemetry, trades } from '../../drizzle/schema';
import { p2pSettlements } from '../../drizzle/innovations-schema';
import { PaymentGatewayManager } from '../payment-gateways';
import { resolveGatewayEnvironment } from '../payment-gateways/environment';
import { isUniqueViolation } from '../pg-errors';
import { postBuyerPaymentCaptured } from './ledger/postings';
import { LedgerRefusedError } from './ledger/tigerbeetle';
import type { LedgerPostingState } from '../../drizzle/ledger-schema';

export type P2pGateway = 'mpesa' | 'airtel_money' | 'tigo_pesa';

export const SETTLEMENT_AWAITING_PAYMENT = 'awaiting_payment';
export const SETTLEMENT_PAYMENT_INITIATED = 'buyer_payment_initiated';
export const SETTLEMENT_BUYER_PAID = 'buyer_paid_awaiting_seller_payout';

/**
 * The currency a P2P purchase is quoted and charged in. `trades.totalAmount`
 * carries no currency of its own, so the payment must be raised in this one for
 * the amount comparison at settlement to mean anything.
 */
export const P2P_CURRENCY = 'TZS';

export class P2pSettlementError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'P2pSettlementError';
  }
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Merge into a trade's metadata instead of replacing it: the prior keys carry
 * the match, dispatch and control-window evidence for this trade.
 */
function mergeMetadata(existing: string | null, patch: Record<string, unknown>): string {
  return JSON.stringify({ ...parseMetadata(existing), ...patch });
}

/**
 * A reservation or request that already exists for this trade. It is returned
 * rather than re-raised, so a retry never asks the provider a second time.
 */
function alreadyRequested(row: {
  id: number;
  amount: number;
  transactionId: string | null;
  metadata: string | null;
}): StartTradePaymentResult {
  const meta = parseMetadata(row.metadata);
  return {
    paymentId: row.id,
    amountDueCents: row.amount,
    transactionId: row.transactionId ?? null,
    checkoutRequestId: typeof meta.checkoutRequestId === 'string' ? meta.checkoutRequestId : null,
    settlement: SETTLEMENT_PAYMENT_INITIATED,
    message:
      row.transactionId === null
        ? 'A payment request for this purchase is being raised with the provider.'
        : 'A payment request for this purchase is already awaiting the provider callback.',
  };
}

export interface StartTradePaymentInput {
  buyTradeId: number;
  buyerId: number;
  gateway: P2pGateway;
  phoneNumber: string;
}

export interface StartTradePaymentResult {
  paymentId: number;
  amountDueCents: number;
  transactionId: string | null;
  checkoutRequestId: string | null;
  settlement: typeof SETTLEMENT_PAYMENT_INITIATED;
  message: string;
}

/**
 * Ask the buyer's mobile-money provider for the amount owed on a matched
 * trade. A pending payment row is reserved first so that only one request per
 * trade can reach the provider; it stays `pending`, holding no claim that money
 * moved, until the provider's callback settles it.
 */
export async function startTradePayment(input: StartTradePaymentInput): Promise<StartTradePaymentResult> {
  const db = await getDb();
  if (!db) throw new P2pSettlementError('DATABASE_UNAVAILABLE', 'Database not available');

  const [trade] = await db
    .select()
    .from(trades)
    .where(eq(trades.id, input.buyTradeId))
    .limit(1);

  if (!trade || trade.tradeType !== 'p2p_buy') {
    throw new P2pSettlementError('TRADE_NOT_FOUND', 'P2P purchase not found.');
  }
  if (trade.userId !== input.buyerId) {
    throw new P2pSettlementError('NOT_BUYER', 'Only the buyer on this trade can pay for it.');
  }
  if (trade.status !== 'pending') {
    throw new P2pSettlementError(
      'TRADE_NOT_PAYABLE',
      `This purchase is '${trade.status}' and cannot be paid for.`
    );
  }
  if (trade.counterpartyId === null) {
    throw new P2pSettlementError('TRADE_UNMATCHED', 'This purchase has no seller matched to it yet.');
  }
  if (trade.totalAmount <= 0) {
    throw new P2pSettlementError('TRADE_AMOUNT_INVALID', 'This purchase has no amount to pay.');
  }

  // Resolved before anything is reserved: a deployment with no provider cannot
  // charge anyone, and saying so is not the same as a payment that failed.
  const environment = resolveGatewayEnvironment();
  const readiness = await PaymentGatewayManager.isConfigured(input.gateway, environment);
  if (!readiness.configured) {
    throw new P2pSettlementError(
      'GATEWAY_NOT_CONFIGURED',
      `No payment can be raised through ${input.gateway}: ${readiness.reason ?? 'the gateway is not configured.'}`
    );
  }

  // Idempotency: one live payment attempt per trade, enforced in the database
  // by payments_p2p_trade_live_uq. The row is reserved *before* the provider is
  // asked for money, because the index guards the row, not the charge: reading
  // first and inserting afterwards leaves a window in which two concurrent
  // requests both ask the provider and the buyer is debited twice.
  const liveBefore = await db
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.p2pTradeId, trade.id),
        inArray(payments.status, ['pending', 'completed'])
      )
    );

  const settledEarlier = liveBefore.find(row => row.status === 'completed');
  if (settledEarlier) {
    throw new P2pSettlementError(
      'ALREADY_PAID',
      `This purchase was already paid by payment ${settledEarlier.id}.`
    );
  }
  const inFlightEarlier = liveBefore.find(row => row.status === 'pending');
  if (inFlightEarlier) return alreadyRequested(inFlightEarlier);

  let payment: { id: number };
  try {
    [payment] = await db
      .insert(payments)
      .values({
        userId: input.buyerId,
        paymentType: 'p2p_trade',
        amount: trade.totalAmount,
        currency: P2P_CURRENCY,
        paymentMethod: input.gateway,
        phoneNumber: input.phoneNumber,
        status: 'pending',
        p2pTradeId: trade.id,
        metadata: JSON.stringify({
          buyTradeId: trade.id,
          sellTradeId: parseMetadata(trade.metadata).sellOfferId ?? null,
          sellerId: trade.counterpartyId,
          providerRequested: false,
        }),
      })
      .returning({ id: payments.id });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Another request reserved this trade first. It owns the provider call, so
    // this one must not raise a second charge.
    const [live] = await db
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.p2pTradeId, trade.id),
          inArray(payments.status, ['pending', 'completed'])
        )
      )
      .limit(1);
    if (live?.status === 'completed') {
      throw new P2pSettlementError(
        'ALREADY_PAID',
        `This purchase was already paid by payment ${live.id}.`
      );
    }
    if (live) return alreadyRequested(live);
    // The winner released its reservation between the failed insert and this
    // read, so no charge is in flight and reserving again would succeed.
    throw new P2pSettlementError(
      'RESERVATION_RACE_LOST',
      'Another payment attempt for this purchase was being resolved. No payment was raised; try again.'
    );
  }

  let response: Awaited<ReturnType<typeof PaymentGatewayManager.initiatePayment>>;
  try {
    response = await PaymentGatewayManager.initiatePayment(
      input.gateway,
      {
        amount: trade.totalAmount,
        phoneNumber: input.phoneNumber,
        accountReference: `P2P-${trade.id}`,
        transactionDesc: `P2P energy purchase ${trade.energy}Wh (trade ${trade.id})`,
        metadata: {
          userId: input.buyerId,
          buyTradeId: trade.id,
          sellerId: trade.counterpartyId,
        },
      },
      environment
    );
  } catch (error) {
    // The request may or may not have reached the provider, so the reservation
    // stays live: releasing it would let a retry raise a second charge against
    // a request that could still settle.
    console.error(
      `[P2pSettlement] Provider call for trade ${trade.id} (reservation ${payment.id}) failed outright:`,
      error
    );
    throw new P2pSettlementError(
      'GATEWAY_UNREACHABLE',
      `The payment provider could not be reached for this purchase (reservation ${payment.id}). Do not retry: contact support so the attempt can be reconciled.`
    );
  }

  if (!response.success) {
    // The provider declined before taking money, so the reservation is released
    // and the buyer can try again. 'failed' is outside the live-payment index.
    await db
      .update(payments)
      .set({
        status: 'failed',
        metadata: JSON.stringify({
          buyTradeId: trade.id,
          sellerId: trade.counterpartyId,
          providerRequested: true,
          providerRefusal: response.message ?? 'no message',
        }),
      })
      .where(eq(payments.id, payment.id));
    throw new P2pSettlementError(
      'GATEWAY_REFUSED',
      response.message || 'The payment provider refused the request.'
    );
  }

  // The provider has accepted a request for real money. If recording its
  // references fails, they are logged rather than lost: the callback arrives
  // regardless, and without the reference it cannot be matched to this trade.
  try {
    await db
      .update(payments)
      .set({
        transactionId: response.transactionId,
        metadata: JSON.stringify({
          buyTradeId: trade.id,
          sellTradeId: parseMetadata(trade.metadata).sellOfferId ?? null,
          sellerId: trade.counterpartyId,
          checkoutRequestId: response.checkoutRequestId,
          providerRequested: true,
        }),
      })
      .where(eq(payments.id, payment.id));

    await db
      .update(trades)
      .set({
        metadata: mergeMetadata(trade.metadata, {
          settlement: SETTLEMENT_PAYMENT_INITIATED,
          buyerPaymentId: payment.id,
        }),
      })
      .where(eq(trades.id, trade.id));
  } catch (error) {
    console.error(
      `[P2pSettlement] Provider accepted a payment request for trade ${trade.id} (reservation ${payment.id}, transactionId ${response.transactionId ?? 'none'}, checkoutRequestId ${response.checkoutRequestId ?? 'none'}) but it could not be recorded:`,
      error
    );
    throw new P2pSettlementError(
      'PAYMENT_UNRECORDED',
      `The provider accepted a payment request for this purchase (reservation ${payment.id}) but the platform could not record it. Do not retry: contact support so the attempt can be reconciled.`
    );
  }

  return {
    paymentId: payment.id,
    amountDueCents: trade.totalAmount,
    transactionId: response.transactionId ?? null,
    checkoutRequestId: response.checkoutRequestId ?? null,
    settlement: SETTLEMENT_PAYMENT_INITIATED,
    message:
      'Payment requested from your provider. The trade settles only after the provider confirms the payment.',
  };
}

export interface BuyerPaymentSettledResult {
  buyTradeId: number;
  sellTradeId: number | null;
  settlementId: number;
  settlement: typeof SETTLEMENT_BUYER_PAID;
  sellerPayoutAvailable: false;
  detail: string;
  /**
   * What the double-entry ledger did with this payment. `posted` means the funds
   * held at the gateway and the amount owed to the seller are both on the ledger;
   * anything else means the platform's own record of the money is incomplete and
   * says so, instead of the settlement row implying a balance nobody holds.
   */
  ledgerPosting: { state: LedgerPostingState; detail: string };
}

/**
 * Record a provider-confirmed buyer payment against its trade.
 *
 * This deliberately does not mark either leg `executed`: that status is read as
 * revenue by analytics and as earnings by the seller, and the seller has not
 * been paid. Both legs move to `buyer_paid_awaiting_seller_payout`, which is
 * the true state of the money.
 */
export async function recordBuyerPaymentSettled(payment: {
  id: number;
  userId: number;
  amount: number;
  currency?: string | null;
  transactionId?: string | null;
  p2pTradeId?: number | null;
  /** The provider that took the money. It names the clearing account it sits in. */
  paymentMethod?: string | null;
  metadata: string | null;
}): Promise<BuyerPaymentSettledResult> {
  const db = await getDb();
  if (!db) throw new P2pSettlementError('DATABASE_UNAVAILABLE', 'Database not available');

  // The `p2pTradeId` column is the linkage the database constrains and indexes;
  // metadata is only a copy of it. Where both name a trade they must agree, or
  // the payment's own record of what it paid for is self-contradictory.
  const meta = parseMetadata(payment.metadata);
  const fromMetadata = Number(meta.buyTradeId);
  const fromColumn = payment.p2pTradeId ?? null;
  const metadataTradeId = Number.isInteger(fromMetadata) && fromMetadata > 0 ? fromMetadata : null;
  if (fromColumn !== null && metadataTradeId !== null && fromColumn !== metadataTradeId) {
    throw new P2pSettlementError(
      'PAYMENT_TRADE_CONFLICT',
      `Payment ${payment.id} is linked to trade ${fromColumn} but its metadata names trade ${metadataTradeId}; it cannot be attributed to either.`
    );
  }
  const buyTradeId = fromColumn ?? metadataTradeId;
  if (buyTradeId === null) {
    throw new P2pSettlementError(
      'PAYMENT_NOT_LINKED',
      `Payment ${payment.id} is a P2P trade payment with no buyTradeId; it cannot be attributed to a trade.`
    );
  }

  const [buyTrade] = await db.select().from(trades).where(eq(trades.id, buyTradeId)).limit(1);
  if (!buyTrade) {
    throw new P2pSettlementError(
      'TRADE_NOT_FOUND',
      `Payment ${payment.id} references trade ${buyTradeId}, which does not exist.`
    );
  }
  // A payment can only settle the trade of the person who made it: otherwise
  // one participant's payment would settle another participant's purchase.
  if (buyTrade.userId !== payment.userId) {
    throw new P2pSettlementError(
      'PAYMENT_PAYER_MISMATCH',
      `Payment ${payment.id} was made by user ${payment.userId} but trade ${buyTradeId} is owed by user ${buyTrade.userId}.`
    );
  }
  if (buyTrade.tradeType !== 'p2p_buy') {
    throw new P2pSettlementError(
      'TRADE_NOT_PURCHASE',
      `Payment ${payment.id} references trade ${buyTradeId}, which is a '${buyTrade.tradeType}' and not a P2P purchase.`
    );
  }
  if (payment.amount !== buyTrade.totalAmount) {
    throw new P2pSettlementError(
      'AMOUNT_MISMATCH',
      `Payment ${payment.id} settled ${payment.amount} cents but trade ${buyTradeId} owes ${buyTrade.totalAmount} cents.`
    );
  }
  // An equal number of a different currency is not the amount owed.
  if (payment.currency !== undefined && payment.currency !== null && payment.currency !== P2P_CURRENCY) {
    throw new P2pSettlementError(
      'CURRENCY_MISMATCH',
      `Payment ${payment.id} settled in ${payment.currency} but trade ${buyTradeId} is owed in ${P2P_CURRENCY}.`
    );
  }
  if (buyTrade.counterpartyId === null) {
    throw new P2pSettlementError(
      'TRADE_UNMATCHED',
      `Payment ${payment.id} settled trade ${buyTradeId}, which names no seller to settle with.`
    );
  }
  // The provider's own reference is the evidence; our row id is not.
  const providerReference = payment.transactionId ?? null;
  if (!providerReference) {
    throw new P2pSettlementError(
      'PAYMENT_EVIDENCE_MISSING',
      `Payment ${payment.id} carries no provider reference, so the settlement would record a payment with nothing behind it.`
    );
  }

  const detail =
    'The buyer has paid and the provider confirmed it. The seller has not been paid: the platform has no disbursement provider, so this trade is not complete.';

  const patch = {
    settlement: SETTLEMENT_BUYER_PAID,
    buyerPaymentId: payment.id,
    buyerPaidAt: new Date().toISOString(),
    sellerPayout: 'unavailable_no_provider',
  };

  const paidAt = new Date();

  // Both legs and the settlement record move together: a buyer marked paid
  // while the seller's leg still reads unpaid would be a discrepancy the
  // platform invented itself.
  const { settlementId, settledSellTradeId } = await db.transaction(async tx => {
    await tx
      .update(trades)
      .set({ metadata: mergeMetadata(buyTrade.metadata, patch) })
      .where(eq(trades.id, buyTrade.id));

    const candidateSellTradeId = Number(parseMetadata(buyTrade.metadata).sellOfferId);
    let sellTradeIdOrNull: number | null = null;
    if (Number.isInteger(candidateSellTradeId) && candidateSellTradeId > 0) {
      const [sellTrade] = await tx
        .select()
        .from(trades)
        .where(eq(trades.id, candidateSellTradeId))
        .limit(1);
      if (sellTrade) {
        sellTradeIdOrNull = sellTrade.id;
        await tx
          .update(trades)
          .set({ metadata: mergeMetadata(sellTrade.metadata, patch) })
          .where(eq(trades.id, sellTrade.id));
      }
    }

    // Idempotent under a duplicate provider callback: the settlement is keyed
    // by its trade, and a second confirmation of the same payment updates the
    // same row rather than opening a second one.
    const [settlement] = await tx
      .insert(p2pSettlements)
      .values({
        buyTradeId: buyTrade.id,
        sellTradeId: sellTradeIdOrNull,
        buyerId: buyTrade.userId,
        sellerId: buyTrade.counterpartyId as number,
        energyWh: buyTrade.energy,
        amountCents: buyTrade.totalAmount,
        currency: P2P_CURRENCY,
        buyerPaymentId: payment.id,
        buyerPaymentReference: providerReference,
        buyerPaidAt: paidAt,
        sellerPayout: 'unavailable_no_provider',
        state: 'buyer_paid_seller_unpaid',
        reconciliation: 'pending',
        reconciliationNote: detail,
        updatedAt: paidAt,
      })
      .onConflictDoUpdate({
        target: p2pSettlements.buyTradeId,
        set: {
          sellTradeId: sellTradeIdOrNull,
          buyerPaymentId: payment.id,
          buyerPaymentReference: providerReference,
          buyerPaidAt: paidAt,
          state: 'buyer_paid_seller_unpaid',
          reconciliationNote: detail,
          updatedAt: paidAt,
        },
      })
      .returning({ id: p2pSettlements.id });

    return { settlementId: settlement.id, settledSellTradeId: sellTradeIdOrNull };
  });

  // The double entry is attempted after the settlement commits, because the money
  // has already moved at the provider: the entry records that fact, it does not
  // authorise it. A ledger that is unreachable or that refuses therefore leaves a
  // visible unposted row for reconciliation instead of discarding a confirmed
  // payment.
  const ledgerPosting = await recordCaptureOnLedger({
    paymentId: payment.id,
    sellerUserId: buyTrade.counterpartyId as number,
    gatewayKey: payment.paymentMethod ?? 'unknown_gateway',
    amountMinor: payment.amount,
    providerReference,
  });

  return {
    buyTradeId: buyTrade.id,
    sellTradeId: settledSellTradeId,
    settlementId,
    settlement: SETTLEMENT_BUYER_PAID,
    sellerPayoutAvailable: false,
    detail,
    ledgerPosting,
  };
}

/**
 * Post a confirmed buyer payment to the double-entry ledger, translating every
 * outcome into a state a reader can act on. Nothing is thrown: the caller has a
 * provider-confirmed payment recorded, and losing that record because the ledger
 * was down would be worse than an unposted entry an operator can see.
 */
export async function recordCaptureOnLedger(input: {
  paymentId: number;
  sellerUserId: number;
  gatewayKey: string;
  amountMinor: number;
  providerReference: string;
}): Promise<{ state: LedgerPostingState; detail: string }> {
  try {
    const result = await postBuyerPaymentCaptured({
      paymentId: input.paymentId,
      sellerUserId: input.sellerUserId,
      gatewayKey: input.gatewayKey,
      currency: P2P_CURRENCY,
      amountMinor: input.amountMinor,
      providerReference: input.providerReference,
    });
    return { state: result.state, detail: result.detail };
  } catch (error) {
    if (error instanceof LedgerRefusedError) {
      console.error(
        `[P2pSettlement] The ledger refused the entry for payment ${input.paymentId} (${error.status}); the payment stands and the entry is recorded as refused`
      );
      return { state: 'refused', detail: `The ledger refused this entry: ${error.status}.` };
    }
    const reason = error instanceof Error ? error.message : String(error);
    console.error(
      `[P2pSettlement] The ledger did not confirm the entry for payment ${input.paymentId}: ${reason}`
    );
    return {
      state: 'pending',
      detail: `The ledger did not confirm this entry: ${reason}. It will be retried.`,
    };
  }
}

/**
 * Fewest telemetry samples that can stand for a delivery window. One reading
 * cannot describe power over a period, so a single sample is coverage too thin
 * to measure with and is recorded as unverified rather than as zero delivery.
 */
export const MIN_DELIVERY_SAMPLES = 2;

/** Fraction of the traded energy that must be measured for delivery to count. */
export const DELIVERY_TOLERANCE = 0.1;

export interface MeasureDeliveryResult {
  settlementId: number;
  delivery: 'unverified' | 'measured' | 'not_delivered';
  deliveredEnergyWh: number | null;
  samples: number;
  note: string;
}

/**
 * Measure what the seller's asset actually exported during the transfer window,
 * from persisted telemetry. Nothing here trusts the dispatch: a queued setpoint
 * is a command, and only metered power is delivery. Too few samples is recorded
 * as `unverified` — neither a delivery nor a proven failure to deliver.
 */
export async function measureTradeDelivery(buyTradeId: number): Promise<MeasureDeliveryResult> {
  const db = await getDb();
  if (!db) throw new P2pSettlementError('DATABASE_UNAVAILABLE', 'Database not available');

  const [settlement] = await db
    .select()
    .from(p2pSettlements)
    .where(eq(p2pSettlements.buyTradeId, buyTradeId))
    .limit(1);

  if (!settlement) {
    throw new P2pSettlementError(
      'SETTLEMENT_NOT_FOUND',
      `Trade ${buyTradeId} has no settlement record, so there is no paid delivery to measure.`
    );
  }

  const sellTradeId = settlement.sellTradeId;
  if (sellTradeId === null) {
    throw new P2pSettlementError(
      'DELIVERY_WINDOW_UNKNOWN',
      `Settlement ${settlement.id} names no seller leg, so the platform does not know when delivery was due.`
    );
  }

  const [sellTrade] = await db.select().from(trades).where(eq(trades.id, sellTradeId)).limit(1);
  const dispatch = parseMetadata(sellTrade?.metadata ?? null);
  const assetId = Number(dispatch.assetId);
  const validFrom = typeof dispatch.validFrom === 'string' ? new Date(dispatch.validFrom) : null;
  const validTo = typeof dispatch.validTo === 'string' ? new Date(dispatch.validTo) : null;

  if (
    !Number.isInteger(assetId) ||
    assetId <= 0 ||
    !validFrom ||
    !validTo ||
    Number.isNaN(validFrom.getTime()) ||
    Number.isNaN(validTo.getTime())
  ) {
    throw new P2pSettlementError(
      'DELIVERY_WINDOW_UNKNOWN',
      `Trade ${buyTradeId} was never dispatched to an asset over a known window, so its delivery cannot be measured.`
    );
  }
  if (validTo.getTime() > Date.now()) {
    throw new P2pSettlementError(
      'DELIVERY_WINDOW_OPEN',
      `The transfer window for trade ${buyTradeId} closes at ${validTo.toISOString()}; measuring it now would report a partial window as the whole delivery.`
    );
  }

  const samples = await db
    .select({ timestamp: telemetry.timestamp, power: telemetry.power })
    .from(telemetry)
    .where(
      and(
        eq(telemetry.assetId, assetId),
        gte(telemetry.timestamp, validFrom),
        lte(telemetry.timestamp, validTo)
      )
    )
    .orderBy(telemetry.timestamp);

  const measuredAt = new Date();
  const powered = samples.filter(row => row.power !== null);

  let delivery: MeasureDeliveryResult['delivery'];
  let deliveredEnergyWh: number | null;
  let note: string;

  if (powered.length < MIN_DELIVERY_SAMPLES) {
    delivery = 'unverified';
    deliveredEnergyWh = null;
    note =
      `Asset ${assetId} reported ${powered.length} power sample(s) between ` +
      `${validFrom.toISOString()} and ${validTo.toISOString()}; that is too little telemetry ` +
      `to measure delivery, so this is neither paid as delivered nor recorded as a failure to deliver.`;
  } else {
    // Trapezoidal integration over the samples the asset actually reported;
    // gaps between samples are not filled in, so a silent asset lowers the
    // measured energy instead of being assumed to have kept exporting.
    let wattSeconds = 0;
    for (let i = 1; i < powered.length; i += 1) {
      const previous = powered[i - 1];
      const current = powered[i];
      const seconds = (current.timestamp.getTime() - previous.timestamp.getTime()) / 1000;
      if (seconds <= 0) continue;
      const exportedPrevious = Math.max(previous.power as number, 0);
      const exportedCurrent = Math.max(current.power as number, 0);
      wattSeconds += ((exportedPrevious + exportedCurrent) / 2) * seconds;
    }
    deliveredEnergyWh = Math.round(wattSeconds / 3600);
    const required = settlement.energyWh * (1 - DELIVERY_TOLERANCE);
    if (deliveredEnergyWh >= required) {
      delivery = 'measured';
      note =
        `Asset ${assetId} exported ${deliveredEnergyWh} Wh across ${powered.length} samples ` +
        `against ${settlement.energyWh} Wh traded.`;
    } else {
      delivery = 'not_delivered';
      note =
        `Asset ${assetId} exported ${deliveredEnergyWh} Wh across ${powered.length} samples, ` +
        `short of the ${settlement.energyWh} Wh traded. The buyer has paid, so this needs a refund decision.`;
    }
  }

  // 'not_delivered' is a paid trade with nothing behind it: unresolved, not a
  // quiet failure state, because someone has to act on it.
  const state =
    delivery === 'measured'
      ? 'delivery_evidenced'
      : delivery === 'not_delivered'
        ? 'unresolved'
        : settlement.state;

  await db
    .update(p2pSettlements)
    .set({
      delivery,
      deliveredEnergyWh,
      deliverySamples: powered.length,
      deliveryMeasuredAt: delivery === 'measured' ? measuredAt : null,
      deliveryNote: note,
      state,
      updatedAt: measuredAt,
    })
    .where(eq(p2pSettlements.id, settlement.id));

  return { settlementId: settlement.id, delivery, deliveredEnergyWh, samples: powered.length, note };
}

export interface ReconcileResult {
  settlementId: number;
  reconciliation: 'pending' | 'matched' | 'mismatch';
  note: string;
}

/**
 * Reconcile a settlement against evidence outside itself: the payment row the
 * provider confirmed, and the metered delivery. A settlement is never compared
 * with its own state, and `matched` is not `complete` — the seller's payout is
 * still missing, so reconciliation stays pending on that leg rather than
 * agreeing that a half-finished trade is whole.
 */
export async function reconcileTradeSettlement(buyTradeId: number): Promise<ReconcileResult> {
  const db = await getDb();
  if (!db) throw new P2pSettlementError('DATABASE_UNAVAILABLE', 'Database not available');

  const [settlement] = await db
    .select()
    .from(p2pSettlements)
    .where(eq(p2pSettlements.buyTradeId, buyTradeId))
    .limit(1);

  if (!settlement) {
    throw new P2pSettlementError(
      'SETTLEMENT_NOT_FOUND',
      `Trade ${buyTradeId} has no settlement record to reconcile.`
    );
  }

  const problems: string[] = [];

  const [payment] = settlement.buyerPaymentId
    ? await db.select().from(payments).where(eq(payments.id, settlement.buyerPaymentId)).limit(1)
    : [];

  if (!payment) {
    problems.push(`no payment row backs the recorded buyer payment`);
  } else {
    if (payment.status !== 'completed') {
      problems.push(`payment ${payment.id} is '${payment.status}', not completed`);
    }
    if (payment.amount !== settlement.amountCents) {
      problems.push(
        `payment ${payment.id} is ${payment.amount} cents against ${settlement.amountCents} settled`
      );
    }
    if (payment.currency && payment.currency !== settlement.currency) {
      problems.push(
        `payment ${payment.id} is in ${payment.currency} against ${settlement.currency} settled`
      );
    }
    if (payment.p2pTradeId !== settlement.buyTradeId) {
      problems.push(`payment ${payment.id} names trade ${payment.p2pTradeId}, not ${settlement.buyTradeId}`);
    }
    if (settlement.buyerPaymentReference && payment.transactionId !== settlement.buyerPaymentReference) {
      problems.push(
        `provider reference ${settlement.buyerPaymentReference} does not match payment ${payment.id}`
      );
    }
  }

  if (settlement.delivery === 'not_delivered') {
    problems.push('the traded energy was measured as undelivered');
  }

  const reconciledAt = new Date();
  let reconciliation: ReconcileResult['reconciliation'];
  let note: string;

  if (problems.length > 0) {
    reconciliation = 'mismatch';
    note = `Settlement ${settlement.id} does not reconcile: ${problems.join('; ')}.`;
  } else if (settlement.delivery !== 'measured') {
    reconciliation = 'pending';
    note = `Buyer payment reconciles, but delivery is '${settlement.delivery}', so the trade is not reconciled.`;
  } else if (settlement.sellerPayout !== 'evidenced') {
    reconciliation = 'pending';
    note =
      `Buyer payment and metered delivery reconcile, but the seller has not been paid ` +
      `(payout '${settlement.sellerPayout}'), so the trade is not reconciled.`;
  } else {
    reconciliation = 'matched';
    note = `Payment, metered delivery and seller payout all reconcile for settlement ${settlement.id}.`;
  }

  await db
    .update(p2pSettlements)
    .set({
      reconciliation,
      reconciliationNote: note,
      reconciledAt: reconciliation === 'pending' ? null : reconciledAt,
      state:
        reconciliation === 'mismatch'
          ? 'unresolved'
          : reconciliation === 'matched' && settlement.sellerPayout === 'evidenced'
            ? 'complete'
            : settlement.state,
      updatedAt: reconciledAt,
    })
    .where(eq(p2pSettlements.id, settlement.id));

  return { settlementId: settlement.id, reconciliation, note };
}

/**
 * Paying the seller moves real money out of the platform, and no provider is
 * wired to do it. Callers get a refusal that names the missing capability
 * rather than a status flag that implies the seller was paid.
 */
export function assertSellerPayoutAvailable(context: { tradeId: number; sellerId: number }): never {
  throw new P2pSettlementError(
    'SELLER_PAYOUT_NOT_CONFIGURED',
    `Cannot pay seller ${context.sellerId} for trade ${context.tradeId}: the platform has no disbursement provider, so no funds can leave it.`
  );
}
