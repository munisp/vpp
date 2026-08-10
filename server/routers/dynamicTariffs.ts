import { z } from 'zod';
import { router, protectedProcedure, adminProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import {
  buildTariffSchedule,
  getPublishedTariff,
  listTariffVersions,
  publishTariff,
} from '../services/dynamic-tariffs';

const CountrySchema = z.enum(['nigeria', 'tanzania']);

function toError(error: unknown, fallback: string): TRPCError {
  const message = error instanceof Error ? error.message : fallback;
  if (message.startsWith('Insufficient market price history')) {
    // Honest data-gap failure — surfaced as a client-visible 422-style error.
    return new TRPCError({ code: 'PRECONDITION_FAILED', message });
  }
  console.error('[DynamicTariffs]', error);
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: fallback });
}

/**
 * Dynamic tariff engine router.
 *
 * Tariffs are computed from real marketPrices history (hourly averages
 * classified into off_peak/shoulder/peak by actual distribution percentiles)
 * with a grid-stress multiplier from live demandResponseEvents activity.
 */
export const dynamicTariffsRouter = router({
  // Tariff applying to the current hour
  getCurrentTariff: protectedProcedure
    .input(z.object({ country: CountrySchema }).optional())
    .query(async ({ ctx, input }) => {
      const country = input?.country ?? ctx.user.country;
      try {
        const schedule = await buildTariffSchedule(country, new Date());
        return {
          country,
          current: schedule.periods[0],
          learnedFrom: schedule.learnedFrom,
          generatedAt: new Date().toISOString(),
        };
      } catch (error) {
        throw toError(error, 'Failed to compute current tariff.');
      }
    }),

  // Full 24-hour tariff schedule starting at the current hour
  getTariffSchedule: protectedProcedure
    .input(z.object({ country: CountrySchema }).optional())
    .query(async ({ ctx, input }) => {
      const country = input?.country ?? ctx.user.country;
      try {
        return await buildTariffSchedule(country, new Date());
      } catch (error) {
        throw toError(error, 'Failed to compute tariff schedule.');
      }
    }),

  // Currently published (active) tariff version for a country, if any
  getPublishedTariff: protectedProcedure
    .input(z.object({ country: CountrySchema }).optional())
    .query(async ({ ctx, input }) => {
      const country = input?.country ?? ctx.user.country;
      try {
        const published = await getPublishedTariff(country);
        return { country, published }; // null = never published
      } catch (error) {
        throw toError(error, 'Failed to load published tariff.');
      }
    }),

  // Version history (never overwritten)
  listVersions: adminProcedure
    .input(z.object({ country: CountrySchema, limit: z.number().int().positive().max(50).default(10) }))
    .query(async ({ input }) => {
      try {
        return await listTariffVersions(input.country, input.limit);
      } catch (error) {
        throw toError(error, 'Failed to list tariff versions.');
      }
    }),

  // Publish a new computed tariff version (append-only)
  publishTariff: adminProcedure
    .input(z.object({
      country: CountrySchema,
      effectiveFrom: z.coerce.date().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await publishTariff(input.country, input.effectiveFrom ?? new Date(), ctx.user.id);
      } catch (error) {
        throw toError(error, 'Failed to publish tariff.');
      }
    }),
});

export type DynamicTariffsRouter = typeof dynamicTariffsRouter;
