import { z } from 'zod';
import { router, protectedProcedure } from '../_core/trpc';
import * as analytics from '../analytics';

const DateRangeSchema = z.object({
  startDate: z.date(),
  endDate: z.date(),
  interval: z.enum(['hour', 'day']).optional(),
});

export const analyticsRouter = router({
  /**
   * Get revenue data for charts
   */
  getRevenue: protectedProcedure
    .input(DateRangeSchema)
    .query(async ({ ctx, input }) => {
      const data = await analytics.getRevenueData(
        ctx.user.id,
        input.startDate,
        input.endDate
      );
      return { data };
    }),

  /**
   * Get energy flow data, scoped to the requesting user's assets.
   *
   * analytics.getEnergyFlowData now joins assets and filters by
   * assets.userId, so this is safe for any authenticated user — they only
   * ever see their own telemetry.
   */
  getEnergyFlow: protectedProcedure
    .input(DateRangeSchema)
    .query(async ({ ctx, input }) => {
      const data = await analytics.getEnergyFlowData(
        ctx.user.id,
        input.startDate,
        input.endDate,
        input.interval || 'day'
      );
      return { data };
    }),

  /**
   * Get trading volume data
   */
  getTradingVolume: protectedProcedure
    .input(DateRangeSchema)
    .query(async ({ ctx, input }) => {
      const data = await analytics.getTradingVolumeData(
        ctx.user.id,
        input.startDate,
        input.endDate
      );
      return { data };
    }),

  /**
   * Get user engagement metrics (admin only)
   */
  getUserEngagement: protectedProcedure
    .query(async ({ ctx }) => {
      // Check if user is admin
      if (ctx.user.role !== 'admin') {
        throw new Error('Unauthorized: Admin access required');
      }
      const metrics = await analytics.getUserEngagementMetrics();
      return metrics;
    }),

  /**
   * Get system statistics (admin only)
   */
  getSystemStats: protectedProcedure
    .query(async ({ ctx }) => {
      // Check if user is admin
      if (ctx.user.role !== 'admin') {
        throw new Error('Unauthorized: Admin access required');
      }
      const stats = await analytics.getSystemStatistics();
      return stats;
    }),
});
