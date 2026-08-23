import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { eq, sql } from 'drizzle-orm';

import { adminProcedure, protectedProcedure, router } from '../../_core/trpc';
import { getDb } from '../../db';
import { priceSignalSites } from '../../../drizzle/price-signal-schema';
import {
  PriceSignalError,
  buildFleetSites,
  coordinateFleetSignal,
  getFleetSignal,
  listFleetSignals,
  publishFleetSignal,
  scoreFleetSignalResponse,
} from '../../services/price-signal';
import { MilpOptimizerError } from '../../services/milp-dispatch';

function toTRPCError(error: unknown): never {
  if (error instanceof PriceSignalError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
  }
  if (error instanceof MilpOptimizerError) {
    throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: error.message });
  }
  throw error;
}

export const priceSignalRouter = router({
  /**
   * Solve for the price that makes the fleet want the grid's profile.
   *
   * Admin-only: a fleet signal changes what every participating site pays.
   */
  coordinate: adminProcedure
    .input(
      z.object({
        userIds: z.array(z.number().int().positive()).min(1).max(200),
        intervalMinutes: z.number().int().min(5).max(60).default(15),
        startsAt: z.coerce.date(),
        targetNetW: z.array(z.number()).min(1).max(288),
        sharedImportLimitW: z.array(z.number().nonnegative()).min(1).max(288),
        siteImportLimitW: z.number().positive(),
        siteExportLimitW: z.number().nonnegative(),
        scopeType: z.enum(['fleet', 'community', 'region']).default('fleet'),
        scopeId: z.number().int().positive().optional(),
        region: z.string().max(50).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (input.targetNetW.length !== input.sharedImportLimitW.length) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'targetNetW and sharedImportLimitW must cover the same horizon',
        });
      }
      try {
        const built = await buildFleetSites({
          userIds: input.userIds,
          horizon: input.targetNetW.length,
          intervalMinutes: input.intervalMinutes,
          siteImportLimitW: input.siteImportLimitW,
          siteExportLimitW: input.siteExportLimitW,
          scopeType: input.scopeType,
          scopeId: input.scopeId,
          region: input.region,
        });

        const coordinated = await coordinateFleetSignal({
          sites: built.sites,
          intervalMinutes: input.intervalMinutes,
          startsAt: input.startsAt,
          targetNetW: input.targetNetW,
          sharedImportLimitW: input.sharedImportLimitW,
          baseImportPricesCentsPerKwh: built.baseImportPricesCentsPerKwh,
          createdBy: ctx.user.id,
          scopeType: input.scopeType,
          scopeId: input.scopeId,
          region: input.region,
        });

        return {
          signalId: coordinated.signalId,
          converged: coordinated.converged,
          // Sites left out are returned, not hidden: the caller asked for a
          // fleet and got a smaller one.
          excludedSites: built.excluded,
          signal: await getFleetSignal(coordinated.signalId),
        };
      } catch (error) {
        toTRPCError(error);
      }
    }),

  publish: adminProcedure
    .input(z.object({ signalId: z.string().min(1).max(64) }))
    .mutation(async ({ input }) => {
      try {
        const result = await publishFleetSignal(input.signalId);
        return { ...result, signal: await getFleetSignal(input.signalId) };
      } catch (error) {
        toTRPCError(error);
      }
    }),

  score: adminProcedure
    .input(z.object({ signalId: z.string().min(1).max(64) }))
    .mutation(async ({ input }) => {
      try {
        return { sites: await scoreFleetSignalResponse(input.signalId) };
      } catch (error) {
        toTRPCError(error);
      }
    }),

  list: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(10) }))
    .query(async ({ input }) => {
      try {
        return { signals: await listFleetSignals(input.limit) };
      } catch (error) {
        toTRPCError(error);
      }
    }),

  get: adminProcedure
    .input(z.object({ signalId: z.string().min(1).max(64) }))
    .query(async ({ input }) => {
      try {
        return await getFleetSignal(input.signalId);
      } catch (error) {
        toTRPCError(error);
      }
    }),

  /**
   * What the caller's own site was offered and what its meter did.
   *
   * Scoped to `ctx.user.id`, so no caller can read another site's plan or bill.
   */
  mySignals: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(20) }).optional())
    .query(async ({ input, ctx }) => {
      const limit = input?.limit ?? 20;
      const db = await getDb();
      if (!db) {
        throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'Database not available' });
      }
      const rows = await db
        .select()
        .from(priceSignalSites)
        .where(eq(priceSignalSites.userId, ctx.user.id))
        .orderBy(sql`${priceSignalSites.id} DESC`)
        .limit(limit);

      const signals = await Promise.all(
        rows.map(async row => {
          const signal = await getFleetSignal(row.signalId);
          return {
            signalId: signal.signalId,
            status: signal.status,
            startsAt: signal.startsAt,
            endsAt: signal.endsAt,
            intervalMinutes: signal.intervalMinutes,
            // Price only: the fleet's target and aggregate plan belong to the
            // operator, not to one participant in it.
            intervals: signal.intervals.map(interval => ({
              intervalIndex: interval.intervalIndex,
              startsAt: interval.startsAt,
              baseImportPriceCentsPerKwh: interval.baseImportPriceCentsPerKwh,
              signalAdjustmentCentsPerKwh: interval.signalAdjustmentCentsPerKwh,
            })),
            site: signal.sites.find(site => site.siteRef === row.siteRef) ?? null,
          };
        })
      );
      return { signals };
    }),
});
