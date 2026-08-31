import { z } from 'zod';
import { router, protectedProcedure } from '../../_core/trpc';
import { TRPCError } from '@trpc/server';
import { computeLoadDisaggregation, listApplianceEstimates } from '../../services/innov3-load-disaggregation';

function toError(error: unknown): TRPCError {
  const message = error instanceof Error ? error.message : '';
  if (message === 'ASSET_NOT_FOUND') return new TRPCError({ code: 'NOT_FOUND', message: 'Asset not found.' });
  if (message === 'ASSET_NOT_OWNED') return new TRPCError({ code: 'FORBIDDEN', message: 'You do not own this asset.' });
  console.error('[Innov3LoadDisaggregation]', error);
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Load disaggregation failed.' });
}

/**
 * Load disaggregation (NILM-lite) router.
 *
 * Appliance-class shares are estimates from interval-shape heuristics over
 * real power telemetry — every estimate carries a method label and a
 * confidence. Assets with < 14 days of interval history are refused with
 * insufficientData:true and a reason; nothing is fabricated.
 */
export const loadDisaggregationRouter = router({
  computeEstimates: protectedProcedure
    .input(z.object({ assetId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await computeLoadDisaggregation(input.assetId, ctx.user.id);
      } catch (error) {
        throw toError(error);
      }
    }),

  listEstimates: protectedProcedure
    .input(z.object({
      assetId: z.number().int().positive(),
      limit: z.number().int().positive().max(100).default(30),
    }))
    .query(async ({ ctx, input }) => {
      try {
        return await listApplianceEstimates(input.assetId, ctx.user.id, input.limit);
      } catch (error) {
        throw toError(error);
      }
    }),
});

export type LoadDisaggregationRouter = typeof loadDisaggregationRouter;
