import { z } from 'zod';
import { router, protectedProcedure } from '../_core/trpc';
import {
  getParticipantPerformanceTrends,
  getEarningsForecast,
  getCarbonImpact,
  getPeerComparison,
  getAchievementTimeline,
  getEnergySavingsTracker,
  getParticipantOverallStats,
} from '../participant-insights-db';

/**
 * Participant Insights Router
 * Provides personal analytics and insights for DR participants
 */
export const participantInsightsRouter = router({
  /**
   * Get performance trends over time
   */
  getPerformanceTrends: protectedProcedure
    .input(
      z.object({
        startDate: z.date(),
        endDate: z.date(),
      })
    )
    .query(async ({ ctx, input }) => {
      return await getParticipantPerformanceTrends(
        ctx.user.id,
        input.startDate,
        input.endDate
      );
    }),

  /**
   * Get earnings forecast
   */
  getEarningsForecast: protectedProcedure.query(async ({ ctx }) => {
    return await getEarningsForecast(ctx.user.id);
  }),

  /**
   * Get carbon impact metrics
   */
  getCarbonImpact: protectedProcedure.query(async ({ ctx }) => {
    return await getCarbonImpact(ctx.user.id);
  }),

  /**
   * Get peer comparison (anonymized)
   */
  getPeerComparison: protectedProcedure.query(async ({ ctx }) => {
    return await getPeerComparison(ctx.user.id);
  }),

  /**
   * Get achievement timeline
   */
  getAchievementTimeline: protectedProcedure.query(async ({ ctx }) => {
    return await getAchievementTimeline(ctx.user.id);
  }),

  /**
   * Get energy savings tracker
   */
  getEnergySavingsTracker: protectedProcedure.query(async ({ ctx }) => {
    return await getEnergySavingsTracker(ctx.user.id);
  }),

  /**
   * Get overall stats
   */
  getOverallStats: protectedProcedure.query(async ({ ctx }) => {
    return await getParticipantOverallStats(ctx.user.id);
  }),

  /**
   * Get all insights at once
   */
  getAllInsights: protectedProcedure
    .input(
      z.object({
        startDate: z.date(),
        endDate: z.date(),
      })
    )
    .query(async ({ ctx, input }) => {
      const [
        performanceTrends,
        earningsForecast,
        carbonImpact,
        peerComparison,
        achievementTimeline,
        energySavingsTracker,
        overallStats,
      ] = await Promise.all([
        getParticipantPerformanceTrends(ctx.user.id, input.startDate, input.endDate),
        getEarningsForecast(ctx.user.id),
        getCarbonImpact(ctx.user.id),
        getPeerComparison(ctx.user.id),
        getAchievementTimeline(ctx.user.id),
        getEnergySavingsTracker(ctx.user.id),
        getParticipantOverallStats(ctx.user.id),
      ]);

      return {
        performanceTrends,
        earningsForecast,
        carbonImpact,
        peerComparison,
        achievementTimeline,
        energySavingsTracker,
        overallStats,
      };
    }),
});
