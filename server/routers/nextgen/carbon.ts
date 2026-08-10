import { z } from 'zod';
import { protectedProcedure, router } from '../../_core/trpc';
import { carbonAwareDispatch } from '../../services/carbon-aware-dispatch';

export const carbonRouter = router({
  getCurrentEmissions: protectedProcedure
    .input(z.object({ region: z.string().default('NG-LAGOS') }).optional())
    .query(async ({ input }) => {
      return carbonAwareDispatch.getCurrentEmissions(input?.region || 'NG-LAGOS');
    }),

  getCarbonOptimizedDispatch: protectedProcedure
    .input(z.object({
      horizonHours: z.number().default(24),
      assetId: z.number().optional(),
    }))
    .query(async ({ input, ctx }) => {
      return carbonAwareDispatch.getCarbonOptimizedDispatch(ctx.user.id, input.horizonHours, input.assetId);
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
        region: z.string().default('NG-LAGOS'),
      }).optional())
      .query(async ({ input }) => {
        return carbonAwareDispatch.getCarbonIntensitySignal(input?.region || 'NG-LAGOS');
      }),
});
