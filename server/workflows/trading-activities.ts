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

      console.log(`[TradingActivity] Notification sent to user ${input.userId}`);
      return { success: true };
    } catch (error) {
      console.error('[TradingActivity] Notification error:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  },
};

