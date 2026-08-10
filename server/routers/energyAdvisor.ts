import { z } from 'zod';
import { router, protectedProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import { getAdvice, listReports } from '../services/energy-advisor';

/**
 * AI Energy Advisor router.
 *
 * Assembles the caller's real energy context (30d telemetry sums, trades,
 * payments, latest billing) and returns LLM-generated recommendations.
 * When the LLM is unavailable the response carries llmAvailable:false and
 * rule-based tips derived from the real numbers. Cached per user for 1h.
 */
export const energyAdvisorRouter = router({
  // Personalized saving recommendations (30-day context, cached 1h)
  getRecommendations: protectedProcedure
    .input(z.object({ refresh: z.boolean().default(false) }).optional())
    .query(async ({ ctx, input }) => {
      try {
        return await getAdvice(ctx.user.id, 'recommendations', { bypassCache: input?.refresh });
      } catch (error) {
        console.error('[EnergyAdvisor] getRecommendations failed:', error);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to generate energy recommendations.' });
      }
    }),

  // Weekly digest (7-day context, cached 1h)
  getWeeklyDigest: protectedProcedure
    .input(z.object({ refresh: z.boolean().default(false) }).optional())
    .query(async ({ ctx, input }) => {
      try {
        return await getAdvice(ctx.user.id, 'weekly_digest', { bypassCache: input?.refresh });
      } catch (error) {
        console.error('[EnergyAdvisor] getWeeklyDigest failed:', error);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to generate weekly digest.' });
      }
    }),

  // Previously generated and persisted advisor reports
  getReportHistory: protectedProcedure
    .input(z.object({ limit: z.number().int().positive().max(50).default(10) }))
    .query(async ({ ctx, input }) => {
      try {
        return await listReports(ctx.user.id, input.limit);
      } catch (error) {
        console.error('[EnergyAdvisor] getReportHistory failed:', error);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to load advisor reports.' });
      }
    }),
});

export type EnergyAdvisorRouter = typeof energyAdvisorRouter;
