/**
 * Temporal Worker for Trading Workflows
 * 
 * This worker processes energy trading workflows from the Temporal server.
 * It should be run as a separate process for scalability.
 */

import { NativeConnection, Worker } from '@temporalio/worker';

// Trading activities - inline since trading-workflow.ts has activities embedded
const tradingActivities = {
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
      const { trades } = await import('../../drizzle/schema');
      const { eq } = await import('drizzle-orm');

      const db = await getDb();
      if (!db) throw new Error('Database not available');

      // Create escrow record (update trade with pending status and escrow metadata)
      const escrowId = `ESC-${Date.now()}-${input.tradeId}`;
      
      await db.update(trades).set({
        status: 'pending', // Keep pending while in escrow
        metadata: JSON.stringify({ escrowId, escrowAmount: input.amount, escrowCreatedAt: new Date(), stage: 'escrow' }),
      }).where(eq(trades.id, input.tradeId));

      console.log(`[TradingActivity] Escrow created: ${escrowId} for trade ${input.tradeId}`);
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
      const { getDb } = await import('../db');
      const { trades } = await import('../../drizzle/schema');
      const { eq } = await import('drizzle-orm');

      const db = await getDb();
      if (!db) throw new Error('Database not available');

      // Record energy transfer (keep pending while executing)
      const transferId = `TRF-${Date.now()}-${input.tradeId}`;
      
      await db.update(trades).set({
        status: 'pending', // Keep pending while executing
        metadata: JSON.stringify({ 
          transferId, 
          transferStartedAt: new Date(),
          energyAmount: input.energyAmount,
          stage: 'executing',
        }),
      }).where(eq(trades.id, input.tradeId));

      console.log(`[TradingActivity] Energy transfer initiated: ${transferId}`);
      return { success: true, transferId };
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

      const db = await getDb();
      if (!db) throw new Error('Database not available');

      // Release escrow to seller (mark as executed - trade complete)
      await db.update(trades).set({
        status: 'executed', // Use 'executed' as the completed state per schema
        metadata: JSON.stringify({ 
          escrowReleasedAt: new Date(),
          escrowReleasedTo: input.sellerId,
          stage: 'completed',
        }),
      }).where(eq(trades.id, input.tradeId));

      console.log(`[TradingActivity] Escrow released: ${input.escrowId} to seller ${input.sellerId}`);
      return { success: true };
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

async function run() {
  // Validate required environment variables
  const temporalAddress = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
  
  console.log('[Trading Worker] Starting Trading worker...');
  console.log(`[Trading Worker] Connecting to Temporal at: ${temporalAddress}`);

  // Connect to Temporal server
  const connection = await NativeConnection.connect({
    address: temporalAddress,
  });

  console.log('[Trading Worker] Connected to Temporal server');

  // Create worker
  const worker = await Worker.create({
    connection,
    namespace: 'default',
    taskQueue: 'trading-execution',
    workflowsPath: require.resolve('./trading-workflow'),
    activities: tradingActivities,
    maxConcurrentActivityTaskExecutions: 50,
    maxConcurrentWorkflowTaskExecutions: 200,
  });

  console.log('[Trading Worker] Worker created for task queue: trading-execution');
  console.log('[Trading Worker] Max concurrent activities: 50');
  console.log('[Trading Worker] Max concurrent workflows: 200');

  // Run worker
  await worker.run();
}

run().catch((err) => {
  console.error('[Trading Worker] Fatal error:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[Trading Worker] Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[Trading Worker] Received SIGINT, shutting down gracefully...');
  process.exit(0);
});
