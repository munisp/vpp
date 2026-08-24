/**
 * Design studies: sizing and costing a site before it exists.
 *
 * Admin-only. A study fixes capital assumptions and a tariff for a community or
 * an agency, so who ran it and on what inputs is part of the record; a member has
 * no version of this to act on.
 *
 * Every mutation returns the study whatever it concluded. `refused`,
 * `no_feasible_candidate` and `service_unavailable` are answers with reasons, not
 * errors to swallow, and each of them is stored as a version so the refusal can
 * be produced later.
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { adminProcedure, router } from '../../_core/trpc';
import {
  DesignStudyError,
  getStudyVersion,
  listStudies,
  loadMeteredProfile,
  runDesignStudy,
  studyVersions,
  versionsWithDigest,
} from '../../services/design-study';
import { isMilpOptimizerConfigured } from '../../services/milp-dispatch';
import { isNetworkFeasibilityConfigured } from '../../services/network-feasibility';

const profileSource = z.enum(['metered', 'declared', 'sourced', 'synthetic']);

const runInput = z
  .object({
    reference: z.string().min(1).max(120),
    siteName: z.string().min(1).max(200),
    nodeId: z.number().int().positive().optional(),
    notes: z.string().max(500).optional(),
    intervalMinutes: z.number().int().positive().max(1440),
    /** A submitted profile, with where it came from. */
    load: z
      .object({
        source: profileSource,
        loadW: z.array(z.number().nonnegative()).min(24).max(35_136),
        reference: z.string().max(200).optional(),
      })
      .optional(),
    /** Or: measure the load from the meters behind `nodeId` over this many days. */
    meterDays: z.number().int().min(1).max(31).optional(),
    resources: z
      .array(
        z.object({
          kind: z.enum(['solar_pv', 'wind']),
          source: profileSource,
          capacityFactor: z.array(z.number().min(0).max(1.5)).min(24).max(35_136),
          reference: z.string().max(200).optional(),
        })
      )
      .min(1)
      .max(2),
    backup: z.object({
      kind: z.enum(['genset', 'grid']),
      maxW: z.number().positive(),
      energyCostCentsPerKwh: z.number().nonnegative(),
      fuelLitresPerKwh: z.number().positive().optional(),
      emissionsGPerKwh: z.number().nonnegative().optional(),
      available: z.array(z.boolean()).max(35_136).optional(),
    }),
    economics: z.object({
      discountRatePercent: z.number().min(0).max(100),
      projectYears: z.number().int().min(1).max(40),
      pvCapexCentsPerKw: z.number().nonnegative().optional(),
      windCapexCentsPerKw: z.number().nonnegative().optional(),
      batteryCapexCentsPerKwh: z.number().nonnegative().optional(),
      inverterCapexCentsPerKw: z.number().nonnegative().optional(),
      backupCapexCentsPerKw: z.number().nonnegative().optional(),
      fixedOpexPercentOfCapexPerYear: z.number().min(0).max(100).optional(),
      batteryReplacementYear: z.number().int().min(1).max(40).optional(),
      batteryReplacementCostFraction: z.number().min(0).max(2).optional(),
    }),
    sweep: z.object({
      pvKw: z.array(z.number().nonnegative()).max(20).optional(),
      windKw: z.array(z.number().nonnegative()).max(20).optional(),
      batteryKwh: z.array(z.number().nonnegative()).max(20).optional(),
      batteryPowerRatio: z.number().positive().max(4).optional(),
      batteryRoundTripEfficiency: z.number().min(0.1).max(1).optional(),
      batteryUsableFraction: z.number().min(0.1).max(1).optional(),
    }),
    maxUnmetFraction: z.number().min(0).max(1),
    tariffCentsPerKwh: z.number().nonnegative().optional(),
    /** Re-solve the hardest day with the MILP dispatch model as a cross-check. */
    dispatchCheck: z.boolean().optional(),
    /** Solve the recommendation against the feeder. Requires `nodeId`. */
    checkNetwork: z.boolean().optional(),
  })
  .refine(value => value.load !== undefined || value.meterDays !== undefined, {
    message:
      'submit a load profile or name how many days of metering to read: a study will not invent demand',
  })
  .refine(value => value.meterDays === undefined || value.nodeId !== undefined, {
    message: 'meterDays needs nodeId: the meters are the ones behind the node',
  })
  .refine(value => value.checkNetwork !== true || value.nodeId !== undefined, {
    message: 'checkNetwork needs nodeId: there is no feeder to check without one',
  });

function toTRPCError(error: unknown): never {
  if (error instanceof DesignStudyError) {
    throw new TRPCError({
      code: error.message === 'Database not available' ? 'SERVICE_UNAVAILABLE' : 'BAD_REQUEST',
      message: error.message,
    });
  }
  throw error;
}

export const designStudyRouter = router({
  /** What this deployment can actually do, so the UI explains rather than guesses. */
  serviceStatus: adminProcedure.query(() => {
    const optimizer = isMilpOptimizerConfigured();
    return {
      optimizerConfigured: optimizer,
      networkCheckConfigured: isNetworkFeasibilityConfigured(),
      note: optimizer
        ? null
        : 'OPTIMIZER_SERVICE_URL is not set: no sizing search can be run on this deployment',
    };
  }),

  run: adminProcedure.input(runInput).mutation(async ({ input, ctx }) => {
    try {
      return await runDesignStudy({
        ...input,
        requestedByUserId: ctx.user?.id,
      });
    } catch (error) {
      toTRPCError(error);
    }
  }),

  /** Whether a site's metering can carry a study at all, before one is run. */
  meteredProfile: adminProcedure
    .input(
      z.object({
        nodeId: z.number().int().positive(),
        days: z.number().int().min(1).max(31),
        intervalMinutes: z.number().int().positive().max(1440),
      })
    )
    .query(async ({ input }) => {
      const loaded = await loadMeteredProfile(input);
      if (!loaded.available) {
        return { available: false as const, reason: loaded.reason };
      }
      return {
        available: true as const,
        intervals: loaded.profile.intervals,
        assets: loaded.profile.assets,
        from: loaded.profile.from,
        to: loaded.profile.to,
        peakW: Math.max(...loaded.profile.loadW),
        meanW:
          loaded.profile.loadW.reduce((total, value) => total + value, 0) /
          loaded.profile.loadW.length,
      };
    }),

  studies: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(100) }).default({ limit: 100 }))
    .query(async ({ input }) => listStudies(input.limit)),

  versions: adminProcedure
    .input(
      z.object({
        studyId: z.number().int().positive(),
        limit: z.number().int().min(1).max(200).default(50),
      })
    )
    .query(async ({ input }) => studyVersions(input.studyId, input.limit)),

  version: adminProcedure
    .input(z.object({ versionId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const version = await getStudyVersion(input.versionId);
      if (version === null) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No such design study version' });
      }
      return version;
    }),

  /**
   * Versions that asked the same question. Identical inputs must give identical
   * outputs; this is how a caller checks that they did.
   */
  sameInputs: adminProcedure
    .input(
      z.object({
        digest: z.string().regex(/^[0-9a-f]{64}$/),
        limit: z.number().int().min(1).max(50).default(20),
      })
    )
    .query(async ({ input }) => versionsWithDigest(input.digest, input.limit)),
});
