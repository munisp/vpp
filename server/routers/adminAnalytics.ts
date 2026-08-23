import { z } from 'zod';
import { router, protectedProcedure } from '../_core/trpc';
import { AnalyticsExportService } from '../analytics-export';
import { TRPCError } from '@trpc/server';
import {
  getPaymentMetrics,
  getDREventMetrics,
  getForecastingMetrics,
  getSystemKPIs,
} from '../admin-analytics-db';
import { getDb } from '../db';
import { users, trades, payments, drParticipants, demandResponseEvents, assets, telemetry } from '../../drizzle/schema';
import { sql, eq, and, gte, lte, desc, count, sum } from 'drizzle-orm';

/**
 * Admin-only procedure
 * Ensures only admins can access analytics
 */
const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== 'admin') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Admin access required',
    });
  }
  return next({ ctx });
});

/**
 * Admin Analytics Router
 * Provides comprehensive analytics data for admin dashboard
 */
export const adminAnalyticsRouter = router({
  /**
   * Get payment metrics
   */
  getPaymentMetrics: adminProcedure
    .input(
      z.object({
        startDate: z.date(),
        endDate: z.date(),
      })
    )
    .query(async ({ input }) => {
      return await getPaymentMetrics(input.startDate, input.endDate);
    }),

  /**
   * Get DR event metrics
   */
  getDREventMetrics: adminProcedure
    .input(
      z.object({
        startDate: z.date(),
        endDate: z.date(),
      })
    )
    .query(async ({ input }) => {
      return await getDREventMetrics(input.startDate, input.endDate);
    }),

  /**
   * Get forecasting metrics
   */
  getForecastingMetrics: adminProcedure
    .input(
      z.object({
        startDate: z.date(),
        endDate: z.date(),
      })
    )
    .query(async ({ input }) => {
      return await getForecastingMetrics(input.startDate, input.endDate);
    }),

  /**
   * Get system-wide KPIs
   */
  getSystemKPIs: adminProcedure.query(async () => {
    return await getSystemKPIs();
  }),

  /**
   * Get all analytics data at once
   */
  getAllMetrics: adminProcedure
    .input(
      z.object({
        startDate: z.date(),
        endDate: z.date(),
      })
    )
    .query(async ({ input }) => {
      const [paymentMetrics, drMetrics, forecastingMetrics, systemKPIs] =
        await Promise.all([
          getPaymentMetrics(input.startDate, input.endDate),
          getDREventMetrics(input.startDate, input.endDate),
          getForecastingMetrics(input.startDate, input.endDate),
          getSystemKPIs(),
        ]);

      return {
        paymentMetrics,
        drMetrics,
        forecastingMetrics,
        systemKPIs,
      };
    }),

  /**
   * Export payment metrics to CSV
   */
  exportPaymentMetrics: adminProcedure
    .input(
      z.object({
        startDate: z.date(),
        endDate: z.date(),
      })
    )
    .query(async ({ input }) => {
      const metrics = await getPaymentMetrics(input.startDate, input.endDate);
      const csv = AnalyticsExportService.exportPaymentMetricsCSV(metrics);
      const filename = `payment-metrics-${input.startDate.toISOString().split('T')[0]}-${input.endDate.toISOString().split('T')[0]}.csv`;
      return { csv, filename };
    }),

  /**
   * Export DR metrics to CSV
   */
  exportDRMetrics: adminProcedure
    .input(
      z.object({
        startDate: z.date(),
        endDate: z.date(),
      })
    )
    .query(async ({ input }) => {
      const metrics = await getDREventMetrics(input.startDate, input.endDate);
      const csv = AnalyticsExportService.exportDRMetricsCSV(metrics);
      const filename = `dr-metrics-${input.startDate.toISOString().split('T')[0]}-${input.endDate.toISOString().split('T')[0]}.csv`;
      return { csv, filename };
    }),

  /**
   * Export comprehensive analytics report
   */
  exportComprehensiveReport: adminProcedure
    .input(
      z.object({
        startDate: z.date(),
        endDate: z.date(),
      })
    )
    .query(async ({ input }) => {
      const [kpis, paymentMetrics, drMetrics, forecastingMetrics] = await Promise.all([
        getSystemKPIs(),
        getPaymentMetrics(input.startDate, input.endDate),
        getDREventMetrics(input.startDate, input.endDate),
        getForecastingMetrics(input.startDate, input.endDate),
      ]);

      const csv = AnalyticsExportService.generateComprehensiveReport({
        kpis,
        paymentMetrics,
        drMetrics,
        forecastingMetrics,
        dateRange: {
          start: input.startDate.toISOString().split('T')[0],
          end: input.endDate.toISOString().split('T')[0],
        },
      });

      const filename = `vpp-analytics-report-${input.startDate.toISOString().split('T')[0]}-${input.endDate.toISOString().split('T')[0]}.csv`;
      return { csv, filename };
    }),

  /**
   * Get user growth metrics
   */
  getUserGrowth: adminProcedure
    .input(z.object({
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      const startDate = input.startDate ? new Date(input.startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const endDate = input.endDate ? new Date(input.endDate) : new Date();

      const totalUsersResult = await db.select({ count: count() }).from(users);
      const totalUsers = totalUsersResult[0]?.count || 0;

      const usersByDate = await db
        .select({
          date: sql<string>`DATE(${users.createdAt})::text`,
          count: count(),
        })
        .from(users)
        .where(and(gte(users.createdAt, startDate), lte(users.createdAt, endDate)))
        .groupBy(sql`DATE(${users.createdAt})`)
        .orderBy(sql`DATE(${users.createdAt})`);

      const activeUsersResult = await db
        .selectDistinct({ userId: trades.userId })
        .from(trades)
        .where(and(gte(trades.createdAt, startDate), lte(trades.createdAt, endDate)));

      return {
        totalUsers,
        activeUsers: activeUsersResult.length,
        growthRate: totalUsers > 0 ? ((activeUsersResult.length / totalUsers) * 100).toFixed(2) : '0',
        usersByDate: usersByDate.map(row => ({ date: row.date, count: row.count })),
      };
    }),

  /**
   * Get trading metrics
   */
  getTradingMetrics: adminProcedure
    .input(z.object({
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      const startDate = input.startDate ? new Date(input.startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const endDate = input.endDate ? new Date(input.endDate) : new Date();

      const tradesResult = await db
        .select({ totalTrades: count(), totalEnergy: sum(trades.energy) })
        .from(trades)
        .where(and(gte(trades.createdAt, startDate), lte(trades.createdAt, endDate), eq(trades.status, 'executed')));

      const totalTrades = tradesResult[0]?.totalTrades || 0;
      const totalEnergy = Number(tradesResult[0]?.totalEnergy || 0);

      const tradesByType = await db
        .select({ tradeType: trades.tradeType, count: count(), totalEnergy: sum(trades.energy) })
        .from(trades)
        .where(and(gte(trades.createdAt, startDate), lte(trades.createdAt, endDate), eq(trades.status, 'executed')))
        .groupBy(trades.tradeType);

      const tradesByDate = await db
        .select({ date: sql<string>`DATE(${trades.createdAt})::text`, count: count(), totalEnergy: sum(trades.energy) })
        .from(trades)
        .where(and(gte(trades.createdAt, startDate), lte(trades.createdAt, endDate), eq(trades.status, 'executed')))
        .groupBy(sql`DATE(${trades.createdAt})`)
        .orderBy(sql`DATE(${trades.createdAt})`);

      return {
        totalTrades,
        totalEnergy: Math.round(totalEnergy / 1000),
        averageTradeSize: totalTrades > 0 ? Math.round(totalEnergy / totalTrades / 1000) : 0,
        tradesByType: tradesByType.map(row => ({ type: row.tradeType, count: row.count, energy: Math.round(Number(row.totalEnergy || 0) / 1000) })),
        tradesByDate: tradesByDate.map(row => ({ date: row.date, count: row.count, energy: Math.round(Number(row.totalEnergy || 0) / 1000) })),
      };
    }),

  /**
   * Get revenue metrics
   */
  getRevenueMetrics: adminProcedure
    .input(z.object({
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      const startDate = input.startDate ? new Date(input.startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const endDate = input.endDate ? new Date(input.endDate) : new Date();

      const revenueResult = await db
        .select({ totalRevenue: sum(payments.amount), count: count() })
        .from(payments)
        .where(and(gte(payments.createdAt, startDate), lte(payments.createdAt, endDate), eq(payments.status, 'completed')));

      const totalRevenue = Number(revenueResult[0]?.totalRevenue || 0);
      const totalPayments = revenueResult[0]?.count || 0;

      const revenueByDate = await db
        .select({ date: sql<string>`DATE(${payments.createdAt})::text`, revenue: sum(payments.amount), count: count() })
        .from(payments)
        .where(and(gte(payments.createdAt, startDate), lte(payments.createdAt, endDate), eq(payments.status, 'completed')))
        .groupBy(sql`DATE(${payments.createdAt})`)
        .orderBy(sql`DATE(${payments.createdAt})`);

      return {
        totalRevenue: totalRevenue.toFixed(2),
        totalPayments,
        averagePayment: totalPayments > 0 ? (totalRevenue / totalPayments).toFixed(2) : '0',
        revenueByDate: revenueByDate.map(row => ({ date: row.date, revenue: Number(row.revenue || 0).toFixed(2), count: row.count })),
      };
    }),

  /**
   * Get top performers
   */
  getTopPerformers: adminProcedure
    .input(z.object({
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      limit: z.number().min(1).max(100).default(10),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      const startDate = input.startDate ? new Date(input.startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const endDate = input.endDate ? new Date(input.endDate) : new Date();

      const topTraders = await db
        .select({ userId: trades.userId, userName: users.name, totalTrades: count(), totalEnergy: sum(trades.energy) })
        .from(trades)
        .innerJoin(users, eq(trades.userId, users.id))
        .where(and(gte(trades.createdAt, startDate), lte(trades.createdAt, endDate), eq(trades.status, 'executed')))
        .groupBy(trades.userId, users.name)
        .orderBy(desc(sum(trades.energy)))
        .limit(input.limit);

      return {
        topTraders: topTraders.map(row => ({
          userId: row.userId,
          userName: row.userName || 'Unknown',
          totalTrades: row.totalTrades,
          totalEnergy: Math.round(Number(row.totalEnergy || 0) / 1000),
        })),
      };
    }),

  /**
   * Get system health metrics
   */
  getSystemHealth: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const assetsResult = await db.select({ count: count() }).from(assets);
    const totalAssets = assetsResult[0]?.count || 0;

    const activeAssetsResult = await db.select({ count: count() }).from(assets).where(eq(assets.status, 'active'));
    const activeAssets = activeAssetsResult[0]?.count || 0;

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentTelemetryResult = await db.select({ count: count() }).from(telemetry).where(gte(telemetry.timestamp, oneDayAgo));
    const recentTelemetry = recentTelemetryResult[0]?.count || 0;

    const pendingTradesResult = await db.select({ count: count() }).from(trades).where(eq(trades.status, 'pending'));
    const pendingTrades = pendingTradesResult[0]?.count || 0;

    return {
      totalAssets,
      activeAssets,
      assetHealthRate: totalAssets > 0 ? ((activeAssets / totalAssets) * 100).toFixed(2) : '0',
      recentTelemetry,
      pendingTrades,
      systemStatus: pendingTrades > 50 ? 'warning' : 'healthy',
    };
  }),

  /**
   * Get overview dashboard
   */
  getOverview: adminProcedure
    .input(z.object({
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      const startDate = input.startDate ? new Date(input.startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const endDate = input.endDate ? new Date(input.endDate) : new Date();

      const [totalUsersResult, totalTradesResult, totalRevenueResult, totalEventsResult] = await Promise.all([
        db.select({ count: count() }).from(users),
        db.select({ count: count() }).from(trades).where(and(gte(trades.createdAt, startDate), lte(trades.createdAt, endDate), eq(trades.status, 'executed'))),
        db.select({ sum: sum(payments.amount) }).from(payments).where(and(gte(payments.createdAt, startDate), lte(payments.createdAt, endDate), eq(payments.status, 'completed'))),
        db.select({ count: count() }).from(demandResponseEvents).where(and(gte(demandResponseEvents.createdAt, startDate), lte(demandResponseEvents.createdAt, endDate))),
      ]);

      return {
        totalUsers: totalUsersResult[0]?.count || 0,
        totalTrades: totalTradesResult[0]?.count || 0,
        totalRevenue: Number(totalRevenueResult[0]?.sum || 0).toFixed(2),
        totalDREvents: totalEventsResult[0]?.count || 0,
      };
    }),
});
