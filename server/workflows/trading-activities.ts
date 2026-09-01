/**
 * Activities for the trading workflow.
 *
 * Kept out of the worker entrypoint so they can be exercised without starting a
 * Temporal worker: `trading-worker.ts` connects and runs on import.
 */

/**
 * Trade metadata carries match, payment, dispatch and control-window evidence.
 * Activities merge into it: replacing it wholesale erased the evidence written
 * by the step before.
 */
function mergeTradeMetadata(existing: string | null, patch: Record<string, unknown>): string {
  let base: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      if (parsed && typeof parsed === 'object') base = parsed as Record<string, unknown>;
    } catch {
      base = {};
    }
  }
  return JSON.stringify({ ...base, ...patch });
}

/**
 * Sum the energy a user's automatic trades already carry today (UTC), so a
 * strategy's daily volume guardrail is checked against what the day has
 * actually committed, per strategy when the trade names one.
 */
async function sumTodaysStrategyEnergyKwh(
  db: any,
  userId: number,
  strategyId: number | null
): Promise<number> {
  const { trades } = await import('../../drizzle/schema');
  const { and, eq, gte, sql } = await import('drizzle-orm');

  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);

  const conditions = [
    eq(trades.userId, userId),
    eq(trades.tradingMode, 'automatic'),
    gte(trades.createdAt, dayStart),
    // Cancelled/failed trades committed nothing.
    sql`${trades.status} IN ('pending', 'executed')`,
  ];
  if (strategyId !== null) {
    conditions.push(sql`${trades.metadata}::jsonb ->> 'strategyId' = ${String(strategyId)}`);
  }

  const rows = await db
    .select({ total: sql<number>`COALESCE(SUM(${trades.energy}), 0)` })
    .from(trades)
    .where(and(...conditions));

  return Number(rows[0]?.total ?? 0) / 1000; // Wh -> kWh
}

// Trading activities - inline since trading-workflow.ts has activities embedded
export const tradingActivities = {
  async validateTradeActivity(input: {
    sellerId: number;
    buyerId: number;
    energyAmount: number;
    pricePerUnit: number;
  }): Promise<{ valid: boolean; error?: string }> {
    try {
      const { getDb } = await import('../db');
      const { users, assets } = await import('../../drizzle/schema');
      const { eq, and, sum } = await import('drizzle-orm');

      const db = await getDb();
      if (!db) throw new Error('Database not available');

      // Validate seller exists
      const sellers = await db.select().from(users).where(eq(users.id, input.sellerId));
      if (sellers.length === 0) {
        return { valid: false, error: 'Seller not found' };
      }

      // Validate buyer exists
      const buyers = await db.select().from(users).where(eq(users.id, input.buyerId));
      if (buyers.length === 0) {
        return { valid: false, error: 'Buyer not found' };
      }

      // Validate seller has enough energy capacity
      const sellerAssets = await db
        .select({ totalCapacity: sum(assets.capacity) })
        .from(assets)
        .where(and(eq(assets.userId, input.sellerId), eq(assets.status, 'active')));

      const totalCapacity = Number(sellerAssets[0]?.totalCapacity || 0);
      if (totalCapacity < input.energyAmount) {
        return { valid: false, error: 'Insufficient energy capacity' };
      }

      console.log(`[TradingActivity] Trade validated: ${input.energyAmount} kWh from user ${input.sellerId} to ${input.buyerId}`);
      return { valid: true };
    } catch (error) {
      console.error('[TradingActivity] Validation error:', error);
      return { valid: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  },

  async createEscrowActivity(input: {
    tradeId: number;
    amount: number;
    buyerId: number;
  }): Promise<{ success: boolean; escrowId?: string; error?: string }> {
    try {
      const { getDb } = await import('../db');
      const { payments, trades } = await import('../../drizzle/schema');
      const { and, eq } = await import('drizzle-orm');

      const db = await getDb();
      if (!db) throw new Error('Database not available');

      // The buyer was charged the trade's stored total, so that is what a
      // confirmed payment has to match. Comparing against a caller's re-derived
      // figure fails a validly paid trade whenever the two roundings differ.
      const [trade] = await db
        .select({ totalAmount: trades.totalAmount, metadata: trades.metadata })
        .from(trades)
        .where(eq(trades.id, input.tradeId))
        .limit(1);

      if (!trade) {
        return { success: false, error: `Trade ${input.tradeId} does not exist.` };
      }

      // The platform holds no client funds: there is no custody account and no
      // ledger that can debit a buyer. Writing an escrow id into metadata held
      // nothing while reporting success, so the only honest hold is a buyer
      // payment the provider has already confirmed.
      const [payment] = await db
        .select({ id: payments.id, amount: payments.amount })
        .from(payments)
        .where(
          and(
            eq(payments.p2pTradeId, input.tradeId),
            eq(payments.userId, input.buyerId),
            eq(payments.status, 'completed')
          )
        )
        .limit(1);

      if (!payment) {
        return {
          success: false,
          error: `No confirmed buyer payment exists for trade ${input.tradeId}; the platform cannot hold funds it never received.`,
        };
      }
      if (payment.amount !== trade.totalAmount) {
        return {
          success: false,
          error: `Buyer payment ${payment.id} settled ${payment.amount} cents but trade ${input.tradeId} owes ${trade.totalAmount} cents.`,
        };
      }

      const escrowId = `PAYMENT-${payment.id}`;
      await db.update(trades).set({
        status: 'pending', // Paid by the buyer, not yet complete: the seller is unpaid.
        metadata: mergeTradeMetadata(trade.metadata ?? null, {
          escrowId,
          escrowKind: 'provider_confirmed_buyer_payment',
          escrowAmount: payment.amount,
          buyerPaymentId: payment.id,
          stage: 'buyer_paid',
        }),
      }).where(eq(trades.id, input.tradeId));

      console.log(`[TradingActivity] Buyer payment ${payment.id} recognised as the hold for trade ${input.tradeId}`);
      return { success: true, escrowId };
    } catch (error) {
      console.error('[TradingActivity] Escrow error:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  },

  async executeEnergyTransferActivity(input: {
    tradeId: number;
    sellerId: number;
    buyerId: number;
    energyAmount: number;
  }): Promise<{ success: boolean; transferId?: string; error?: string }> {
    try {
      const { executeEnergyTransfer } = await import('./p2p-transfer-dispatch');
      return await executeEnergyTransfer(input);
    } catch (error) {
      console.error('[TradingActivity] Transfer error:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  },

  async releaseEscrowActivity(input: {
    tradeId: number;
    escrowId: string;
    sellerId: number;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      const { getDb } = await import('../db');
      const { trades } = await import('../../drizzle/schema');
      const { eq } = await import('drizzle-orm');
      const { assertSellerPayoutAvailable } = await import('../services/p2p-settlement');

      const db = await getDb();
      if (!db) throw new Error('Database not available');

      // Paying the seller moves real money out of the platform and no
      // disbursement provider is wired to do it. Marking the trade 'executed'
      // here paid nobody while booking the seller's earnings, so the trade
      // records what it owes and the activity refuses.
      const [existing] = await db
        .select({ metadata: trades.metadata })
        .from(trades)
        .where(eq(trades.id, input.tradeId))
        .limit(1);
      await db.update(trades).set({
        metadata: mergeTradeMetadata(existing?.metadata ?? null, {
          escrowId: input.escrowId,
          sellerPayout: 'unavailable_no_provider',
          sellerPayoutOwedTo: input.sellerId,
          stage: 'buyer_paid_awaiting_seller_payout',
        }),
      }).where(eq(trades.id, input.tradeId));

      try {
        assertSellerPayoutAvailable({ tradeId: input.tradeId, sellerId: input.sellerId });
      } catch (refusal) {
        const error = refusal instanceof Error ? refusal.message : String(refusal);
        console.error(`[TradingActivity] ${error}`);
        return { success: false, error };
      }
      return { success: false, error: 'Seller payout unavailable' };
    } catch (error) {
      console.error('[TradingActivity] Escrow release error:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  },

  async sendTradeNotificationActivity(input: {
    userId: number;
    tradeId: number;
    type: 'trade_created' | 'trade_completed' | 'trade_failed';
    message: string;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      const { sendPushNotification } = await import('../_core/sendNotification');
      const { getDb } = await import('../db');
      const { alerts } = await import('../../drizzle/schema');

      const db = await getDb();
      if (!db) throw new Error('Database not available');

      // Send push notification
      await sendPushNotification(
        input.userId,
        {
          title: input.type === 'trade_completed' ? 'Trade Completed' : 
                 input.type === 'trade_failed' ? 'Trade Failed' : 'Trade Created',
          body: input.message,
          data: { type: 'trade', tradeId: input.tradeId },
        },
        'pushSystemAlert'
      );

      // Create in-app alert
      await db.insert(alerts).values({
        userId: input.userId,
        alertType: 'system',
        severity: input.type === 'trade_failed' ? 'warning' : 'info',
        title: input.type === 'trade_completed' ? 'Trade Completed' : 
               input.type === 'trade_failed' ? 'Trade Failed' : 'Trade Created',
        message: input.message,
        metadata: JSON.stringify({ tradeId: input.tradeId, type: input.type }),
        createdAt: new Date(),
      });

      // Email honoring the user's email preferences: a user who disabled the
      // category gets no email, and the skip is recorded by the sender.
      const { sendEmailNotification } = await import('../_core/sendNotification');
      const { users } = await import('../../drizzle/schema');
      const { eq } = await import('drizzle-orm');

      const [recipient] = await db
        .select({ email: users.email, name: users.name })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1);

      if (recipient?.email) {
        const title =
          input.type === 'trade_completed' ? 'Trade Completed' :
          input.type === 'trade_failed' ? 'Trade Failed' : 'Trade Created';
        const preferenceKey =
          input.type === 'trade_completed' ? 'emailTradeExecuted' as const :
          input.type === 'trade_failed' ? 'emailTradeFailed' as const :
          'emailSystemAlert' as const;
        await sendEmailNotification(
          input.userId,
          {
            to: recipient.email,
            subject: `${title}: trade #${input.tradeId}`,
            html: `<p>Hello ${recipient.name ?? 'there'},</p><p>${input.message}</p>`,
            text: input.message,
          },
          preferenceKey
        );
      }

      console.log(`[TradingActivity] Notification sent to user ${input.userId}`);
      return { success: true };
    } catch (error) {
      console.error('[TradingActivity] Notification error:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  },

  /**
   * Available energy (kWh) across the user's assets, from the latest real
   * telemetry per asset: battery state of charge against capacity, or current
   * solar/wind output as the next hour's energy. No telemetry means nothing is
   * available — never an assumed value.
   */
  async getAvailableEnergyActivity(input: {
    userId: number;
    assetId: number;
  }): Promise<{ availableEnergyKwh: number; error?: string }> {
    const { getDb } = await import('../db');
    const { assets, telemetry } = await import('../../drizzle/schema');
    const { and, desc, eq } = await import('drizzle-orm');

    const db = await getDb();
    if (!db) return { availableEnergyKwh: 0, error: 'database not available' };

    const userAssets = await db
      .select()
      .from(assets)
      .where(
        input.assetId > 0
          ? and(eq(assets.userId, input.userId), eq(assets.id, input.assetId))
          : eq(assets.userId, input.userId)
      );

    let totalKwh = 0;
    for (const asset of userAssets) {
      const latest = await db
        .select()
        .from(telemetry)
        .where(eq(telemetry.assetId, asset.id))
        .orderBy(desc(telemetry.timestamp))
        .limit(1);

      const t = latest[0];
      if (!t) continue;
      if (asset.assetType === 'battery' && t.stateOfCharge) {
        totalKwh += ((t.stateOfCharge / 10000) * asset.capacity) / 1000;
      } else if ((asset.assetType === 'solar' || asset.assetType === 'wind') && t.power) {
        totalKwh += t.power / 1000;
      }
    }
    return { availableEnergyKwh: totalKwh };
  },

  /**
   * The current market price from marketPrices rows for the active time-of-use
   * band. Throws when no real price exists — a trade must never execute at a
   * fabricated fallback price.
   */
  async getCurrentMarketPriceActivity(): Promise<{ priceCentsPerKwh: number }> {
    const { getDb } = await import('../db');
    const { marketPrices } = await import('../../drizzle/schema');
    const { and, desc, eq, gte, lte } = await import('drizzle-orm');

    const db = await getDb();
    if (!db) throw new Error('Cannot determine market price: database not available');

    const now = new Date();
    const hour = now.getHours();
    let priceType: 'off_peak' | 'shoulder' | 'peak' | 'super_peak';
    if (hour >= 18 && hour <= 22) priceType = 'super_peak';
    else if ((hour >= 6 && hour <= 9) || (hour >= 17 && hour < 18)) priceType = 'peak';
    else if (hour >= 10 && hour <= 16) priceType = 'off_peak';
    else if (hour >= 23 || hour < 6) priceType = 'off_peak';
    else priceType = 'shoulder';

    const priced = await db
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
    if (priced.length > 0) return { priceCentsPerKwh: priced[0].price };

    const latest = await db
      .select()
      .from(marketPrices)
      .where(eq(marketPrices.country, 'tanzania'))
      .orderBy(desc(marketPrices.timestamp))
      .limit(1);
    if (latest.length > 0) {
      console.warn(`[TradingActivity] No current ${priceType} price; using latest market price from ${latest[0].timestamp}`);
      return { priceCentsPerKwh: latest[0].price };
    }
    throw new Error('Cannot determine market price: no market price data available');
  },

  /** Average market price over a lookback window; throws when unavailable. */
  async getRecentAverageMarketPriceActivity(input: {
    lookbackHours?: number;
  }): Promise<{ avgPriceCentsPerKwh: number }> {
    const { getDb } = await import('../db');
    const { marketPrices } = await import('../../drizzle/schema');
    const { and, avg, eq, gte } = await import('drizzle-orm');

    const db = await getDb();
    if (!db) throw new Error('Cannot determine baseline market price: database not available');

    const lookbackHours = input.lookbackHours ?? 24;
    const since = new Date(Date.now() - lookbackHours * 3_600_000);
    const [row] = await db
      .select({ avgPrice: avg(marketPrices.price) })
      .from(marketPrices)
      .where(and(eq(marketPrices.country, 'tanzania'), gte(marketPrices.timestamp, since)));

    const avgPrice = row?.avgPrice ? Number(row.avgPrice) : NaN;
    if (!Number.isFinite(avgPrice) || avgPrice <= 0) {
      throw new Error(`Cannot determine baseline market price: no market data in the last ${lookbackHours}h`);
    }
    return { avgPriceCentsPerKwh: avgPrice };
  },

  /** The caller's stored trading preferences, or null when none exist. */
  async getTradingPreferencesActivity(input: {
    userId: number;
  }): Promise<{ minExportPrice: number | null; maxImportPrice: number | null } | null> {
    const { getDb } = await import('../db');
    const { tradingPreferences } = await import('../../drizzle/schema');
    const { eq } = await import('drizzle-orm');

    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const rows = await db
      .select()
      .from(tradingPreferences)
      .where(eq(tradingPreferences.userId, input.userId))
      .limit(1);
    const prefs = rows[0];
    if (!prefs) return null;
    return { minExportPrice: prefs.minExportPrice ?? null, maxImportPrice: prefs.maxImportPrice ?? null };
  },

  /**
   * Enforce a trading strategy's guardrails before a strategy-driven trade is
   * created: trade size, daily volume, price thresholds and time windows from
   * the strategy's own `conditions`. A guardrail breach is a loud refusal with
   * the reason, never a skipped check.
   */
  async checkStrategyGuardrailsActivity(input: {
    strategyId: number;
    userId: number;
    tradeType: 'export' | 'import';
    energyKWh: number;
    priceCentsPerKwh: number;
    atIso: string;
  }): Promise<{ allowed: boolean; reason?: string }> {
    const { getDb } = await import('../db');
    const { tradingStrategies } = await import('../../drizzle/schema');
    const { and, eq } = await import('drizzle-orm');

    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const [strategy] = await db
      .select()
      .from(tradingStrategies)
      .where(and(eq(tradingStrategies.id, input.strategyId), eq(tradingStrategies.userId, input.userId)))
      .limit(1);

    if (!strategy) {
      return { allowed: false, reason: `Strategy ${input.strategyId} not found for user ${input.userId}` };
    }
    if (!strategy.isActive) {
      return { allowed: false, reason: `Strategy ${input.strategyId} ('${strategy.name}') is not active` };
    }

    const conditions = strategy.conditions ?? {};

    if (conditions.energyLimits) {
      const { minTradeSize, maxTradeSize, dailyLimit } = conditions.energyLimits;
      if (minTradeSize !== undefined && input.energyKWh < minTradeSize) {
        return {
          allowed: false,
          reason: `Trade of ${input.energyKWh} kWh is below the strategy's minimum trade size of ${minTradeSize} kWh`,
        };
      }
      if (maxTradeSize !== undefined && input.energyKWh > maxTradeSize) {
        return {
          allowed: false,
          reason: `Trade of ${input.energyKWh} kWh exceeds the strategy's maximum trade size of ${maxTradeSize} kWh`,
        };
      }
      if (dailyLimit !== undefined) {
        const tradedTodayKwh = await sumTodaysStrategyEnergyKwh(db, input.userId, input.strategyId);
        if (tradedTodayKwh + input.energyKWh > dailyLimit) {
          return {
            allowed: false,
            reason:
              `Strategy daily volume guardrail exceeded: ${tradedTodayKwh} kWh already traded today ` +
              `+ ${input.energyKWh} kWh requested > ${dailyLimit} kWh daily limit`,
          };
        }
      }
    }

    if (conditions.priceThresholds) {
      const p = conditions.priceThresholds;
      if (input.tradeType === 'export') {
        if (p.minExportPrice !== undefined && input.priceCentsPerKwh < p.minExportPrice) {
          return {
            allowed: false,
            reason: `Price ${input.priceCentsPerKwh}c/kWh is below the strategy's minimum export price of ${p.minExportPrice}c/kWh`,
          };
        }
        if (p.maxExportPrice !== undefined && input.priceCentsPerKwh > p.maxExportPrice) {
          return {
            allowed: false,
            reason: `Price ${input.priceCentsPerKwh}c/kWh is above the strategy's maximum export price of ${p.maxExportPrice}c/kWh`,
          };
        }
      } else {
        if (p.minImportPrice !== undefined && input.priceCentsPerKwh < p.minImportPrice) {
          return {
            allowed: false,
            reason: `Price ${input.priceCentsPerKwh}c/kWh is below the strategy's minimum import price of ${p.minImportPrice}c/kWh`,
          };
        }
        if (p.maxImportPrice !== undefined && input.priceCentsPerKwh > p.maxImportPrice) {
          return {
            allowed: false,
            reason: `Price ${input.priceCentsPerKwh}c/kWh is above the strategy's maximum import price of ${p.maxImportPrice}c/kWh`,
          };
        }
      }
    }

    if (conditions.timeWindows) {
      const at = new Date(input.atIso);
      const hour = at.getHours();
      const day = at.getDay();
      const { startHour, endHour, daysOfWeek } = conditions.timeWindows;
      if (startHour !== undefined && endHour !== undefined && (hour < startHour || hour > endHour)) {
        return {
          allowed: false,
          reason: `Hour ${hour} is outside the strategy's trading window ${startHour}-${endHour}`,
        };
      }
      if (daysOfWeek && daysOfWeek.length > 0 && !daysOfWeek.includes(day)) {
        return {
          allowed: false,
          reason: `Day ${day} is outside the strategy's trading days ${daysOfWeek.join(',')}`,
        };
      }
    }

    return { allowed: true };
  },

  /**
   * Record a guardrail refusal as a user-visible alert, so a strategy that was
   * stopped by its own limits is visible rather than silently not trading.
   */
  async recordGuardrailRefusalActivity(input: {
    userId: number;
    strategyId: number;
    reason: string;
    energyKWh: number;
    priceCentsPerKwh: number;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      const { getDb } = await import('../db');
      const { alerts } = await import('../../drizzle/schema');

      const db = await getDb();
      if (!db) throw new Error('Database not available');

      await db.insert(alerts).values({
        userId: input.userId,
        alertType: 'trading',
        severity: 'warning',
        title: 'Strategy guardrail refusal',
        message: `Strategy ${input.strategyId} refused a trade of ${input.energyKWh} kWh at ${input.priceCentsPerKwh}c/kWh: ${input.reason}`,
        metadata: JSON.stringify({ strategyId: input.strategyId, reason: input.reason }),
        createdAt: new Date(),
      });
      console.warn(`[TradingActivity] Strategy ${input.strategyId} guardrail refusal for user ${input.userId}: ${input.reason}`);
      return { success: true };
    } catch (error) {
      console.error('[TradingActivity] Guardrail refusal recording error:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  },

  /** Create a pending automated trade; it is executed only after verification. */
  async createAutomatedTradeActivity(input: {
    userId: number;
    assetId: number;
    strategy: string;
    strategyId?: number;
    tradeType: 'export' | 'import' | 'p2p_sell' | 'p2p_buy';
    energyWh: number;
    priceCentsPerKwh: number;
    totalAmountCents: number;
  }): Promise<{ tradeId: number }> {
    const { getDb } = await import('../db');
    const { trades } = await import('../../drizzle/schema');

    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const inserted = await db
      .insert(trades)
      .values({
        userId: input.userId,
        tradeType: input.tradeType,
        tradingMode: 'automatic',
        energy: input.energyWh,
        price: input.priceCentsPerKwh,
        totalAmount: input.totalAmountCents,
        timestamp: new Date(),
        status: 'pending',
        metadata: JSON.stringify({
          strategy: input.strategy,
          ...(input.strategyId !== undefined ? { strategyId: input.strategyId } : {}),
          assetId: input.assetId,
          createdAt: new Date().toISOString(),
        }),
      })
      .returning({ id: trades.id });

    const tradeId = Number(inserted[0]?.id);
    if (!tradeId) throw new Error('Failed to create trade record');
    return { tradeId };
  },

  /** Mark an automated trade failed after a refused verification. */
  async markAutomatedTradeFailedActivity(input: {
    tradeId: number;
    strategy: string;
    assetId: number;
    error: string;
  }): Promise<{ success: boolean }> {
    const { getDb } = await import('../db');
    const { trades } = await import('../../drizzle/schema');
    const { eq } = await import('drizzle-orm');

    const db = await getDb();
    if (!db) throw new Error('Database not available');

    await db
      .update(trades)
      .set({
        status: 'failed',
        metadata: JSON.stringify({
          strategy: input.strategy,
          assetId: input.assetId,
          verificationStatus: 'verification_failed',
          verificationError: input.error,
          failedAt: new Date().toISOString(),
        }),
      })
      .where(eq(trades.id, input.tradeId));
    return { success: true };
  },

  /** Mark an automated trade executed after real telemetry verified delivery. */
  async markAutomatedTradeExecutedActivity(input: {
    tradeId: number;
    strategy: string;
    assetId: number;
    observedAvgPowerW?: number;
  }): Promise<{ success: boolean }> {
    const { getDb } = await import('../db');
    const { trades } = await import('../../drizzle/schema');
    const { eq } = await import('drizzle-orm');

    const db = await getDb();
    if (!db) throw new Error('Database not available');

    await db
      .update(trades)
      .set({
        status: 'executed',
        metadata: JSON.stringify({
          strategy: input.strategy,
          assetId: input.assetId,
          verificationStatus: 'verified',
          observedAvgPowerW: input.observedAvgPowerW,
          executedAt: new Date().toISOString(),
        }),
      })
      .where(eq(trades.id, input.tradeId));
    return { success: true };
  },

  /**
   * Verify an automated trade against the asset's recent real telemetry: an
   * export needs measured export power, an import needs live telemetry at all.
   */
  async verifyAssetDeliveryActivity(input: {
    userId: number;
    assetId: number;
    tradeType: 'export' | 'import' | 'p2p_sell' | 'p2p_buy';
  }): Promise<{ verified: boolean; observedAvgPowerW?: number; error?: string }> {
    const { getDb } = await import('../db');
    const { assets, telemetry } = await import('../../drizzle/schema');
    const { and, avg, eq, gte } = await import('drizzle-orm');

    const db = await getDb();
    if (!db) return { verified: false, error: 'database not available' };

    const userAssets = await db
      .select()
      .from(assets)
      .where(
        input.assetId > 0
          ? and(eq(assets.userId, input.userId), eq(assets.id, input.assetId))
          : eq(assets.userId, input.userId)
      );
    if (userAssets.length === 0) return { verified: false, error: 'no assets found for user' };

    const windowStart = new Date(Date.now() - 60 * 60 * 1000);
    const isExport = input.tradeType === 'export' || input.tradeType === 'p2p_sell';

    for (const asset of userAssets) {
      const [telRow] = await db
        .select({ avgPower: avg(telemetry.power) })
        .from(telemetry)
        .where(and(eq(telemetry.assetId, asset.id), gte(telemetry.timestamp, windowStart)));

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
  },

  /**
   * Verify a P2P delivery from the seller's metered export over the delivery
   * window. No telemetry or no export means not verified.
   */
  async verifyP2PDeliveryActivity(input: {
    sellerId: number;
    windowStartIso: string;
    windowEndIso: string;
  }): Promise<{ verified: boolean; observedAvgPowerW?: number; error?: string }> {
    const { getDb } = await import('../db');
    const { assets, telemetry } = await import('../../drizzle/schema');
    const { and, avg, eq, gte, lte } = await import('drizzle-orm');

    const db = await getDb();
    if (!db) return { verified: false, error: 'database not available' };

    const windowStart = new Date(input.windowStartIso);
    const windowEnd = new Date(input.windowEndIso);

    const sellerAssets = await db
      .select({ id: assets.id })
      .from(assets)
      .where(eq(assets.userId, input.sellerId));
    if (sellerAssets.length === 0) return { verified: false, error: 'seller has no assets' };

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
  },

  /**
   * Create the two legs of a direct P2P trade. No funds move here: the escrow
   * step afterwards recognises only a provider-confirmed buyer payment.
   */
  async createP2pTradePairActivity(input: {
    sellerId: number;
    buyerId: number;
    energyWh: number;
    priceCentsPerKwh: number;
    totalAmountCents: number;
    deliveryTimeIso: string;
    durationHours: number;
  }): Promise<{ sellerTradeId: number; buyerTradeId: number }> {
    const { getDb } = await import('../db');
    const { trades } = await import('../../drizzle/schema');

    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const sellerInsert = await db
      .insert(trades)
      .values({
        userId: input.sellerId,
        tradeType: 'p2p_sell',
        tradingMode: 'p2p',
        energy: input.energyWh,
        price: input.priceCentsPerKwh,
        totalAmount: input.totalAmountCents,
        timestamp: new Date(),
        status: 'pending',
        counterpartyId: input.buyerId,
        metadata: JSON.stringify({
          deliveryTime: input.deliveryTimeIso,
          duration: input.durationHours,
          escrowStatus: 'unfunded',
        }),
      })
      .returning({ id: trades.id });
    const sellerTradeId = Number(sellerInsert[0]?.id);
    if (!sellerTradeId) throw new Error('Failed to create the seller leg of the P2P trade');

    const buyerInsert = await db
      .insert(trades)
      .values({
        userId: input.buyerId,
        tradeType: 'p2p_buy',
        tradingMode: 'p2p',
        energy: input.energyWh,
        price: input.priceCentsPerKwh,
        totalAmount: input.totalAmountCents,
        timestamp: new Date(),
        status: 'pending',
        counterpartyId: input.sellerId,
        metadata: JSON.stringify({
          deliveryTime: input.deliveryTimeIso,
          duration: input.durationHours,
          linkedTradeId: sellerTradeId,
          escrowStatus: 'unfunded',
        }),
      })
      .returning({ id: trades.id });
    const buyerTradeId = Number(buyerInsert[0]?.id);
    if (!buyerTradeId) throw new Error('Failed to create the buyer leg of the P2P trade');

    return { sellerTradeId, buyerTradeId };
  },

  /**
   * Record delivery verification on both legs of a direct P2P trade. The legs
   * stay 'pending': the seller has not been paid, so neither leg is 'executed'.
   */
  async markP2pPairDeliveredActivity(input: {
    sellerTradeId: number;
    buyerTradeId: number;
    observedAvgPowerW?: number;
  }): Promise<{ success: boolean }> {
    const { getDb } = await import('../db');
    const { trades } = await import('../../drizzle/schema');
    const { eq } = await import('drizzle-orm');

    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const patch = {
      verificationStatus: 'verified',
      observedAvgPowerW: input.observedAvgPowerW,
      escrowStatus: 'held',
      stage: 'delivery_verified_seller_unpaid',
      verifiedAt: new Date().toISOString(),
    };

    for (const tradeId of [input.sellerTradeId, input.buyerTradeId]) {
      const [existing] = await db
        .select({ metadata: trades.metadata })
        .from(trades)
        .where(eq(trades.id, tradeId))
        .limit(1);
      await db
        .update(trades)
        .set({ metadata: mergeTradeMetadata(existing?.metadata ?? null, patch) })
        .where(eq(trades.id, tradeId));
    }
    return { success: true };
  },

  /** Mark both legs of a direct P2P trade failed with the real reason. */
  async markP2pPairFailedActivity(input: {
    sellerTradeId: number;
    buyerTradeId: number;
    error: string;
  }): Promise<{ success: boolean }> {
    const { getDb } = await import('../db');
    const { trades } = await import('../../drizzle/schema');
    const { eq } = await import('drizzle-orm');

    const db = await getDb();
    if (!db) throw new Error('Database not available');

    for (const tradeId of [input.sellerTradeId, input.buyerTradeId]) {
      const [existing] = await db
        .select({ metadata: trades.metadata })
        .from(trades)
        .where(eq(trades.id, tradeId))
        .limit(1);
      await db
        .update(trades)
        .set({
          status: 'failed',
          metadata: mergeTradeMetadata(existing?.metadata ?? null, {
            verificationStatus: 'verification_failed',
            verificationError: input.error,
            escrowStatus: 'held',
            failedAt: new Date().toISOString(),
          }),
        })
        .where(eq(trades.id, tradeId));
    }
    return { success: true };
  },
};

