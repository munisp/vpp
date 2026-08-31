import { z } from 'zod';
import { router, protectedProcedure } from '../../_core/trpc';
import { TRPCError } from '@trpc/server';
import {
  acknowledgeFault,
  detectFaultsForAsset,
  detectFaultsForUser,
  listFaults,
  resolveFault,
} from '../../services/innov3-inverter-faults';
import { getDb } from '../../db';
import { assets } from '../../../drizzle/schema';
import { and, eq } from 'drizzle-orm';

function toError(error: unknown, fallback: string): TRPCError {
  const message = error instanceof Error ? error.message : '';
  if (message === 'ASSET_NOT_FOUND') return new TRPCError({ code: 'NOT_FOUND', message: 'Asset not found.' });
  if (message === 'ASSET_NOT_SOLAR') return new TRPCError({ code: 'BAD_REQUEST', message: 'Fault detection only applies to solar assets.' });
  if (message === 'FAULT_NOT_OPEN') return new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Fault is not in an actionable state (missing, not yours, or already resolved).' });
  console.error('[InverterFaults]', error);
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: fallback });
}

/**
 * Solar inverter fault detector.
 *
 * Detection runs over real telemetry and real device logs only; rules with
 * insufficient evidence (sparse samples, insufficient PR history, no
 * attached inverter device) stay silent and report why in `skipped`.
 */
export const inverterFaultsRouter = router({
  // Run all rules over every solar asset the caller owns.
  detectForMe: protectedProcedure
    .mutation(async ({ ctx }) => {
      try {
        return await detectFaultsForUser(ctx.user.id);
      } catch (error) {
        throw toError(error, 'Failed to run fault detection.');
      }
    }),

  // Run all rules for one of the caller's own solar assets.
  detectForAsset: protectedProcedure
    .input(z.object({ assetId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database not available' });
      const [asset] = await db
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.id, input.assetId), eq(assets.userId, ctx.user.id)))
        .limit(1);
      if (!asset) throw new TRPCError({ code: 'NOT_FOUND', message: 'Asset not found.' });
      try {
        return await detectFaultsForAsset(input.assetId);
      } catch (error) {
        throw toError(error, 'Failed to run fault detection.');
      }
    }),

  list: protectedProcedure
    .input(z.object({
      limit: z.number().int().positive().max(100).default(50),
      status: z.enum(['open', 'acknowledged', 'resolved']).optional(),
    }))
    .query(async ({ ctx, input }) => {
      try {
        return await listFaults(ctx.user.id, input);
      } catch (error) {
        throw toError(error, 'Failed to list faults.');
      }
    }),

  acknowledge: protectedProcedure
    .input(z.object({ faultId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await acknowledgeFault(ctx.user.id, input.faultId);
      } catch (error) {
        throw toError(error, 'Failed to acknowledge fault.');
      }
    }),

  resolve: protectedProcedure
    .input(z.object({ faultId: z.number().int().positive(), note: z.string().max(2000).optional() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await resolveFault(ctx.user.id, input.faultId, input.note);
      } catch (error) {
        throw toError(error, 'Failed to resolve fault.');
      }
    }),
});

export type InverterFaultsRouter = typeof inverterFaultsRouter;
