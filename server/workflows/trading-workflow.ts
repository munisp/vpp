/**
 * Temporal Trading Workflow
 *
 * Orchestrates automated and P2P energy trading transactions.
 *
 * Temporal determinism rules: this file is workflow code, so it contains NO
 * database access and NO I/O of any kind. Every read, write, verification and
 * settlement step is an activity (implemented in trading-activities.ts and
 * registered by trading-worker.ts); the workflow only sequences them. Anything
 * that can fail — market data, guardrails, escrow, delivery verification,
 * payout — fails the workflow loudly with the real error instead of logging
 * and continuing.
 */

import { proxyActivities, sleep } from '@temporalio/workflow';

/**
 * Signatures of the trading activities registered on the 'trading-execution'
 * task queue (implemented in trading-activities.ts). Declared here so the
 * workflow bundle does not pull in worker-only code.
 */
interface TradingActivities {
  validateTradeActivity(input: {
    sellerId: number;
    buyerId: number;
    energyAmount: number;
    pricePerUnit: number;
  }): Promise<{ valid: boolean; error?: string }>;
  createEscrowActivity(input: {
    tradeId: number;
    amount: number;
    buyerId: number;
  }): Promise<{ success: boolean; escrowId?: string; error?: string }>;
  executeEnergyTransferActivity(input: {
    tradeId: number;
    sellerId: number;
    buyerId: number;
    energyAmount: number;
  }): Promise<{ success: boolean; transferId?: string; error?: string }>;
  releaseEscrowActivity(input: {
    tradeId: number;
    escrowId: string;
    sellerId: number;
  }): Promise<{ success: boolean; error?: string }>;
  sendTradeNotificationActivity(input: {
    userId: number;
    tradeId: number;
    type: 'trade_created' | 'trade_completed' | 'trade_failed';
    message: string;
  }): Promise<{ success: boolean; error?: string }>;
  getAvailableEnergyActivity(input: {
    userId: number;
    assetId: number;
  }): Promise<{ availableEnergyKwh: number; error?: string }>;
  getCurrentMarketPriceActivity(): Promise<{ priceCentsPerKwh: number }>;
  getRecentAverageMarketPriceActivity(input: {
    lookbackHours?: number;
  }): Promise<{ avgPriceCentsPerKwh: number }>;
  getTradingPreferencesActivity(input: {
    userId: number;
  }): Promise<{ minExportPrice: number | null; maxImportPrice: number | null } | null>;
  checkStrategyGuardrailsActivity(input: {
    strategyId: number;
    userId: number;
    tradeType: 'export' | 'import';
    energyKWh: number;
    priceCentsPerKwh: number;
    atIso: string;
  }): Promise<{ allowed: boolean; reason?: string }>;
  recordGuardrailRefusalActivity(input: {
    userId: number;
    strategyId: number;
    reason: string;
    energyKWh: number;
    priceCentsPerKwh: number;
  }): Promise<{ success: boolean; error?: string }>;
  createAutomatedTradeActivity(input: {
    userId: number;
    assetId: number;
    strategy: string;
    strategyId?: number;
    tradeType: 'export' | 'import' | 'p2p_sell' | 'p2p_buy';
    energyWh: number;
    priceCentsPerKwh: number;
    totalAmountCents: number;
  }): Promise<{ tradeId: number }>;
  markAutomatedTradeFailedActivity(input: {
    tradeId: number;
    strategy: string;
    assetId: number;
    error: string;
  }): Promise<{ success: boolean }>;
  markAutomatedTradeExecutedActivity(input: {
    tradeId: number;
    strategy: string;
    assetId: number;
    observedAvgPowerW?: number;
  }): Promise<{ success: boolean }>;
  verifyAssetDeliveryActivity(input: {
    userId: number;
    assetId: number;
    tradeType: 'export' | 'import' | 'p2p_sell' | 'p2p_buy';
  }): Promise<{ verified: boolean; observedAvgPowerW?: number; error?: string }>;
  verifyP2PDeliveryActivity(input: {
    sellerId: number;
    windowStartIso: string;
    windowEndIso: string;
  }): Promise<{ verified: boolean; observedAvgPowerW?: number; error?: string }>;
  createP2pTradePairActivity(input: {
    sellerId: number;
    buyerId: number;
    energyWh: number;
    priceCentsPerKwh: number;
    totalAmountCents: number;
    deliveryTimeIso: string;
    durationHours: number;
  }): Promise<{ sellerTradeId: number; buyerTradeId: number }>;
  markP2pPairDeliveredActivity(input: {
    sellerTradeId: number;
    buyerTradeId: number;
    observedAvgPowerW?: number;
  }): Promise<{ success: boolean }>;
  markP2pPairFailedActivity(input: {
    sellerTradeId: number;
    buyerTradeId: number;
    error: string;
  }): Promise<{ success: boolean }>;
}

const tradingActivities = proxyActivities<TradingActivities>({
  startToCloseTimeout: '2 minutes',
  retry: {
    initialInterval: '1s',
    backoffCoefficient: 2,
    maximumInterval: '30s',
    maximumAttempts: 3,
  },
});

/**
 * Automated Trading Workflow Input
 */
export interface AutomatedTradingWorkflowInput {
  userId: number;
  assetId: number;
  strategy: 'sell_excess' | 'buy_deficit' | 'arbitrage';
  /** When set, the strategy row's guardrails are enforced before any trade. */
  strategyId?: number;
  maxPrice?: number; // Maximum price willing to pay (for buying)
  minPrice?: number; // Minimum price willing to accept (for selling)
  maxQuantity?: number; // kWh
  timeWindow?: {
    start: Date;
    end: Date;
  };
}

export interface AutomatedTradingWorkflowResult {
  success: boolean;
  tradesExecuted: number;
  totalVolume: number; // kWh
  totalValue: number; // cents
  error?: string;
}

/**
 * P2P Trading Workflow Input
 */
export interface P2PTradingWorkflowInput {
  sellerId: number;
  buyerId: number;
  quantity: number; // kWh
  pricePerKwh: number; // cents
  deliveryTime: Date;
  duration: number; // hours
}

export interface P2PTradingWorkflowResult {
  success: boolean;
  tradeId?: number;
  settlementAmount?: number;
  error?: string;
}

/**
 * Automated Trading Workflow
 *
 * Monitors market conditions and executes a trade under the caller's strategy.
 * All state access is in activities; this function is orchestration only.
 */
export async function automatedTradingWorkflow(
  input: AutomatedTradingWorkflowInput
): Promise<AutomatedTradingWorkflowResult> {
  const empty = { tradesExecuted: 0, totalVolume: 0, totalValue: 0 };

  // Step 1: Available energy from real telemetry (activity).
  const availability = await tradingActivities.getAvailableEnergyActivity({
    userId: input.userId,
    assetId: input.assetId,
  });
  if (availability.error) {
    return { success: false, ...empty, error: `Available energy unknown: ${availability.error}` };
  }
  if (availability.availableEnergyKwh <= 0) {
    return { success: true, ...empty };
  }

  // Step 2: Current market price (activity; throws when no real price exists).
  const { priceCentsPerKwh: currentPrice } = await tradingActivities.getCurrentMarketPriceActivity();

  // Step 3: User trading preferences (activity).
  const prefs = await tradingActivities.getTradingPreferencesActivity({ userId: input.userId });

  // Step 4: Trade parameters from the strategy — pure orchestration logic.
  let tradeType: 'export' | 'import';
  const energyToTrade = Math.min(availability.availableEnergyKwh, input.maxQuantity || availability.availableEnergyKwh);
  const priceToUse = currentPrice;

  switch (input.strategy) {
    case 'sell_excess':
      if (input.minPrice && currentPrice < input.minPrice) {
        return { success: true, ...empty };
      }
      if (prefs?.minExportPrice && currentPrice < prefs.minExportPrice) {
        return { success: true, ...empty };
      }
      tradeType = 'export';
      break;

    case 'buy_deficit':
      if (input.maxPrice && currentPrice > input.maxPrice) {
        return { success: true, ...empty };
      }
      if (prefs?.maxImportPrice && currentPrice > prefs.maxImportPrice) {
        return { success: true, ...empty };
      }
      tradeType = 'import';
      break;

    case 'arbitrage': {
      // Buy below the recent market average, sell above it (activity reads).
      const { avgPriceCentsPerKwh: baseline } =
        await tradingActivities.getRecentAverageMarketPriceActivity({ lookbackHours: 24 });
      tradeType = currentPrice < baseline ? 'import' : 'export';
      break;
    }

    default:
      throw new Error(`Unknown strategy: ${input.strategy}`);
  }

  // Step 5: Enforce the strategy row's own guardrails before any trade is
  // created. A breach refuses loudly and is recorded as a user-visible alert.
  if (input.strategyId !== undefined) {
    const guardrails = await tradingActivities.checkStrategyGuardrailsActivity({
      strategyId: input.strategyId,
      userId: input.userId,
      tradeType,
      energyKWh: energyToTrade,
      priceCentsPerKwh: priceToUse,
      atIso: new Date().toISOString(),
    });
    if (!guardrails.allowed) {
      const reason = guardrails.reason ?? 'strategy guardrail refused this trade';
      await tradingActivities.recordGuardrailRefusalActivity({
        userId: input.userId,
        strategyId: input.strategyId,
        reason,
        energyKWh: energyToTrade,
        priceCentsPerKwh: priceToUse,
      });
      return { success: false, ...empty, error: `Guardrail refusal: ${reason}` };
    }
  }

  // Step 6: Create the trade as 'pending' (activity). It only transitions to
  // 'executed' after delivery is verified against real telemetry.
  const energyWh = Math.round(energyToTrade * 1000);
  const totalAmount = Math.round(energyToTrade * priceToUse);
  const { tradeId } = await tradingActivities.createAutomatedTradeActivity({
    userId: input.userId,
    assetId: input.assetId,
    strategy: input.strategy,
    strategyId: input.strategyId,
    tradeType,
    energyWh,
    priceCentsPerKwh: priceToUse,
    totalAmountCents: totalAmount,
  });

  // Step 7: Verify the fill against real telemetry (activity).
  const verification = await tradingActivities.verifyAssetDeliveryActivity({
    userId: input.userId,
    assetId: input.assetId,
    tradeType,
  });

  if (!verification.verified) {
    const error = `Delivery verification failed: ${verification.error}`;
    await tradingActivities.markAutomatedTradeFailedActivity({
      tradeId,
      strategy: input.strategy,
      assetId: input.assetId,
      error: verification.error ?? 'unknown verification failure',
    });
    return { success: false, ...empty, error };
  }

  await tradingActivities.markAutomatedTradeExecutedActivity({
    tradeId,
    strategy: input.strategy,
    assetId: input.assetId,
    observedAvgPowerW: verification.observedAvgPowerW,
  });

  return {
    success: true,
    tradesExecuted: 1,
    totalVolume: energyToTrade,
    totalValue: totalAmount,
  };
}

/**
 * P2P Trading Workflow
 *
 * Handles a direct peer-to-peer trade: validate, create both legs, recognise
 * the escrow (a provider-confirmed buyer payment — the platform holds no client
 * funds), wait out the delivery window, verify metered delivery, then release
 * the escrow through the settlement path. The release fails loudly when the
 * seller cannot actually be paid; nothing here logs a release and continues.
 */
export async function p2pTradingWorkflow(
  input: P2PTradingWorkflowInput
): Promise<P2PTradingWorkflowResult> {
  const totalAmount = Math.round(input.quantity * input.pricePerKwh);
  const energyWh = Math.round(input.quantity * 1000);
  const deliveryTimeIso = new Date(input.deliveryTime).toISOString();

  // Step 1: The seller must actually have the energy (activity).
  const sellerAvailability = await tradingActivities.getAvailableEnergyActivity({
    userId: input.sellerId,
    assetId: 0,
  });
  if (sellerAvailability.error) {
    return { success: false, error: `Seller energy unknown: ${sellerAvailability.error}` };
  }
  if (sellerAvailability.availableEnergyKwh < input.quantity) {
    return {
      success: false,
      error:
        `Seller does not have enough energy available: ` +
        `${sellerAvailability.availableEnergyKwh} kWh available vs ${input.quantity} kWh agreed`,
    };
  }

  // Step 2: Create both legs of the trade (activity). No funds move here.
  const { sellerTradeId, buyerTradeId } = await tradingActivities.createP2pTradePairActivity({
    sellerId: input.sellerId,
    buyerId: input.buyerId,
    energyWh,
    priceCentsPerKwh: input.pricePerKwh,
    totalAmountCents: totalAmount,
    deliveryTimeIso,
    durationHours: input.duration,
  });

  // Step 3: Escrow is a buyer payment the provider has already confirmed;
  // anything else would be the platform pretending to hold funds it never
  // received. No confirmed payment => the workflow fails loudly.
  const escrow = await tradingActivities.createEscrowActivity({
    tradeId: buyerTradeId,
    amount: totalAmount,
    buyerId: input.buyerId,
  });
  if (!escrow.success || !escrow.escrowId) {
    const error = `Escrow could not be established for trade ${buyerTradeId}: ${escrow.error ?? 'unknown escrow failure'}`;
    await tradingActivities.markP2pPairFailedActivity({ sellerTradeId, buyerTradeId, error });
    return { success: false, tradeId: sellerTradeId, error };
  }

  // Step 4: Wait out the delivery window with deterministic Temporal timers.
  const deliveryStart = new Date(input.deliveryTime);
  const deliveryEnd = new Date(deliveryStart.getTime() + input.duration * 3_600_000);
  const now = new Date();
  if (deliveryStart > now) {
    await sleep(deliveryStart.getTime() - now.getTime());
  }
  const afterStart = new Date();
  if (deliveryEnd > afterStart) {
    await sleep(deliveryEnd.getTime() - afterStart.getTime());
  }

  // Step 5: Verify metered delivery over the window (activity). No telemetry
  // or no export => not verified; escrow stays held and nothing settles.
  const verification = await tradingActivities.verifyP2PDeliveryActivity({
    sellerId: input.sellerId,
    windowStartIso: deliveryStart.toISOString(),
    windowEndIso: deliveryEnd.toISOString(),
  });

  if (!verification.verified) {
    const error = `Delivery verification failed: ${verification.error}`;
    await tradingActivities.markP2pPairFailedActivity({ sellerTradeId, buyerTradeId, error });
    return { success: false, tradeId: sellerTradeId, error };
  }

  // Delivery is verified on both legs; they stay 'pending' because the seller
  // has not been paid.
  await tradingActivities.markP2pPairDeliveredActivity({
    sellerTradeId,
    buyerTradeId,
    observedAvgPowerW: verification.observedAvgPowerW,
  });

  // Step 6: Release the escrow through the real settlement path (activity).
  // Paying the seller moves real money; when the platform cannot do it, this
  // activity refuses with the reason and the workflow fails loudly instead of
  // reporting a settlement that never happened.
  const release = await tradingActivities.releaseEscrowActivity({
    tradeId: buyerTradeId,
    escrowId: escrow.escrowId,
    sellerId: input.sellerId,
  });

  if (!release.success) {
    const error = `Escrow release failed for trade ${sellerTradeId}: ${release.error ?? 'unknown release failure'}`;
    await tradingActivities.sendTradeNotificationActivity({
      userId: input.sellerId,
      tradeId: sellerTradeId,
      type: 'trade_failed',
      message: error,
    });
    return { success: false, tradeId: sellerTradeId, settlementAmount: totalAmount, error };
  }

  await tradingActivities.sendTradeNotificationActivity({
    userId: input.sellerId,
    tradeId: sellerTradeId,
    type: 'trade_completed',
    message: `P2P trade ${sellerTradeId} settled: ${input.quantity} kWh @ ${input.pricePerKwh}c/kWh.`,
  });

  return {
    success: true,
    tradeId: sellerTradeId,
    settlementAmount: totalAmount,
  };
}

/**
 * Execute Trade Workflow (Temporal workflow type: "executeTrade")
 *
 * Executes a trade created via the trading router using the activities
 * registered on the 'trading-execution' task queue:
 * validate -> escrow -> dispatch/transfer -> release escrow -> notify.
 *
 * Exported under the exact type name the Temporal client starts
 * (server/integration/temporal-client.ts uses 'executeTrade').
 *
 * Two steps cannot complete today, and both refuse rather than pretend:
 * the escrow step recognises only a buyer payment the provider has confirmed
 * (the platform holds no client funds), and the release step cannot pay a
 * seller at all because there is no disbursement provider. A trade therefore
 * ends at 'buyer paid, seller unpaid' instead of reporting itself settled.
 */
export async function executeTrade(input: {
  tradeId: number;
  userId: number;
  tradeType: string;
  energy: number; // watt-hours
  price: number; // cents per kWh
  counterpartyId?: number;
}): Promise<{ success: boolean; escrowId?: string; transferId?: string; error?: string }> {
  const isSell = input.tradeType === 'export' || input.tradeType === 'p2p_sell' || input.tradeType === 'sell';
  const sellerId = isSell ? input.userId : input.counterpartyId;
  const buyerId = isSell ? input.counterpartyId : input.userId;

  if (!sellerId || !buyerId) {
    return {
      success: false,
      error: `Trade ${input.tradeId} cannot be executed: counterparty is required for settlement`,
    };
  }

  // escrow amount in cents: Wh -> kWh * cents/kWh
  const amount = Math.round((input.energy / 1000) * input.price);

  // Step 1: Validate both parties and seller capacity
  const validation = await tradingActivities.validateTradeActivity({
    sellerId,
    buyerId,
    energyAmount: input.energy,
    pricePerUnit: input.price,
  });

  if (!validation.valid) {
    await tradingActivities.sendTradeNotificationActivity({
      userId: input.userId,
      tradeId: input.tradeId,
      type: 'trade_failed',
      message: `Trade ${input.tradeId} validation failed: ${validation.error}`,
    });
    return { success: false, error: validation.error || 'Trade validation failed' };
  }

  // Step 2: Lock buyer's funds in escrow
  const escrow = await tradingActivities.createEscrowActivity({
    tradeId: input.tradeId,
    amount,
    buyerId,
  });

  if (!escrow.success || !escrow.escrowId) {
    return { success: false, error: escrow.error || 'Failed to create escrow' };
  }

  // Step 3: Dispatch the energy transfer. The activity publishes the dispatch
  // command via MQTT; on failure the escrow stays held and we do not settle.
  const transfer = await tradingActivities.executeEnergyTransferActivity({
    tradeId: input.tradeId,
    sellerId,
    buyerId,
    energyAmount: input.energy,
  });

  if (!transfer.success) {
    await tradingActivities.sendTradeNotificationActivity({
      userId: input.userId,
      tradeId: input.tradeId,
      type: 'trade_failed',
      message: `Trade ${input.tradeId} dispatch failed: ${transfer.error}. Escrow remains held.`,
    });
    return {
      success: false,
      escrowId: escrow.escrowId,
      error: transfer.error || 'Energy transfer dispatch failed',
    };
  }

  // Step 4: Dispatch confirmed — release escrow to the seller
  const release = await tradingActivities.releaseEscrowActivity({
    tradeId: input.tradeId,
    escrowId: escrow.escrowId,
    sellerId,
  });

  if (!release.success) {
    return {
      success: false,
      escrowId: escrow.escrowId,
      transferId: transfer.transferId,
      error: release.error || 'Escrow release failed',
    };
  }

  await tradingActivities.sendTradeNotificationActivity({
    userId: input.userId,
    tradeId: input.tradeId,
    type: 'trade_completed',
    message: `Trade ${input.tradeId} executed and settled (${input.energy}Wh @ ${input.price}c/kWh).`,
  });

  return { success: true, escrowId: escrow.escrowId, transferId: transfer.transferId };
}

// NOTE: `marketMakingWorkflow` was removed. It had no caller anywhere in the
// repository, and it did direct database writes (db.insert) inside workflow
// code, which the Temporal workflow sandbox forbids — had it ever been
// dispatched it would have failed at runtime. Reintroduce market making as
// activities, not in-workflow I/O, behind a real trigger.

/**
 * Workflow Configuration
 */
export const TRADING_WORKFLOW_CONFIG = {
  taskQueue: 'trading-execution',
  retryPolicy: {
    initialInterval: '1s',
    backoffCoefficient: 2,
    maximumInterval: '30s',
    maximumAttempts: 3,
  },
  workflowExecutionTimeout: '1h',
  workflowRunTimeout: '30m',
  workflowTaskTimeout: '30s',
};
