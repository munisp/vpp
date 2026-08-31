import { z } from 'zod';
import { protectedProcedure, router } from '../../_core/trpc';
import { carbonAwareDispatch } from '../../services/carbon-aware-dispatch';

export const carbonRouter = router({
  getCurrentEmissions: protectedProcedure
    .input(z.object({ region: z.string().optional() }).optional())
    .query(async ({ input, ctx }) => {
      // Region defaults to the user's recorded country mapping; null when it
      // cannot be resolved (service then reports unavailable, never a guess).
      const region = input?.region ?? await carbonAwareDispatch.resolveRegionForUser(ctx.user.id);
      if (!region) return null;
      return carbonAwareDispatch.getCurrentEmissions(region);
    }),

  getCarbonOptimizedDispatch: protectedProcedure
    .input(z.object({
      horizonHours: z.number().default(24),
      intervalMinutes: z.number().int().min(5).max(120).default(15),
    }))
    .query(async ({ input, ctx }) => {
      // Service signature: (userId, horizonHours, intervalMinutes)
      return carbonAwareDispatch.getCarbonOptimizedDispatch(ctx.user.id, input.horizonHours, input.intervalMinutes);
    }),

  calculateCarbonImpact: protectedProcedure
    .input(z.object({
      periodStart: z.date(),
      periodEnd: z.date(),
    }))
    .query(async ({ input, ctx }) => {
      return carbonAwareDispatch.calculateCarbonImpact(ctx.user.id, input.periodStart, input.periodEnd);
    }),

  getUserCredits: protectedProcedure
    .query(async ({ ctx }) => {
      return carbonAwareDispatch.getUserCredits(ctx.user.id);
    }),

  retireCredit: protectedProcedure
    .input(z.object({ creditId: z.number() }))
    .mutation(async ({ input }) => {
      return carbonAwareDispatch.retireCredit(input.creditId);
    }),

    getCarbonIntensitySignal: protectedProcedure
      .input(z.object({
        region: z.string().optional(),
      }).optional())
      .query(async ({ input, ctx }) => {
        const region = input?.region ?? await carbonAwareDispatch.resolveRegionForUser(ctx.user.id);
        if (!region) {
          return {
            signalAvailable: false,
            current: null,
            emissionFactorSource: 'unavailable' as const,
            forecast: [],
            recommendation: null,
            reason: 'No region could be resolved for this user',
          };
        }
        return carbonAwareDispatch.getCarbonIntensitySignal(region);
      }),
});
