import { z } from 'zod';
import { router, protectedProcedure } from '../../_core/trpc';
import { TRPCError } from '@trpc/server';
import {
  computeWindows,
  DispatchWindowError,
  getRecommendation,
  listRecommendations,
} from '../../services/innov3-dispatch-windows';

function toError(error: unknown): TRPCError {
  if (error instanceof DispatchWindowError) {
    const notFound = error.message.includes('not found');
    return new TRPCError({ code: notFound ? 'NOT_FOUND' : 'BAD_REQUEST', message: error.message });
  }
  console.error('[Innov3DispatchWindows]', error);
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Dispatch window computation failed.' });
}

/**
 * TOU dispatch windows router (innovation 19).
 *
 * Recommended charge/discharge windows for a flexible asset, computed from
 * the PUBLISHED dynamic tariff for the user's country plus the asset's
 * registered constraints. No published tariff -> recommendationAvailable:
 * false, reason 'no_tariff'. Prices are never invented.
 */
export const dispatchWindowsRouter = router({
  /** Compute and persist a recommendation for one of the user's assets. */
  computeWindows: protectedProcedure
    .input(z.object({ assetId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await computeWindows(ctx.user.id, input.assetId);
      } catch (error) {
        throw toError(error);
      }
    }),

  getRecommendation: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      try {
        return await getRecommendation(ctx.user.id, input.id);
      } catch (error) {
        throw toError(error);
      }
    }),

  listRecommendations: protectedProcedure
    .input(
      z.object({
        assetId: z.number().int().positive().optional(),
        limit: z.number().int().positive().max(100).default(20),
      })
    )
    .query(async ({ ctx, input }) => {
      try {
        return { recommendations: await listRecommendations(ctx.user.id, input.assetId, input.limit) };
      } catch (error) {
        throw toError(error);
      }
    }),
});

export type DispatchWindowsRouter = typeof dispatchWindowsRouter;
