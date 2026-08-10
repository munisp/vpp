import { z } from 'zod';
import { protectedProcedure, router } from '../../_core/trpc';
import { probabilisticForecasting } from '../../services/probabilistic-forecasting';

export const forecastingRouter = router({
  forecastLoad: protectedProcedure
    .input(z.object({
      assetId: z.number().optional(),
      communityId: z.number().optional(),
      region: z.string().optional(),
      horizonHours: z.number().default(24),
      intervalMinutes: z.number().default(15),
    }))
    .mutation(async ({ input, ctx }) => {
      return probabilisticForecasting.forecastLoad(
        { assetId: input.assetId, userId: ctx.user.id, communityId: input.communityId, region: input.region },
        input.horizonHours,
        input.intervalMinutes
      );
    }),

  forecastSolarGeneration: protectedProcedure
    .input(z.object({
      assetId: z.number().optional(),
      region: z.string().optional(),
      horizonHours: z.number().default(24),
      intervalMinutes: z.number().default(15),
    }))
    .mutation(async ({ input, ctx }) => {
      return probabilisticForecasting.forecastSolarGeneration(
        { assetId: input.assetId, userId: ctx.user.id, region: input.region },
        input.horizonHours,
        input.intervalMinutes
      );
    }),

  forecastPrice: protectedProcedure
    .input(z.object({
      region: z.string().default('NG-LAGOS'),
      horizonHours: z.number().default(24),
      intervalMinutes: z.number().default(60),
    }))
    .mutation(async ({ input }) => {
      return probabilisticForecasting.forecastPrice(input.region, input.horizonHours, input.intervalMinutes);
    }),

  forecastEmissions: protectedProcedure
    .input(z.object({
      region: z.string().default('NG-LAGOS'),
      horizonHours: z.number().default(24),
      intervalMinutes: z.number().default(60),
    }))
    .mutation(async ({ input }) => {
      return probabilisticForecasting.forecastEmissions(input.region, input.horizonHours, input.intervalMinutes);
    }),

  getForecast: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(async ({ input }) => {
      return probabilisticForecasting.getForecast(input.runId);
    }),
});
