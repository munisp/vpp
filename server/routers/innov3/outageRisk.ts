import { z } from 'zod';
import { router, protectedProcedure, adminProcedure } from '../../_core/trpc';
import { TRPCError } from '@trpc/server';
import { computeOutageRisk, listFleetOutageRisk, listOutageRiskScores } from '../../services/innov3-outage-risk';

function toError(error: unknown): TRPCError {
  const message = error instanceof Error ? error.message : '';
  if (message === 'ASSET_NOT_FOUND') return new TRPCError({ code: 'NOT_FOUND', message: 'Asset not found.' });
  if (message === 'ASSET_NOT_OWNED') return new TRPCError({ code: 'FORBIDDEN', message: 'You do not own this asset.' });
  console.error('[Innov3OutageRisk]', error);
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Outage risk computation failed.' });
}

/**
 * Outage risk forecast router.
 *
 * Scores are computed from the asset's real anomaly scores, telemetry gap
 * history and voltage/frequency quality. Thin history returns null score
 * with insufficientData:true and a reason — no invented probabilities.
 */
export const outageRiskRouter = router({
  computeRisk: protectedProcedure
    .input(z.object({ assetId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await computeOutageRisk(input.assetId, ctx.user.id);
      } catch (error) {
        throw toError(error);
      }
    }),

  getRiskHistory: protectedProcedure
    .input(z.object({
      assetId: z.number().int().positive(),
      limit: z.number().int().positive().max(50).default(10),
    }))
    .query(async ({ ctx, input }) => {
      try {
        return await listOutageRiskScores(input.assetId, ctx.user.id, input.limit);
      } catch (error) {
        throw toError(error);
      }
    }),

  // Fleet-wide view for operators, highest-score first.
  listFleetRisk: adminProcedure
    .input(z.object({ limit: z.number().int().positive().max(100).default(25) }))
    .query(async ({ input }) => {
      try {
        return await listFleetOutageRisk(input.limit);
      } catch (error) {
        throw toError(error);
      }
    }),
});

export type OutageRiskRouter = typeof outageRiskRouter;
