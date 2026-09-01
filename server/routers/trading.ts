import { z } from 'zod';
import { router, protectedProcedure, publicProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import * as db from '../db';
import { trades, marketPrices } from '../../drizzle/schema';
import { p2pSettlements } from '../../drizzle/innovations-schema';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { KAFKA_TOPICS } from '../integration/kafka-config';
import { enqueueEvent } from '../services/events/outbox';
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

        const conn = await db.getDb();
        if (!conn) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Database not available',
          });
        }

        // The trade row and its stream event are written together, so the trade
        // cannot exist without the event that announces it and vice versa. The
        // event is published from the outbox afterwards, so a broker outage
        // delays it rather than deciding whether the trade happened.
        const tradeId = await conn.transaction(async tx => {
          const [row] = await tx
            .insert(trades)
            .values({
              userId: ctx.user.id,
              tradeType: input.tradeType,
              tradingMode: input.tradingMode,
              energy: input.energy,
              price: input.price,
              totalAmount,
              timestamp: new Date(),
              status: 'pending',
              counterpartyId: input.counterpartyId,
            })
            .returning({ id: trades.id });

          const id = Number(row.id);
          await enqueueEvent(tx, {
            topic: KAFKA_TOPICS.TRADES_CREATED,
            eventKey: `trades.created:${id}`,
            partitionKey: id.toString(),
            payload: {
              event_id: `trades.created:${id}`,
              source: 'trading',
              tradeId: id.toString(),
              userId: ctx.user.id.toString(),
              type: input.tradeType.includes('sell') || input.tradeType === 'export' ? 'sell' : 'buy',
              quantity: input.energy,
              price: input.price,
              timestamp: new Date().toISOString(),
              status: 'pending',
            },
          });

          return id;
        });

        const trade = await db.getTradeById(tradeId);
        if (!trade) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Trade was written but could not be read back.',
          });
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
        const isAdmin = ctx.user.role === 'admin';

        // Get the trade first to check ownership. Admins act on any trade as
        // part of settlement operations; owners may only cancel their own.
        const trade = await db.getTradeById(input.tradeId);
        if (!trade || (!isAdmin && trade.userId !== ctx.user.id)) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Trade not found.',
          });
        }

        // Settlement states are financial outcomes and must come from the
        // settlement pipeline (workflow/admin), never from the trade owner.
        if (!isAdmin && input.status !== 'cancelled') {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message:
              'Only cancellation is self-service; execution and failure are set by settlement after delivery is verified.',
          });
        }

        if (!isAdmin && trade.status !== 'pending') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Trade cannot be cancelled once it is ${trade.status}.`,
          });
        }

        const conn = await db.getDb();
        if (!conn) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Database not available',
          });
        }

        // An 'executed' status is a claim that money and energy actually moved,
        // so no caller — admin included — may set it by hand. It is only
        // allowed when there is system evidence: a settlement row in its
        // terminal 'complete' state linked to this trade (match + settlement
        // linkage). The settlement pipeline is what reaches that state after
        // payment and delivery are evidenced. Admins can still cancel a trade
        // or mark it failed; they cannot declare it settled.
        if (input.status === 'executed') {
          const evidence = await conn
            .select({ id: p2pSettlements.id, state: p2pSettlements.state })
            .from(p2pSettlements)
            .where(or(eq(p2pSettlements.buyTradeId, input.tradeId), eq(p2pSettlements.sellTradeId, input.tradeId)))
            .limit(1);

          if (evidence.length === 0 || evidence[0].state !== 'complete') {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message:
                `Cannot mark trade ${input.tradeId} as executed without settlement evidence: ` +
                'executed requires a p2p_settlements row in its terminal state linked to this trade. ' +
                'The status is written by the settlement pipeline once payment and delivery are evidenced; ' +
                'this API can only cancel a trade or mark it failed.',
            });
          }
        }

        // The settlement event belongs to the transition that caused it, so both
        // are one write: whoever wins the conditional update owns the event, and
        // a rolled-back transition takes its event with it.
        const transitioned = await conn.transaction(async tx => {
          const result = await tx
            .update(trades)
            .set({ status: input.status })
            .where(and(eq(trades.id, input.tradeId), eq(trades.status, trade.status)));

          if ((result.rowCount ?? 0) === 0) return false;

          if (input.status === 'executed') {
            await enqueueEvent(tx, {
              topic: KAFKA_TOPICS.TRADES_SETTLED,
              // One settlement per trade, so a repeated execution enqueues once.
              eventKey: `trades.settled:${input.tradeId}`,
              partitionKey: input.tradeId.toString(),
              payload: {
                event_id: `trades.settled:${input.tradeId}`,
                source: 'trading',
                tradeId: input.tradeId.toString(),
                settledAt: new Date().toISOString(),
                finalPrice: trade.price,
                finalQuantity: trade.energy,
              },
            });
          }

          return true;
        });

        if (!transitioned) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Trade status changed concurrently; retry with the current state.',
          });
        }

        // Send notification and publish events based on status
        if (input.status === 'executed') {
          // Create alert
          await createAlert({
            userId: trade.userId,
            alertType: 'trading',
            severity: 'info',
            title: 'Trade Executed',
            message: `Your ${trade.tradeType} trade of ${(trade.energy / 1000).toFixed(2)} kWh has been executed successfully.`,
            isRead: false,
          });

          // Send push notification
          await sendPushNotification(
            trade.userId,
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

          // Send email notification to the trade owner
          const executedOwner = await db.getUserById(trade.userId);
          if (executedOwner?.email) {
            const emailHtml = tradeConfirmationTemplate({
              userName: executedOwner.name || 'User',
              tradeType: trade.tradeType,
              energy: trade.energy,
              price: (trade.price / 100).toFixed(2),
              status: 'executed',
              tradeId: input.tradeId,
              date: new Date().toLocaleString(),
            });
            await sendEmail({
              to: executedOwner.email,
              subject: '✅ Trade Executed Successfully',
              html: emailHtml,
            });
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
              status: { from: trade.status, to: 'executed' },
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
            userId: trade.userId,
            alertType: 'trading',
            severity: 'error',
            title: 'Trade Failed',
            message: `Your ${trade.tradeType} trade of ${(trade.energy / 1000).toFixed(2)} kWh has failed.`,
            isRead: false,
          });

          // Send push notification
          await sendPushNotification(
            trade.userId,
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

          // Send email notification to the trade owner
          const failedOwner = await db.getUserById(trade.userId);
          if (failedOwner?.email) {
            const emailHtml = tradeConfirmationTemplate({
              userName: failedOwner.name || 'User',
              tradeType: trade.tradeType,
              energy: trade.energy,
              price: (trade.price / 100).toFixed(2),
              status: 'failed',
              tradeId: input.tradeId,
              date: new Date().toLocaleString(),
            });
            await sendEmail({
              to: failedOwner.email,
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
              status: { from: trade.status, to: 'failed' },
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
