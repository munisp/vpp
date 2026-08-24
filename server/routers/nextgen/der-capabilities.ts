import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { protectedProcedure, router } from '../../_core/trpc';
import { derCapabilities } from '../../services/der-capabilities';
import { ConformanceError, assetProtocolEvidence } from '../../services/protocol-conformance';
import { getDb } from '../../db';
import { assets } from '../../../drizzle/schema';

/** Capability evidence is the owner's business, and the operator's. */
async function requireAssetOwnership(
  ctx: { user: { id: number; role: string } },
  assetId: number
): Promise<void> {
  if (ctx.user.role === 'admin') return;

  const db = await getDb();
  if (!db) {
    throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'Database not available' });
  }
  const rows = await db
    .select({ userId: assets.userId })
    .from(assets)
    .where(eq(assets.id, assetId))
    .limit(1);
  if (!rows[0]) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Asset not found' });
  }
  if (rows[0].userId !== ctx.user.id) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not own this asset.' });
  }
}

export const derCapabilitiesRouter = router({
  registerCapabilities: protectedProcedure
    .input(z.object({
      assetId: z.number(),
      maxPowerExport: z.number().optional(),
      maxPowerImport: z.number().optional(),
      minPowerExport: z.number().optional(),
      minPowerImport: z.number().optional(),
      rampRateUp: z.number().optional(),
      rampRateDown: z.number().optional(),
      maxStateOfCharge: z.number().optional(),
      minStateOfCharge: z.number().optional(),
      roundTripEfficiency: z.number().optional(),
      responseTimeMs: z.number().optional(),
      canProvideFrequencyResponse: z.boolean().optional(),
      canProvideVoltageSupport: z.boolean().optional(),
      canProvideReserves: z.boolean().optional(),
      canProvidePeakShaving: z.boolean().optional(),
    }))
    .mutation(async ({ input }) => {
      const { assetId, ...capabilities } = input;
      return derCapabilities.registerCapabilities(assetId, capabilities);
    }),

  getCapabilities: protectedProcedure
    .input(z.object({ assetId: z.number() }))
    .query(async ({ input }) => {
      return derCapabilities.getCapabilities(input.assetId);
    }),

  addConstraint: protectedProcedure
    .input(z.object({
      assetId: z.number(),
      validFrom: z.date(),
      validUntil: z.date(),
      constraintType: z.enum(['max_power', 'min_power', 'max_energy', 'min_soc', 'max_soc', 'unavailable', 'must_run', 'user_preference']),
      constraintValue: z.number().optional(),
      priority: z.number().optional(),
      source: z.enum(['user', 'operator', 'system', 'safety', 'grid_code']),
      reason: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const { assetId, ...constraint } = input;
      return derCapabilities.addConstraint(assetId, constraint);
    }),

  getActiveConstraints: protectedProcedure
    .input(z.object({ assetId: z.number() }))
    .query(async ({ input }) => {
      return derCapabilities.getActiveConstraints(input.assetId);
    }),

    calculateEligibility: protectedProcedure
      .input(z.object({ assetId: z.number(), atTime: z.date().optional() }))
      .query(async ({ input }) => {
        return derCapabilities.calculateEligibility(input.assetId, input.atTime);
      }),

  getUserAssetsWithCapabilities: protectedProcedure
    .query(async ({ ctx }) => {
      return derCapabilities.getUserAssetsWithCapabilities(ctx.user.id);
    }),

  /**
   * The protocols an asset claims, each resolved against conformance evidence,
   * plus its certifications. `getCapabilities` returns the claim; this returns
   * whether anything stands behind it.
   */
  protocolEvidence: protectedProcedure
    .input(z.object({ assetId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await requireAssetOwnership(ctx, input.assetId);
      try {
        return await assetProtocolEvidence(input.assetId);
      } catch (error) {
        if (error instanceof ConformanceError) {
          throw new TRPCError({
            code: error.status === 503 ? 'SERVICE_UNAVAILABLE' : 'BAD_REQUEST',
            message: error.message,
          });
        }
        throw error;
      }
    }),

  autoDetectCapabilities: protectedProcedure
    .input(z.object({ assetId: z.number() }))
    .mutation(async ({ input }) => {
      return derCapabilities.autoDetectCapabilities(input.assetId);
    }),
});
