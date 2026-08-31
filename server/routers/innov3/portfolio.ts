import { z } from 'zod';
import { router, protectedProcedure } from '../../_core/trpc';
import { TRPCError } from '@trpc/server';
import { getPortfolio, listPortfolioSnapshots } from '../../services/innov3-portfolio';

function toError(error: unknown): TRPCError {
  console.error('[Portfolio]', error);
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Portfolio rollup failed.' });
}

/**
 * Portfolio dashboard router.
 *
 * Rolls up the caller's assets over a selectable period from real telemetry
 * and real battery health snapshots. Sites with no data appear as
 * available:false with a reason — never as fabricated zeros.
 */
export const portfolioRouter = router({
  overview: protectedProcedure
    .input(z.object({
      period: z.enum(['24h', '7d', '30d', '90d']).default('7d'),
      /** Set false to skip caching the result in portfolio_snapshots. */
      persist: z.boolean().default(true),
    }))
    .query(async ({ ctx, input }) => {
      try {
        return await getPortfolio(ctx.user.id, input.period, { persist: input.persist });
      } catch (error) {
        throw toError(error);
      }
    }),

  snapshotHistory: protectedProcedure
    .input(z.object({ limit: z.number().int().positive().max(50).default(10) }))
    .query(async ({ ctx, input }) => {
      try {
        const snapshots = await listPortfolioSnapshots(ctx.user.id, input.limit);
        return { snapshots, count: snapshots.length };
      } catch (error) {
        throw toError(error);
      }
    }),
});

export type PortfolioRouter = typeof portfolioRouter;
