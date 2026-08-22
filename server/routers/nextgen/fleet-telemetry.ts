import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';

import { adminProcedure, protectedProcedure, router } from '../../_core/trpc';
import { getDb } from '../../db';
import { communityMembers } from '../../../drizzle/nextgen-vpp-schema';
import {
  FleetTelemetryError,
  FleetScope,
  getRollingFleetTelemetry,
  rollUpFleetWindows,
} from '../../services/fleet-telemetry';

function toTRPCError(error: unknown): never {
  if (error instanceof FleetTelemetryError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
  }
  throw error;
}

/** A community aggregate is readable by its active members; nothing wider is. */
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

const windowInput = z.object({
  bucketMinutes: z.number().int().min(5).max(60).default(15),
  buckets: z.number().int().min(1).max(192).default(96),
});

export const fleetTelemetryRouter = router({
  /**
   * Rolling aggregate for the whole fleet or one region.
   *
   * Admin-only: a fleet-wide profile is a picture of every participant's
   * consumption, and a regional one is a picture of a neighbourhood's.
   */
  rolling: adminProcedure
    .input(
      windowInput
        .extend({
          scopeType: z.enum(['fleet', 'region']).default('fleet'),
          region: z.string().max(50).optional(),
        })
        .refine(input => input.scopeType !== 'region' || !!input.region, {
          message: 'A region aggregate needs a region code',
          path: ['region'],
        })
    )
    .query(async ({ input }) => {
      const scope: FleetScope =
        input.scopeType === 'region'
          ? { scopeType: 'region', region: input.region }
          : { scopeType: 'fleet' };
      try {
        return await getRollingFleetTelemetry(scope, {
          bucketMinutes: input.bucketMinutes,
          buckets: input.buckets,
        });
      } catch (error) {
        toTRPCError(error);
      }
    }),

  /** Rolling aggregate for one community, readable by its active members. */
  community: protectedProcedure
    .input(windowInput.extend({ communityId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      await requireCommunityMembership(ctx, input.communityId);
      try {
        return await getRollingFleetTelemetry(
          { scopeType: 'community', scopeId: input.communityId },
          { bucketMinutes: input.bucketMinutes, buckets: input.buckets }
        );
      } catch (error) {
        toTRPCError(error);
      }
    }),

  /**
   * Recompute the most recent buckets now.
   *
   * The scheduled rollup is opt-in per deployment, so operators need a way to
   * advance the series by hand without that being mistaken for fresh telemetry.
   */
  rollUp: adminProcedure
    .input(
      z
        .object({
          bucketMinutes: z.number().int().min(5).max(60).default(15),
          buckets: z.number().int().min(1).max(96).default(4),
          scopeType: z.enum(['fleet', 'region', 'community']).default('fleet'),
          scopeId: z.number().int().positive().optional(),
          region: z.string().max(50).optional(),
        })
        .refine(input => input.scopeType !== 'region' || !!input.region, {
          message: 'A region aggregate needs a region code',
          path: ['region'],
        })
        .refine(input => input.scopeType !== 'community' || input.scopeId !== undefined, {
          message: 'A community aggregate needs a community id',
          path: ['scopeId'],
        })
    )
    .mutation(async ({ input }) => {
      const scope: FleetScope = {
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        region: input.region,
      };
      try {
        const written = await rollUpFleetWindows(scope, {
          bucketMinutes: input.bucketMinutes,
          buckets: input.buckets,
        });
        return { buckets: written };
      } catch (error) {
        toTRPCError(error);
      }
    }),
});
