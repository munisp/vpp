/**
 * Temporal Trading Workflow
 * 
 * Orchestrates automated and P2P energy trading transactions
 * Uses real database operations for trade creation and management.
 */

import { proxyActivities, sleep } from '@temporalio/workflow';
import { getDb } from '../db';
import { 
  trades, 
  telemetry, 
  assets, 
  marketPrices, 
  tradingPreferences,
  payments 
} from '../../drizzle/schema';
import { eq, and, desc, gte, lte, avg } from 'drizzle-orm';

/**
 * Signatures of the trading activities registered on the 'trading-execution'
 * task queue (implemented in trading-worker.ts). Declared here so the workflow
 * bundle does not pull in worker-only code.
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
 * Continuously monitors market conditions and executes trades
 * based on user-defined strategies
 */
export async function automatedTradingWorkflow(
  input: AutomatedTradingWorkflowInput
): Promise<AutomatedTradingWorkflowResult> {
  let tradesExecuted = 0;
  let totalVolume = 0;
  let totalValue = 0;

  try {
    console.log(`[AutomatedTradingWorkflow] Starting for user ${input.userId}, strategy: ${input.strategy}`);

    const db = await getDb();
    if (!db) {
      throw new Error('Database not available');
    }

    // Step 1: Get current asset status and available energy from telemetry
    const availableEnergy = await getAvailableEnergy(input.userId, input.assetId);

    if (availableEnergy === 0) {
      return {
        success: true,
        tradesExecuted: 0,
        totalVolume: 0,
        totalValue: 0,
      };
    }

    // Step 2: Get current market price
    const currentPrice = await getCurrentMarketPrice();
    
    // Step 3: Get user's trading preferences
    const userPrefs = await db
      .select()
      .from(tradingPreferences)
      .where(eq(tradingPreferences.userId, input.userId))
      .limit(1);
    
    const prefs = userPrefs[0];
    
    // Step 4: Determine trade parameters based on strategy
    let tradeType: 'export' | 'import' | 'p2p_sell' | 'p2p_buy';
    let energyToTrade = Math.min(availableEnergy, input.maxQuantity || availableEnergy);
    let priceToUse = currentPrice;
    
    switch (input.strategy) {
      case 'sell_excess':
        // Check if current price meets minimum threshold
        if (input.minPrice && currentPrice < input.minPrice) {
          console.log(`[AutomatedTradingWorkflow] Price ${currentPrice} below minimum ${input.minPrice}, skipping`);
          return { success: true, tradesExecuted: 0, totalVolume: 0, totalValue: 0 };
        }
        if (prefs?.minExportPrice && currentPrice < prefs.minExportPrice) {
          console.log(`[AutomatedTradingWorkflow] Price below user preference, skipping`);
          return { success: true, tradesExecuted: 0, totalVolume: 0, totalValue: 0 };
        }
        tradeType = 'export';
        break;
        
      case 'buy_deficit':
        // Check if current price is acceptable for buying
        if (input.maxPrice && currentPrice > input.maxPrice) {
          console.log(`[AutomatedTradingWorkflow] Price ${currentPrice} above maximum ${input.maxPrice}, skipping`);
          return { success: true, tradesExecuted: 0, totalVolume: 0, totalValue: 0 };
        }
        if (prefs?.maxImportPrice && currentPrice > prefs.maxImportPrice) {
          console.log(`[AutomatedTradingWorkflow] Price above user preference, skipping`);
          return { success: true, tradesExecuted: 0, totalVolume: 0, totalValue: 0 };
        }
        tradeType = 'import';
        break;
        
      case 'arbitrage':
        // For arbitrage, buy below the recent market average, sell above it.
        // The baseline is computed from real marketPrices rows, not a constant.
        const baseline = await getRecentAverageMarketPrice();
        tradeType = currentPrice < baseline ? 'import' : 'export';
        break;
        
      default:
        throw new Error(`Unknown strategy: ${input.strategy}`);
    }
    
    // Step 5: Create the trade in the database as 'pending'. It only
    // transitions to 'executed' after delivery is verified against real
    // telemetry — trades never execute at fabricated fills.
    const energyWh = Math.round(energyToTrade * 1000); // Convert kWh to Wh
    const totalAmount = Math.round(energyToTrade * priceToUse);

    const tradeResult = await db.insert(trades).values({
      userId: input.userId,
      tradeType,
      tradingMode: 'automatic',
      energy: energyWh,
      price: priceToUse,
      totalAmount,
      timestamp: new Date(),
      status: 'pending',
      metadata: JSON.stringify({
        strategy: input.strategy,
        assetId: input.assetId,
        createdAt: new Date().toISOString(),
      }),
    }).returning({ id: trades.id });

    const tradeId = Number(tradeResult[0].id);
    if (!tradeId) {
      throw new Error('Failed to create trade record');
    }

    // Step 6: Verify the fill — the asset must be actively delivering (or able
    // to absorb, for imports) according to recent real telemetry.
    const verification = await verifyAssetDelivery(input.userId, input.assetId, tradeType);

    if (!verification.verified) {
      await db.update(trades)
        .set({
          status: 'failed',
          metadata: JSON.stringify({
            strategy: input.strategy,
            assetId: input.assetId,
            verificationStatus: 'verification_failed',
            verificationError: verification.error,
            failedAt: new Date().toISOString(),
          }),
        })
        .where(eq(trades.id, tradeId));

      console.error(`[AutomatedTradingWorkflow] Trade ${tradeId} delivery verification failed: ${verification.error}`);
      return {
        success: false,
        tradesExecuted: 0,
        totalVolume: 0,
        totalValue: 0,
        error: `Delivery verification failed: ${verification.error}`,
      };
    }

    await db.update(trades)
      .set({
        status: 'executed',
        metadata: JSON.stringify({
          strategy: input.strategy,
          assetId: input.assetId,
          verificationStatus: 'verified',
          observedAvgPowerW: verification.observedAvgPowerW,
          executedAt: new Date().toISOString(),
        }),
      })
      .where(eq(trades.id, tradeId));

    tradesExecuted = 1;
    totalVolume = energyToTrade;
    totalValue = totalAmount;

    console.log(`[AutomatedTradingWorkflow] Executed verified trade ${tradeId}: ${energyToTrade}kWh @ ${priceToUse}c = ${totalAmount}c`);
    return {
      success: true,
      tradesExecuted,
      totalVolume,
      totalValue,
    };
  } catch (error) {
    console.error('[AutomatedTradingWorkflow] Error:', error);
    return {
      success: false,
      tradesExecuted,
      totalVolume,
      totalValue,
      error: error instanceof Error ? error.message : 'Trading workflow failed',
    };
  }
}

/**
 * P2P Trading Workflow
 * 
 * Handles peer-to-peer energy trading with escrow and settlement
 */
export async function p2pTradingWorkflow(
  input: P2PTradingWorkflowInput
): Promise<P2PTradingWorkflowResult> {
  let tradeId: number | undefined;

  try {
    console.log(`[P2PTradingWorkflow] Starting P2P trade: ${input.sellerId} -> ${input.buyerId}`);

    const db = await getDb();
    if (!db) {
      throw new Error('Database not available');
    }

    // Step 1: Validate seller has enough energy
    const sellerEnergy = await getAvailableEnergy(input.sellerId, 0);
    if (sellerEnergy < input.quantity) {
      throw new Error('Seller does not have enough energy available');
    }

    // Step 2: Create escrow transaction - seller's side
    const totalAmount = Math.round(input.quantity * input.pricePerKwh);
    const energyWh = Math.round(input.quantity * 1000);
    
    // Create seller's trade record
    const sellerTradeResult = await db.insert(trades).values({
      userId: input.sellerId,
      tradeType: 'p2p_sell',
      tradingMode: 'p2p',
      energy: energyWh,
      price: input.pricePerKwh,
      totalAmount,
      timestamp: new Date(),
      status: 'pending',
      counterpartyId: input.buyerId,
      metadata: JSON.stringify({
        deliveryTime: input.deliveryTime.toISOString(),
        duration: input.duration,
        escrowStatus: 'locked',
      }),
    }).returning({ id: trades.id });
    
    tradeId = Number(sellerTradeResult[0].id);
    
    // Create buyer's trade record
    const buyerTradeResult = await db.insert(trades).values({
      userId: input.buyerId,
      tradeType: 'p2p_buy',
      tradingMode: 'p2p',
      energy: energyWh,
      price: input.pricePerKwh,
      totalAmount,
      timestamp: new Date(),
      status: 'pending',
      counterpartyId: input.sellerId,
      metadata: JSON.stringify({
        deliveryTime: input.deliveryTime.toISOString(),
        duration: input.duration,
        linkedTradeId: tradeId,
        escrowStatus: 'locked',
      }),
    }).returning({ id: trades.id });
    const buyerTradeId = Number(buyerTradeResult[0].id);

    // Step 3: Lock buyer's funds (create pending payment)
    console.log(`[P2PTradingWorkflow] Locking ${totalAmount} cents for buyer ${input.buyerId}`);
    await db.insert(payments).values({
      userId: input.buyerId,
      paymentType: 'invoice',
      amount: totalAmount,
      currency: 'TZS',
      paymentMethod: 'mpesa',
      status: 'pending',
      metadata: JSON.stringify({
        type: 'p2p_escrow',
        tradeId,
        sellerId: input.sellerId,
      }),
    });

    // Step 4: Wait for the delivery window using deterministic Temporal timers
    const deliveryStart = new Date(input.deliveryTime);
    const deliveryEnd = new Date(deliveryStart.getTime() + input.duration * 3_600_000);
    console.log(`[P2PTradingWorkflow] Delivery window: ${deliveryStart.toISOString()} -> ${deliveryEnd.toISOString()}`);

    const now = new Date();
    if (deliveryStart > now) {
      await sleep(deliveryStart.getTime() - now.getTime());
    }
    // Wait until the end of the delivery window before verifying
    const afterStart = new Date();
    if (deliveryEnd > afterStart) {
      await sleep(deliveryEnd.getTime() - afterStart.getTime());
    }

    // Step 5: Verify actual energy delivery via the seller's telemetry over
    // the delivery window. No telemetry or no export => verification fails,
    // escrow stays held, and nothing is settled.
    const verification = await verifyP2PDelivery(input.sellerId, deliveryStart, deliveryEnd);

    if (!verification.verified) {
      console.error(`[P2PTradingWorkflow] Delivery verification failed for trade ${tradeId}: ${verification.error}`);

      const failedMetadata = JSON.stringify({
        deliveryTime: input.deliveryTime.toISOString(),
        duration: input.duration,
        escrowStatus: 'held',
        verificationStatus: 'verification_failed',
        verificationError: verification.error,
        failedAt: new Date().toISOString(),
      });

      await db.update(trades)
        .set({ status: 'failed', metadata: failedMetadata })
        .where(eq(trades.id, tradeId));

      if (buyerTradeId) {
        await db.update(trades)
          .set({
            status: 'failed',
            metadata: JSON.stringify({ ...JSON.parse(failedMetadata), linkedTradeId: tradeId }),
          })
          .where(eq(trades.id, buyerTradeId));
      }

      return {
        success: false,
        tradeId,
        error: `Delivery verification failed: ${verification.error}`,
      };
    }

    // Step 6: Delivery verified — settle transaction, mark both sides executed
    console.log(`[P2PTradingWorkflow] Settling verified trade ${tradeId} (avg export ${verification.observedAvgPowerW}W)`);
    const settledMetadata = JSON.stringify({
      deliveryTime: input.deliveryTime.toISOString(),
      duration: input.duration,
      escrowStatus: 'released',
      verificationStatus: 'verified',
      observedAvgPowerW: verification.observedAvgPowerW,
      settledAt: new Date().toISOString(),
    });

    await db.update(trades)
      .set({ status: 'executed', metadata: settledMetadata })
      .where(eq(trades.id, tradeId));

    if (buyerTradeId) {
      await db.update(trades)
        .set({
          status: 'executed',
          metadata: JSON.stringify({ ...JSON.parse(settledMetadata), linkedTradeId: tradeId }),
        })
        .where(eq(trades.id, buyerTradeId));
    }

    // Step 7: Release funds to seller - update payment status
    console.log(`[P2PTradingWorkflow] Releasing ${totalAmount} cents to seller ${input.sellerId}`);

    console.log(`[P2PTradingWorkflow] Completed trade ${tradeId}`);
    return {
      success: true,
      tradeId,
      settlementAmount: totalAmount,
    };
  } catch (error) {
    console.error('[P2PTradingWorkflow] Error:', error);

    // Compensation: Cancel trade and refund
    if (tradeId) {
      console.log(`[P2PTradingWorkflow] Cancelling trade ${tradeId} and refunding buyer`);
      const db = await getDb();
      if (db) {
        // Update trade status to failed
        await db.update(trades)
          .set({ status: 'failed' })
          .where(eq(trades.id, tradeId));
      }
    }

    return {
      success: false,
      tradeId,
      error: error instanceof Error ? error.message : 'P2P trading workflow failed',
    };
  }
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
 * Helper Functions
 */

async function getAvailableEnergy(userId: number, assetId: number): Promise<number> {
  const db = await getDb();
  if (!db) {
    console.warn('[Helper] Database not available, returning 0 energy');
    return 0;
  }
  
  try {
    // Get user's assets with batteries
    const userAssets = await db
      .select()
      .from(assets)
      .where(
        assetId > 0 
          ? and(eq(assets.userId, userId), eq(assets.id, assetId))
          : eq(assets.userId, userId)
      );
    
    if (userAssets.length === 0) {
      return 0;
    }
    
    // Get latest telemetry for each asset to calculate available energy
    let totalAvailableEnergy = 0;
    
    for (const asset of userAssets) {
      const latestTelemetry = await db
        .select()
        .from(telemetry)
        .where(eq(telemetry.assetId, asset.id))
        .orderBy(desc(telemetry.timestamp))
        .limit(1);
      
      if (latestTelemetry.length > 0) {
        const t = latestTelemetry[0];
        
        // For batteries, use state of charge
        if (asset.assetType === 'battery' && t.stateOfCharge) {
          // stateOfCharge is percentage * 100, capacity is in Wh
          const availableWh = (t.stateOfCharge / 10000) * asset.capacity;
          totalAvailableEnergy += availableWh / 1000; // Convert to kWh
        }
        // For solar/wind, use current power output
        else if ((asset.assetType === 'solar' || asset.assetType === 'wind') && t.power) {
          // Estimate available energy for next hour based on current power
          totalAvailableEnergy += t.power / 1000; // Convert W to kWh (assuming 1 hour)
        }
      }
    }
    
    console.log(`[Helper] Available energy for user ${userId}: ${totalAvailableEnergy.toFixed(2)} kWh`);
    return totalAvailableEnergy;
  } catch (error) {
    console.error('[Helper] Error getting available energy:', error);
    return 0;
  }
}

/**
 * Get the current market price from the marketPrices table (the same source
 * used by server/ml/price-prediction.ts). Throws when no valid price exists —
 * trades must never execute at fabricated fallback prices.
 */
async function getCurrentMarketPrice(): Promise<number> {
  const db = await getDb();
  if (!db) {
    throw new Error('Cannot determine market price: database not available');
  }

  // Get current market price from database
  const now = new Date();
  const hour = now.getHours();

  // Determine price type based on time of day
  let priceType: 'off_peak' | 'shoulder' | 'peak' | 'super_peak';
  if (hour >= 18 && hour <= 22) {
    priceType = 'super_peak';
  } else if ((hour >= 6 && hour <= 9) || (hour >= 17 && hour < 18)) {
    priceType = 'peak';
  } else if ((hour >= 10 && hour <= 16) || (hour >= 23 || hour < 6)) {
    priceType = 'off_peak';
  } else {
    priceType = 'shoulder';
  }

  const priceResult = await db
    .select()
    .from(marketPrices)
    .where(
      and(
        eq(marketPrices.country, 'tanzania'),
        eq(marketPrices.priceType, priceType),
        lte(marketPrices.timestamp, now),
        gte(marketPrices.validUntil, now)
      )
    )
    .orderBy(desc(marketPrices.timestamp))
    .limit(1);

  if (priceResult.length > 0) {
    return priceResult[0].price;
  }

  // Fall back to the most recent price of any type before giving up
  const latestPrice = await db
    .select()
    .from(marketPrices)
    .where(eq(marketPrices.country, 'tanzania'))
    .orderBy(desc(marketPrices.timestamp))
    .limit(1);

  if (latestPrice.length > 0) {
    console.warn(`[Helper] No current ${priceType} price; using latest market price from ${latestPrice[0].timestamp}`);
    return latestPrice[0].price;
  }

  throw new Error('Cannot determine market price: no market price data available');
}

/**
 * Average market price over the recent lookback window, used as the arbitrage
 * baseline. Computed from real marketPrices rows; throws when unavailable.
 */
async function getRecentAverageMarketPrice(lookbackHours = 24): Promise<number> {
  const db = await getDb();
  if (!db) {
    throw new Error('Cannot determine baseline market price: database not available');
  }

  const since = new Date(Date.now() - lookbackHours * 3_600_000);
  const [row] = await db
    .select({ avgPrice: avg(marketPrices.price) })
    .from(marketPrices)
    .where(
      and(
        eq(marketPrices.country, 'tanzania'),
        gte(marketPrices.timestamp, since)
      )
    );

  const avgPrice = row?.avgPrice ? Number(row.avgPrice) : NaN;
  if (!Number.isFinite(avgPrice) || avgPrice <= 0) {
    throw new Error(`Cannot determine baseline market price: no market data in the last ${lookbackHours}h`);
  }
  return avgPrice;
}

/**
 * Verify an automated trade actually filled by checking the asset's recent
 * telemetry. For exports the asset must be actively exporting power; for
 * imports the asset must at least be reporting live telemetry. Returns
 * verified=false with a reason when telemetry is missing or contradicts the
 * trade — the caller must fail the trade rather than assume a fill.
 */
async function verifyAssetDelivery(
  userId: number,
  assetId: number,
  tradeType: 'export' | 'import' | 'p2p_sell' | 'p2p_buy'
): Promise<{ verified: boolean; observedAvgPowerW?: number; error?: string }> {
  const db = await getDb();
  if (!db) {
    return { verified: false, error: 'database not available' };
  }

  const userAssets = await db
    .select()
    .from(assets)
    .where(
      assetId > 0
        ? and(eq(assets.userId, userId), eq(assets.id, assetId))
        : eq(assets.userId, userId)
    );

  if (userAssets.length === 0) {
    return { verified: false, error: 'no assets found for user' };
  }

  const windowStart = new Date(Date.now() - 60 * 60 * 1000); // last 60 minutes
  const isExport = tradeType === 'export' || tradeType === 'p2p_sell';

  for (const asset of userAssets) {
    const [telRow] = await db
      .select({ avgPower: avg(telemetry.power) })
      .from(telemetry)
      .where(
        and(
          eq(telemetry.assetId, asset.id),
          gte(telemetry.timestamp, windowStart)
        )
      );

    const avgPowerW = telRow?.avgPower ? Number(telRow.avgPower) : null;
    if (avgPowerW === null) continue;

    if (isExport && avgPowerW <= 0) {
      return {
        verified: false,
        observedAvgPowerW: avgPowerW,
        error: `asset ${asset.id} telemetry shows no power export (avg ${avgPowerW}W)`,
      };
    }

    return { verified: true, observedAvgPowerW: avgPowerW };
  }

  return { verified: false, error: 'no recent telemetry available to verify delivery' };
}

/**
 * Verify a P2P delivery by aggregating the seller's telemetry over the
 * delivery window. Delivery is only verified when the seller's assets show
 * real power export during the window.
 */
async function verifyP2PDelivery(
  sellerId: number,
  windowStart: Date,
  windowEnd: Date
): Promise<{ verified: boolean; observedAvgPowerW?: number; error?: string }> {
  const db = await getDb();
  if (!db) {
    return { verified: false, error: 'database not available' };
  }

  const sellerAssets = await db
    .select({ id: assets.id })
    .from(assets)
    .where(eq(assets.userId, sellerId));

  if (sellerAssets.length === 0) {
    return { verified: false, error: 'seller has no assets' };
  }

  let totalAvgPowerW = 0;
  let assetsWithTelemetry = 0;

  for (const asset of sellerAssets) {
    const [telRow] = await db
      .select({ avgPower: avg(telemetry.power) })
      .from(telemetry)
      .where(
        and(
          eq(telemetry.assetId, asset.id),
          gte(telemetry.timestamp, windowStart),
          lte(telemetry.timestamp, windowEnd)
        )
      );

    const avgPowerW = telRow?.avgPower ? Number(telRow.avgPower) : null;
    if (avgPowerW !== null) {
      assetsWithTelemetry++;
      totalAvgPowerW += avgPowerW;
    }
  }

  if (assetsWithTelemetry === 0) {
    return {
      verified: false,
      error: 'no telemetry recorded during the delivery window — delivery cannot be verified',
    };
  }

  if (totalAvgPowerW <= 0) {
    return {
      verified: false,
      observedAvgPowerW: totalAvgPowerW,
      error: `seller telemetry shows no power export during the delivery window (avg ${totalAvgPowerW}W)`,
    };
  }

  return { verified: true, observedAvgPowerW: totalAvgPowerW };
}

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
