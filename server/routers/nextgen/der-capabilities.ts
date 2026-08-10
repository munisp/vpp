import { z } from 'zod';
import { protectedProcedure, router } from '../../_core/trpc';
import { derCapabilities } from '../../services/der-capabilities';

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

  autoDetectCapabilities: protectedProcedure
    .input(z.object({ assetId: z.number() }))
    .mutation(async ({ input }) => {
      return derCapabilities.autoDetectCapabilities(input.assetId);
    }),
});
