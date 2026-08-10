import { z } from 'zod';
import { router, protectedProcedure, publicProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import * as db from '../db';
import { trades, marketPrices } from '../../drizzle/schema';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { kafkaPublisher } from '../integration/kafka-publisher';
import { temporalClient } from '../integration/temporal-client';
import { sendPushNotification } from '../_core/sendNotification';
import { createAlert } from '../db';
import { sendEmail } from '../_core/emailService';
import { tradeConfirmationTemplate } from '../_core/emailTemplates';
import { createAuditLog, getClientIP, getUserAgent } from '../_core/auditLog';

const TradeTypeSchema = z.enum(['export', 'import', 'p2p_sell', 'p2p_buy']);
const TradingModeSchema = z.enum(['automatic', 'manual', 'p2p']);

const CreateTradeInputSchema = z.object({
  tradeType: TradeTypeSchema,
  tradingMode: TradingModeSchema,
  energy: z.number().int().positive(),
  price: z.number().int().positive(),
  counterpartyId: z.number().int().positive().optional(),
});

const UpdateTradeStatusInputSchema = z.object({
  tradeId: z.number().int().positive(),
  status: z.enum(['pending', 'executed', 'cancelled', 'failed']),
});

const UpdatePreferencesInputSchema = z.object({
  tradingMode: z.enum(['automatic', 'manual', 'hybrid']).optional(),
  minExportPrice: z.number().int().positive().optional(),
  maxImportPrice: z.number().int().positive().optional(),
  minBatteryLevel: z.number().int().min(0).max(10000).optional(),
  maxBatteryLevel: z.number().int().min(0).max(10000).optional(),
  enableP2P: z.boolean().optional(),
  enableNotifications: z.boolean().optional(),
  metadata: z.string().optional(),
});

export const tradingRouter = router({
  create: protectedProcedure
    .input(CreateTradeInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const totalAmount = Math.floor((input.energy * input.price) / 1000);

        const trade = await db.createTrade({
          userId: ctx.user.id,
          tradeType: input.tradeType,
          tradingMode: input.tradingMode,
          energy: input.energy,
          price: input.price,
          totalAmount,
          timestamp: new Date(),
          status: 'pending',
          counterpartyId: input.counterpartyId,
        });

        // Publish trade created event to Kafka
        try {
          await kafkaPublisher.publishTradeCreated({
            tradeId: trade.id.toString(),
            userId: ctx.user.id.toString(),
            type: input.tradeType.includes('sell') || input.tradeType === 'export' ? 'sell' : 'buy',
            quantity: input.energy,
            price: input.price,
            timestamp: new Date(),
            status: 'pending',
          });
        } catch (kafkaError) {
          console.error('[Trading] Failed to publish trade created event:', kafkaError);
          // Continue even if Kafka publish fails (graceful degradation)
        }

        // Start Temporal workflow for trade execution
        try {
          await temporalClient.startTradingWorkflow({
            tradeId: trade.id,
            userId: ctx.user.id,
            tradeType: input.tradeType,
            energy: input.energy,
            price: input.price,
            counterpartyId: input.counterpartyId,
          });
          console.log(`[Trading] Started Temporal workflow for trade ${trade.id}`);
        } catch (err) {
          console.error('[Trading] Failed to start Temporal workflow:', err);
          // Don't fail the trade creation if workflow fails to start
        }

        return {
          success: true,
          trade,
          message: 'Trade created successfully.',
        };
      } catch (error) {
        console.error('Error creating trade:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to create trade.',
        });
      }
    }),

  list: protectedProcedure
    .input(z.object({ limit: z.number().int().positive().max(100).default(50) }))
    .query(async ({ ctx, input }) => {
      try {
        const trades = await db.getUserTrades(ctx.user.id, input.limit);
        return {
          trades,
          count: trades.length,
        };
      } catch (error) {
        console.error('Error listing trades:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to retrieve trades.',
        });
      }
    }),

  updateStatus: protectedProcedure
    .input(UpdateTradeStatusInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        // Get the trade first to check ownership
        const trade = await db.getTradeById(input.tradeId);
        if (!trade || trade.userId !== ctx.user.id) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Trade not found.',
          });
        }

        await db.updateTradeStatus(input.tradeId, input.status);

        // Send notification and publish events based on status
        if (input.status === 'executed') {
          // Create alert
          await createAlert({
            userId: ctx.user.id,
            alertType: 'trading',
            severity: 'info',
            title: 'Trade Executed',
            message: `Your ${trade.tradeType} trade of ${(trade.energy / 1000).toFixed(2)} kWh has been executed successfully.`,
            isRead: false,
          });

          // Send push notification
          await sendPushNotification(
            ctx.user.id,
            {
              title: '💰 Trade Executed',
              body: `Your ${trade.tradeType} trade of ${(trade.energy / 1000).toFixed(2)} kWh has been completed.`,
              data: {
                type: 'trade_executed',
                tradeId: input.tradeId,
                url: '/trading',
              },
            },
            'pushTradeExecuted'
          );

          // Send email notification
          if (ctx.user.email) {
            const emailHtml = tradeConfirmationTemplate({
              userName: ctx.user.name || 'User',
              tradeType: trade.tradeType,
              energy: trade.energy,
              price: (trade.price / 100).toFixed(2),
              status: 'executed',
              tradeId: input.tradeId,
              date: new Date().toLocaleString(),
            });
            await sendEmail({
              to: ctx.user.email,
              subject: '✅ Trade Executed Successfully',
              html: emailHtml,
            });
          }

          // Publish trade status update event to Kafka
          try {
            await kafkaPublisher.publishTradeSettled({
              tradeId: input.tradeId.toString(),
              settledAt: new Date(),
              finalPrice: trade.price,
              finalQuantity: trade.energy,
            });
          } catch (kafkaError) {
            console.error('[Trading] Failed to publish trade settled event:', kafkaError);
            // Continue even if Kafka publish fails
          }

          // Create audit log for executed trade
          await createAuditLog({
            userId: ctx.user.id,
            userName: ctx.user.name || undefined,
            userRole: ctx.user.role,
            action: 'trade',
            entityType: 'trade',
            entityId: String(input.tradeId),
            entityName: `${trade.tradeType} trade`,
            changes: {
              status: { from: 'pending', to: 'executed' },
              energy: trade.energy,
              price: trade.price,
            },
            description: `Executed ${trade.tradeType} trade: ${(trade.energy / 1000).toFixed(2)} kWh at ${(trade.price / 100).toFixed(2)} TZS/kWh`,
            ipAddress: getClientIP(ctx.req),
            userAgent: getUserAgent(ctx.req),
            status: 'success',
          });
        } else if (input.status === 'failed') {
          // Create alert for failed trade
          await createAlert({
            userId: ctx.user.id,
            alertType: 'trading',
            severity: 'error',
            title: 'Trade Failed',
            message: `Your ${trade.tradeType} trade of ${(trade.energy / 1000).toFixed(2)} kWh has failed.`,
            isRead: false,
          });

          // Send push notification
          await sendPushNotification(
            ctx.user.id,
            {
              title: '❌ Trade Failed',
              body: `Your ${trade.tradeType} trade could not be completed.`,
              data: {
                type: 'trade_failed',
                tradeId: input.tradeId,
                url: '/trading',
              },
            },
            'pushTradeFailed'
          );

          // Send email notification
          if (ctx.user.email) {
            const emailHtml = tradeConfirmationTemplate({
              userName: ctx.user.name || 'User',
              tradeType: trade.tradeType,
              energy: trade.energy,
              price: (trade.price / 100).toFixed(2),
              status: 'failed',
              tradeId: input.tradeId,
              date: new Date().toLocaleString(),
            });
            await sendEmail({
              to: ctx.user.email,
              subject: '❌ Trade Failed',
              html: emailHtml,
            });
          }

          // Create audit log for failed trade
          await createAuditLog({
            userId: ctx.user.id,
            userName: ctx.user.name || undefined,
            userRole: ctx.user.role,
            action: 'trade',
            entityType: 'trade',
            entityId: String(input.tradeId),
            entityName: `${trade.tradeType} trade`,
            changes: {
              status: { from: 'pending', to: 'failed' },
              energy: trade.energy,
              price: trade.price,
            },
            description: `Failed ${trade.tradeType} trade: ${(trade.energy / 1000).toFixed(2)} kWh at ${(trade.price / 100).toFixed(2)} TZS/kWh`,
            ipAddress: getClientIP(ctx.req),
            userAgent: getUserAgent(ctx.req),
            status: 'failure',
          });
        }

        return {
          success: true,
          message: 'Trade status updated successfully.',
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error('Error updating trade status:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update trade status.',
        });
      }
    }),

  getEarnings: protectedProcedure
    .query(async ({ ctx }) => {
      try {
        const dbInstance = await db.getDb();
        if (!dbInstance) throw new Error('Database not available');

        const executed = eq(trades.status, 'executed');
        const mine = eq(trades.userId, ctx.user.id);

        const [sellRow] = await dbInstance
          .select({ total: sql<number>`COALESCE(SUM(${trades.totalAmount}), 0)` })
          .from(trades)
          .where(and(mine, executed, inArray(trades.tradeType, ['export', 'p2p_sell'])));

        const [buyRow] = await dbInstance
          .select({ total: sql<number>`COALESCE(SUM(${trades.totalAmount}), 0)` })
          .from(trades)
          .where(and(mine, executed, inArray(trades.tradeType, ['import', 'p2p_buy'])));

        const totalSellCents = Number(sellRow?.total ?? 0);
        const totalBuyCents = Number(buyRow?.total ?? 0);

        return {
          totalSellCents,
          totalBuyCents,
          netCents: totalSellCents - totalBuyCents,
        };
      } catch (error) {
        console.error('Error computing trading earnings:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to compute trading earnings.',
        });
      }
    }),

  getMarketPrices: publicProcedure
    .query(async () => {
      try {
        const dbInstance = await db.getDb();
        if (!dbInstance) throw new Error('Database not available');

        // Latest real price per price type from the marketPrices table.
        const rows = await dbInstance
          .select()
          .from(marketPrices)
          .orderBy(desc(marketPrices.timestamp))
          .limit(200);

        const latestByType = new Map<string, typeof rows[number]>();
        for (const row of rows) {
          if (!latestByType.has(row.priceType)) {
            latestByType.set(row.priceType, row);
          }
        }

        return Array.from(latestByType.values()).map((row) => ({
          priceType: row.priceType,
          country: row.country,
          price: row.price,
          timestamp: row.timestamp,
          validUntil: row.validUntil,
        }));
      } catch (error) {
        console.error('Error getting market prices:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to retrieve market prices.',
        });
      }
    }),

  getPreferences: protectedProcedure.query(async ({ ctx }) => {
    try {
      const preferences = await db.getTradingPreference(ctx.user.id);
      
      if (!preferences) {
        // Return default preferences
        return {
          tradingMode: 'automatic' as const,
          minBatteryLevel: 2000,
          maxBatteryLevel: 9000,
          enableP2P: false,
          enableNotifications: true,
        };
      }

      return preferences;
    } catch (error) {
      console.error('Error getting trading preferences:', error);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to retrieve trading preferences.',
      });
    }
  }),

  updatePreferences: protectedProcedure
    .input(UpdatePreferencesInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const preferences = await db.upsertTradingPreference({
          userId: ctx.user.id,
          ...input,
        });

        return {
          success: true,
          preferences,
          message: 'Trading preferences updated successfully.',
        };
      } catch (error) {
        console.error('Error updating trading preferences:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update trading preferences.',
        });
      }
    }),
});

export type TradingRouter = typeof tradingRouter;
