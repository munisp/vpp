import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import { adminProcedure, protectedProcedure, router } from '../../_core/trpc';
import { probabilisticForecasting } from '../../services/probabilistic-forecasting';
import {
  MIN_SCORING_SAMPLES,
  TARGET_COVERAGE_BP,
  getAccuracySummary,
  scoreDueForecastRuns,
  scoreForecastRun,
} from '../../services/forecast-accuracy';
import { getDb } from '../../db';
import { assets } from '../../../drizzle/schema';
import { communityMembers } from '../../../drizzle/nextgen-vpp-schema';

/**
 * Accuracy for an asset is only visible to its owner: a competitor could infer
 * a site's generation profile from how well its forecasts score.
 */
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

/**
 * Community accuracy aggregates its members' forecasts, so it is visible to
 * active members only for the same reason asset accuracy is owner-only.
 */
async function requireCommunityMembership(
  ctx: { user: { id: number; role: string } },
  communityId: number
): Promise<void> {
  if (ctx.user.role === 'admin') return;

  const db = await getDb();
  if (!db) {
    throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'Database not available' });
  }

  const rows = await db
    .select({ status: communityMembers.status })
    .from(communityMembers)
    .where(
      and(
        eq(communityMembers.communityId, communityId),
        eq(communityMembers.userId, ctx.user.id)
      )
    )
    .limit(1);

  if (!rows[0] || rows[0].status !== 'active') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You are not an active member of this community.',
    });
  }
}

export const forecastingRouter = router({
  forecastLoad: protectedProcedure
    .input(z.object({
      assetId: z.number().optional(),
      communityId: z.number().optional(),
      region: z.string().optional(),
      horizonHours: z.number().default(24),
      intervalMinutes: z.number().default(15),
    }))
    .mutation(async ({ input, ctx }) => {
      return probabilisticForecasting.forecastLoad(
        { assetId: input.assetId, userId: ctx.user.id, communityId: input.communityId, region: input.region },
        input.horizonHours,
        input.intervalMinutes
      );
    }),

  forecastSolarGeneration: protectedProcedure
    .input(z.object({
      assetId: z.number().optional(),
      region: z.string().optional(),
      horizonHours: z.number().default(24),
      intervalMinutes: z.number().default(15),
    }))
    .mutation(async ({ input, ctx }) => {
      return probabilisticForecasting.forecastSolarGeneration(
        { assetId: input.assetId, userId: ctx.user.id, region: input.region },
        input.horizonHours,
        input.intervalMinutes
      );
    }),

  forecastPrice: protectedProcedure
    .input(z.object({
      region: z.string().default('NG-LAGOS'),
      horizonHours: z.number().default(24),
      intervalMinutes: z.number().default(60),
    }))
    .mutation(async ({ input }) => {
      return probabilisticForecasting.forecastPrice(input.region, input.horizonHours, input.intervalMinutes);
    }),

  forecastEmissions: protectedProcedure
    .input(z.object({
      region: z.string().default('NG-LAGOS'),
      horizonHours: z.number().default(24),
      intervalMinutes: z.number().default(60),
    }))
    .mutation(async ({ input }) => {
      return probabilisticForecasting.forecastEmissions(input.region, input.horizonHours, input.intervalMinutes);
    }),

  getForecast: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(async ({ input }) => {
      return probabilisticForecasting.getForecast(input.runId);
    }),

  /**
   * Measured accuracy of past forecasts. Defaults to the caller's own scope;
   * `unmeasuredRuns` travels with the metrics so a thin score cannot be read as
   * a good one.
   */
  accuracySummary: protectedProcedure
    .input(z.object({
      sinceDays: z.number().min(1).max(365).default(30),
      scopeType: z.enum(['asset', 'user', 'community', 'region']).optional(),
      scopeId: z.number().optional(),
    }))
    .query(async ({ input, ctx }) => {
      if (input.scopeType === 'asset') {
        if (input.scopeId == null) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'An asset scope needs an assetId' });
        }
        await requireAssetOwnership(ctx, input.scopeId);
      }

      if (input.scopeType === 'community') {
        if (input.scopeId == null) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'A community scope needs a communityId',
          });
        }
        await requireCommunityMembership(ctx, input.scopeId);
      }

      const scopeType = input.scopeType ?? 'user';
      const scopeId =
        input.scopeType === undefined
          ? ctx.user.id
          : input.scopeType === 'user' && ctx.user.role !== 'admin'
            ? ctx.user.id
            : input.scopeId;

      const rows = await getAccuracySummary({
        sinceDays: input.sinceDays,
        scopeType: scopeType === 'region' ? 'region' : scopeType,
        scopeId: scopeType === 'region' ? undefined : scopeId,
      });

      return {
        rows,
        targetCoverageBp: TARGET_COVERAGE_BP,
        minScoringSamples: MIN_SCORING_SAMPLES,
      };
    }),

  scoreRun: adminProcedure
    .input(z.object({ runId: z.string() }))
    .mutation(async ({ input }) => {
      return scoreForecastRun(input.runId);
    }),

  scoreDueRuns: adminProcedure
    .input(z.object({ limit: z.number().min(1).max(200).default(25) }))
    .mutation(async ({ input }) => {
      const scores = await scoreDueForecastRuns(input.limit);
      return {
        scored: scores.filter((score) => score.status === 'scored').length,
        unmeasured: scores.filter((score) => score.status === 'insufficient_actuals').length,
        scores,
      };
    }),
});
