import { z } from 'zod';
import { router, protectedProcedure } from '../../_core/trpc';
import { TRPCError } from '@trpc/server';
import { compareTariffs, listTariffComparisons } from '../../services/innov3-tariff-advisor';

function toError(error: unknown): TRPCError {
  console.error('[Innov3TariffAdvisor]', error);
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Tariff comparison failed.' });
}

/**
 * Tariff switch advisor router.
 *
 * Prices the user's real interval usage profile against every published
 * dynamic tariff version, ranked cheapest-first. Returns available:false
 * with a machine-readable reason when no tariff is published or the usage
 * history is insufficient — no synthetic comparison is produced.
 */
export const tariffAdvisorRouter = router({
  compareTariffs: protectedProcedure
    .mutation(async ({ ctx }) => {
      try {
        return await compareTariffs(ctx.user.id, ctx.user.country);
      } catch (error) {
        throw toError(error);
      }
    }),

  listComparisons: protectedProcedure
    .input(z.object({ limit: z.number().int().positive().max(20).default(5) }))
    .query(async ({ ctx, input }) => {
      try {
        return await listTariffComparisons(ctx.user.id, input.limit);
      } catch (error) {
        throw toError(error);
      }
    }),
});

export type TariffAdvisorRouter = typeof tariffAdvisorRouter;
