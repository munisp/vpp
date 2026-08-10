import { z } from 'zod';
import { router, protectedProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import { computeBatteryHealth, listSnapshots } from '../services/battery-health';

function toError(error: unknown): TRPCError {
  const message = error instanceof Error ? error.message : '';
  if (message === 'ASSET_NOT_FOUND') return new TRPCError({ code: 'NOT_FOUND', message: 'Asset not found.' });
  if (message === 'ASSET_NOT_OWNED') return new TRPCError({ code: 'FORBIDDEN', message: 'You do not own this asset.' });
  if (message === 'ASSET_NOT_BATTERY') return new TRPCError({ code: 'BAD_REQUEST', message: 'Battery health analytics is only available for battery assets.' });
  console.error('[BatteryHealth]', error);
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to compute battery health.' });
}

/**
 * Battery health analytics router.
 *
 * All metrics are computed from the asset's real SoC/power telemetry.
 * Thin data (<7 days span) returns null metric fields with
 * insufficientData:true — nothing is fabricated.
 */
export const batteryHealthRouter = router({
  getBatteryHealth: protectedProcedure
    .input(z.object({ assetId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      try {
        return await computeBatteryHealth(input.assetId, ctx.user.id);
      } catch (error) {
        throw toError(error);
      }
    }),

  // Previously persisted health snapshots for the asset
  getSnapshotHistory: protectedProcedure
    .input(z.object({ assetId: z.number().int().positive(), limit: z.number().int().positive().max(50).default(10) }))
    .query(async ({ ctx, input }) => {
      try {
        return await listSnapshots(input.assetId, ctx.user.id, input.limit);
      } catch (error) {
        throw toError(error);
      }
    }),
});

export type BatteryHealthRouter = typeof batteryHealthRouter;
