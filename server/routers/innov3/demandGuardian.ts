import { z } from 'zod';
import { router, protectedProcedure, adminProcedure } from '../../_core/trpc';
import { TRPCError } from '@trpc/server';
import {
  checkDemand,
  listAllDemandChargeAlerts,
  listDemandChargeAlerts,
} from '../../services/innov3-demand-guardian';

function toError(error: unknown): TRPCError {
  const message = error instanceof Error ? error.message : '';
  if (message === 'ASSET_NOT_FOUND') return new TRPCError({ code: 'NOT_FOUND', message: 'Asset not found.' });
  if (message === 'ASSET_NOT_OWNED') return new TRPCError({ code: 'FORBIDDEN', message: 'You do not own this asset.' });
  console.error('[Innov3DemandGuardian]', error);
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Demand-charge guardian check failed.' });
}

/**
 * Demand-charge guardian router (C&I).
 *
 * Rolling 15/30-minute demand from real telemetry vs the user's contracted
 * threshold; alert rows are written only when the labelled linear-trend
 * projection exceeds it. No telemetry or no configured threshold returns
 * available:false with a reason.
 */
export const demandGuardianRouter = router({
  checkDemand: protectedProcedure
    .input(z.object({
      assetId: z.number().int().positive(),
      windowMinutes: z.union([z.literal(15), z.literal(30)]),
      /** Contracted demand threshold, kW * 10. Omit to reuse the last saved value. */
      thresholdKw10: z.number().int().positive().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await checkDemand(ctx.user.id, input);
      } catch (error) {
        throw toError(error);
      }
    }),

  listAlerts: protectedProcedure
    .input(z.object({
      assetId: z.number().int().positive().optional(),
      limit: z.number().int().positive().max(100).default(20),
    }))
    .query(async ({ ctx, input }) => {
      try {
        return await listDemandChargeAlerts(ctx.user.id, input.assetId, input.limit);
      } catch (error) {
        throw toError(error);
      }
    }),

  // Fleet-wide alert view for operators.
  listAllAlerts: adminProcedure
    .input(z.object({ limit: z.number().int().positive().max(200).default(50) }))
    .query(async ({ input }) => {
      try {
        return await listAllDemandChargeAlerts(input.limit);
      } catch (error) {
        throw toError(error);
      }
    }),
});

export type DemandGuardianRouter = typeof demandGuardianRouter;
