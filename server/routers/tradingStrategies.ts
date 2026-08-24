import { z } from 'zod';
import { router, protectedProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import { getDb } from '../db';
import { tradingStrategies, trades } from '../../drizzle/schema';
import { eq, and, desc, gte, lte, sql } from 'drizzle-orm';

const ConditionsSchema = z.object({
  priceThresholds: z.object({
    minExportPrice: z.number().optional(),
    maxExportPrice: z.number().optional(),
    minImportPrice: z.number().optional(),
    maxImportPrice: z.number().optional(),
  }).optional(),
  batteryLevels: z.object({
    minSOC: z.number().min(0).max(100).optional(),
    maxSOC: z.number().min(0).max(100).optional(),
  }).optional(),
  timeWindows: z.object({
    startHour: z.number().min(0).max(23).optional(),
    endHour: z.number().min(0).max(23).optional(),
    daysOfWeek: z.array(z.number().min(0).max(6)).optional(),
  }).optional(),
  energyLimits: z.object({
    minTradeSize: z.number().positive().optional(),
    maxTradeSize: z.number().positive().optional(),
    dailyLimit: z.number().positive().optional(),
  }).optional(),
});

const CreateStrategySchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  conditions: ConditionsSchema,
  tradingMode: z.enum(['export', 'import', 'both']),
  priority: z.number().int().default(0),
});

const UpdateStrategySchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  conditions: ConditionsSchema.optional(),
  tradingMode: z.enum(['export', 'import', 'both']).optional(),
  priority: z.number().int().optional(),
});

export const tradingStrategiesRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database unavailable' });

    const strategies = await db
      .select()
      .from(tradingStrategies)
      .where(eq(tradingStrategies.userId, ctx.user.id))
      .orderBy(desc(tradingStrategies.priority), desc(tradingStrategies.createdAt));

    return strategies;
  }),

  getById: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database unavailable' });

      const [strategy] = await db
        .select()
        .from(tradingStrategies)
        .where(and(
          eq(tradingStrategies.id, input.id),
          eq(tradingStrategies.userId, ctx.user.id)
        ))
        .limit(1);

      if (!strategy) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Strategy not found' });
      }

      return strategy;
    }),

  create: protectedProcedure
    .input(CreateStrategySchema)
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database unavailable' });

      const [result] = await db.insert(tradingStrategies).values({
        userId: ctx.user.id,
        name: input.name,
        description: input.description,
        conditions: input.conditions,
        tradingMode: input.tradingMode,
        priority: input.priority,
        isActive: false,
        performanceMetrics: {
          totalTrades: 0,
          successfulTrades: 0,
          failedTrades: 0,
          totalEnergyTraded: 0,
          totalProfit: 0,
          averagePrice: 0,
        },
      }).returning({ id: tradingStrategies.id });

      return {
        success: true,
        strategyId: result.id,
        message: 'Strategy created successfully',
      };
    }),

  update: protectedProcedure
    .input(UpdateStrategySchema)
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database unavailable' });

      // Check ownership
      const [existing] = await db
        .select()
        .from(tradingStrategies)
        .where(and(
          eq(tradingStrategies.id, input.id),
          eq(tradingStrategies.userId, ctx.user.id)
        ))
        .limit(1);

      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Strategy not found' });
      }

      const { id, ...updateData } = input;
      await db
        .update(tradingStrategies)
        .set(updateData)
        .where(eq(tradingStrategies.id, input.id));

      return {
        success: true,
        message: 'Strategy updated successfully',
      };
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database unavailable' });

      // Check ownership
      const [existing] = await db
        .select()
        .from(tradingStrategies)
        .where(and(
          eq(tradingStrategies.id, input.id),
          eq(tradingStrategies.userId, ctx.user.id)
        ))
        .limit(1);

      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Strategy not found' });
      }

      await db
        .delete(tradingStrategies)
        .where(eq(tradingStrategies.id, input.id));

      return {
        success: true,
        message: 'Strategy deleted successfully',
      };
    }),

  activate: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database unavailable' });

      // Check ownership
      const [existing] = await db
        .select()
        .from(tradingStrategies)
        .where(and(
          eq(tradingStrategies.id, input.id),
          eq(tradingStrategies.userId, ctx.user.id)
        ))
        .limit(1);

      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Strategy not found' });
      }

      await db
        .update(tradingStrategies)
        .set({
          isActive: true,
          lastActivatedAt: new Date(),
        })
        .where(eq(tradingStrategies.id, input.id));

      return {
        success: true,
        message: 'Strategy activated successfully',
      };
    }),

  deactivate: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database unavailable' });

      // Check ownership
      const [existing] = await db
        .select()
        .from(tradingStrategies)
        .where(and(
          eq(tradingStrategies.id, input.id),
          eq(tradingStrategies.userId, ctx.user.id)
        ))
        .limit(1);

      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Strategy not found' });
      }

      await db
        .update(tradingStrategies)
        .set({ isActive: false })
        .where(eq(tradingStrategies.id, input.id));

      return {
        success: true,
        message: 'Strategy deactivated successfully',
      };
    }),

  backtest: protectedProcedure
    .input(z.object({
      id: z.number().int().positive(),
      period: z.enum(['7d', '30d', '90d']).default('30d'),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database unavailable' });

      // Get strategy
      const [strategy] = await db
        .select()
        .from(tradingStrategies)
        .where(and(
          eq(tradingStrategies.id, input.id),
          eq(tradingStrategies.userId, ctx.user.id)
        ))
        .limit(1);

      if (!strategy) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Strategy not found' });
      }

      // Calculate date range
      const days = input.period === '7d' ? 7 : input.period === '30d' ? 30 : 90;
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      // Get historical trades for the user
      const historicalTrades = await db
        .select()
        .from(trades)
        .where(and(
          eq(trades.userId, ctx.user.id),
          gte(trades.createdAt, startDate)
        ))
        .orderBy(trades.createdAt);

      // Simulate strategy application on historical data
      let simulatedTrades = 0;
      let projectedProfit = 0;
      let projectedEnergyTraded = 0;
      let successfulSimulations = 0;

      const conditions = strategy.conditions as any;

      for (const trade of historicalTrades) {
        let matchesStrategy = true;

        // Check price thresholds
        if (conditions?.priceThresholds) {
          const pricePerKWh = trade.price / 100; // Convert from cents
          if (trade.tradeType === 'export') {
            if (conditions.priceThresholds.minExportPrice && pricePerKWh < conditions.priceThresholds.minExportPrice) {
              matchesStrategy = false;
            }
            if (conditions.priceThresholds.maxExportPrice && pricePerKWh > conditions.priceThresholds.maxExportPrice) {
              matchesStrategy = false;
            }
          } else if (trade.tradeType === 'import') {
            if (conditions.priceThresholds.minImportPrice && pricePerKWh < conditions.priceThresholds.minImportPrice) {
              matchesStrategy = false;
            }
            if (conditions.priceThresholds.maxImportPrice && pricePerKWh > conditions.priceThresholds.maxImportPrice) {
              matchesStrategy = false;
            }
          }
        }

        // Check energy limits
        if (conditions?.energyLimits) {
          const energyKWh = trade.energy / 1000;
          if (conditions.energyLimits.minTradeSize && energyKWh < conditions.energyLimits.minTradeSize) {
            matchesStrategy = false;
          }
          if (conditions.energyLimits.maxTradeSize && energyKWh > conditions.energyLimits.maxTradeSize) {
            matchesStrategy = false;
          }
        }

        // Check time windows
        if (conditions?.timeWindows) {
          const tradeHour = trade.createdAt.getHours();
          const tradeDay = trade.createdAt.getDay();
          
          if (conditions.timeWindows.startHour !== undefined && conditions.timeWindows.endHour !== undefined) {
            if (tradeHour < conditions.timeWindows.startHour || tradeHour > conditions.timeWindows.endHour) {
              matchesStrategy = false;
            }
          }
          
          if (conditions.timeWindows.daysOfWeek && conditions.timeWindows.daysOfWeek.length > 0) {
            if (!conditions.timeWindows.daysOfWeek.includes(tradeDay)) {
              matchesStrategy = false;
            }
          }
        }

        if (matchesStrategy) {
          simulatedTrades++;
          const tradeProfit = trade.tradeType === 'export' ? trade.totalAmount : -trade.totalAmount;
          projectedProfit += tradeProfit;
          projectedEnergyTraded += trade.energy;
          if (trade.status === 'executed') {
            successfulSimulations++;
          }
        }
      }

      // A backtest over no history is not a strategy that made no profit, and a
      // strategy that matched nothing is not one with a 0% success rate: both
      // read as a measured verdict when they are the absence of one. The result
      // therefore carries what it looked at, and states a rate only when there
      // was something to rate.
      const successRate = simulatedTrades > 0 ? (successfulSimulations / simulatedTrades) * 100 : null;

      // Store backtest results
      const backtestResults = {
        period: input.period,
        tradesConsidered: historicalTrades.length,
        simulatedTrades,
        projectedProfit: projectedProfit / 100, // Convert from cents to TZS
        projectedEnergyTraded: projectedEnergyTraded / 1000, // Convert to kWh
        successRate,
        measured: historicalTrades.length > 0 && simulatedTrades > 0,
        testedAt: new Date().toISOString(),
      };

      await db
        .update(tradingStrategies)
        .set({ backtestResults })
        .where(eq(tradingStrategies.id, input.id));

      return {
        success: true,
        results: backtestResults,
        message:
          historicalTrades.length === 0
            ? `No trade was recorded in the last ${input.period}, so this strategy has not been backtested against anything.`
            : simulatedTrades === 0
              ? `None of the ${historicalTrades.length} trades in the last ${input.period} met this strategy's conditions, so it has no measured return.`
              : `Backtested against ${simulatedTrades} of ${historicalTrades.length} recorded trades.`,
      };
    }),
});
