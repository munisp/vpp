import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { adminProcedure, protectedProcedure, router } from '../../_core/trpc';
import {
  LocationalFlexibilityError,
  clearRequirement,
  createGridNode,
  createRequirement,
  linkAssetToNode,
  listNodeHeadroom,
  listOpenRequirementsForOwner,
  listOwnerAwards,
  listRequirements,
  measureAward,
  measureRequirement,
  settleAward,
  submitOffer,
} from '../../services/locational-flexibility';

function toTRPCError(error: unknown): never {
  if (error instanceof LocationalFlexibilityError) {
    throw new TRPCError({
      code: error.message === 'Database not available' ? 'SERVICE_UNAVAILABLE' : 'BAD_REQUEST',
      message: error.message,
    });
  }
  throw error;
}

export const locationalFlexibilityRouter = router({
  /**
   * Nodes and what could be offered behind them.
   *
   * Admin-only: node topology plus the assets behind each node is network
   * information, and the unverified-capacity figure is an operator's problem to
   * resolve, not a participant's.
   */
  nodes: adminProcedure
    .input(z.object({ region: z.string().max(100).optional() }).default({}))
    .query(async ({ input }) => {
      try {
        return await listNodeHeadroom(input.region);
      } catch (error) {
        toTRPCError(error);
      }
    }),

  createNode: adminProcedure
    .input(
      z.object({
        code: z.string().min(1).max(80),
        name: z.string().min(1).max(200),
        kind: z.enum(['substation', 'feeder', 'transformer']),
        parentNodeId: z.number().int().positive().optional(),
        region: z.string().max(100).optional(),
        firmCapacityW: z.number().int().positive().optional(),
      })
    )
    .mutation(async ({ input }) => {
      try {
        return { nodeId: await createGridNode(input) };
      } catch (error) {
        toTRPCError(error);
      }
    }),

  /**
   * Record which node an asset is behind.
   *
   * Admin-only and provenance-bearing: this claim decides whether the asset's
   * capacity may be sold as relief at that node.
   */
  linkAsset: adminProcedure
    .input(
      z.object({
        nodeId: z.number().int().positive(),
        assetId: z.number().int().positive(),
        linkSource: z.enum(['operator_declared', 'utility_verified', 'unverified']),
        evidence: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await linkAssetToNode({ ...input, linkedByUserId: ctx.user.id });
        return { linked: true };
      } catch (error) {
        toTRPCError(error);
      }
    }),

  requirements: adminProcedure
    .input(
      z
        .object({
          nodeId: z.number().int().positive().optional(),
          region: z.string().max(100).optional(),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .default({ limit: 50 })
    )
    .query(async ({ input }) => {
      try {
        return await listRequirements(input);
      } catch (error) {
        toTRPCError(error);
      }
    }),

  createRequirement: adminProcedure
    .input(
      z
        .object({
          nodeId: z.number().int().positive(),
          direction: z.enum(['import_reduction', 'export_reduction']),
          startsAt: z.coerce.date(),
          endsAt: z.coerce.date(),
          requiredPowerW: z.number().int().positive(),
          priceCapCentsPerKwh: z.number().int().min(0),
          currency: z.enum(['NGN', 'TZS', 'USD']).default('TZS'),
          notes: z.string().max(500).optional(),
        })
        .refine(input => input.endsAt.getTime() > input.startsAt.getTime(), {
          message: 'A requirement window must end after it starts',
          path: ['endsAt'],
        })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return { requirementId: await createRequirement(input, ctx.user.id) };
      } catch (error) {
        toTRPCError(error);
      }
    }),

  /** Clear in merit order. Reports the ineligible offers with their reasons. */
  clear: adminProcedure
    .input(z.object({ requirementId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      try {
        return await clearRequirement(input.requirementId);
      } catch (error) {
        toTRPCError(error);
      }
    }),

  /** Measure delivery after the window has elapsed. */
  measure: adminProcedure
    .input(
      z.union([
        z.object({ awardId: z.number().int().positive() }),
        z.object({ requirementId: z.number().int().positive() }),
      ])
    )
    .mutation(async ({ input }) => {
      try {
        if ('awardId' in input) {
          return { results: [await measureAward(input.awardId)] };
        }
        return { results: await measureRequirement(input.requirementId) };
      } catch (error) {
        toTRPCError(error);
      }
    }),

  /**
   * Settle one measured award into the ledger. Refuses unverified or
   * not-delivered awards, and refuses a second settlement of the same award.
   */
  settle: adminProcedure
    .input(z.object({ awardId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      try {
        return await settleAward(input.awardId);
      } catch (error) {
        toTRPCError(error);
      }
    }),

  /** Requirements the caller's own assets are eligible to offer into. */
  myOpportunities: protectedProcedure.query(async ({ ctx }) => {
    try {
      return await listOpenRequirementsForOwner(ctx.user.id);
    } catch (error) {
      toTRPCError(error);
    }
  }),

  /** The caller's own offer. Ownership is enforced in the service. */
  offer: protectedProcedure
    .input(
      z.object({
        requirementId: z.number().int().positive(),
        assetId: z.number().int().positive(),
        offeredPowerW: z.number().int().positive(),
        priceCentsPerKwh: z.number().int().min(0),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return { offerId: await submitOffer(input, ctx.user.id) };
      } catch (error) {
        toTRPCError(error);
      }
    }),

  /** The caller's awards with the measurement behind each figure. */
  myAwards: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(25) }).default({ limit: 25 }))
    .query(async ({ ctx, input }) => {
      try {
        return await listOwnerAwards(ctx.user.id, input.limit);
      } catch (error) {
        toTRPCError(error);
      }
    }),
});
