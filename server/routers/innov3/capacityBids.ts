import { z } from 'zod';
import { router, protectedProcedure, adminProcedure } from '../../_core/trpc';
import { TRPCError } from '@trpc/server';
import {
  buildBid,
  CapacityBidError,
  getBid,
  listBids,
  recordOutcome,
  submitBid,
  withdrawBid,
} from '../../services/innov3-capacity-bids';

function toError(error: unknown): TRPCError {
  if (error instanceof CapacityBidError) {
    const notFound = error.message.includes('not found');
    return new TRPCError({ code: notFound ? 'NOT_FOUND' : 'BAD_REQUEST', message: error.message });
  }
  console.error('[Innov3CapacityBids]', error);
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Capacity bid operation failed.' });
}

/**
 * Capacity bid builder router (innovation 17).
 *
 * Bids are built from the user's real registered flexible capacity minus
 * real recorded commitments. When capacity cannot be established from
 * registered data the bid is persisted with bidAvailable:false and reason
 * 'unknown_capacity', and cannot be submitted. Outcomes are recorded only
 * by an operator, from real inputs.
 */
export const capacityBidsRouter = router({
  /** Build a draft bid for a delivery window. */
  buildBid: protectedProcedure
    .input(
      z.object({
        deliveryStart: z.coerce.date(),
        deliveryEnd: z.coerce.date(),
        priceCentsPerKwh: z.number().int().nonnegative().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await buildBid(ctx.user.id, input);
      } catch (error) {
        throw toError(error);
      }
    }),

  /** Submit a draft bid (refused when unavailable or offering zero watts). */
  submitBid: protectedProcedure
    .input(z.object({ bidId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await submitBid(ctx.user.id, input.bidId);
      } catch (error) {
        throw toError(error);
      }
    }),

  /** Withdraw a draft or submitted bid. */
  withdrawBid: protectedProcedure
    .input(z.object({ bidId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await withdrawBid(ctx.user.id, input.bidId);
      } catch (error) {
        throw toError(error);
      }
    }),

  /**
   * Operator: record the real outcome of a submitted bid. The only path to
   * awarded/rejected; requires a note naming what the outcome is based on.
   */
  recordOutcome: adminProcedure
    .input(
      z.object({
        bidId: z.number().int().positive(),
        outcome: z.enum(['awarded', 'rejected']),
        note: z.string().min(1).max(500),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await recordOutcome(ctx.user.id, input.bidId, input.outcome, input.note);
      } catch (error) {
        throw toError(error);
      }
    }),

  getBid: protectedProcedure
    .input(z.object({ bidId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      try {
        return await getBid(ctx.user.id, input.bidId);
      } catch (error) {
        throw toError(error);
      }
    }),

  listBids: protectedProcedure
    .input(z.object({ limit: z.number().int().positive().max(100).default(20) }))
    .query(async ({ ctx, input }) => {
      try {
        return { bids: await listBids(ctx.user.id, input.limit) };
      } catch (error) {
        throw toError(error);
      }
    }),
});

export type CapacityBidsRouter = typeof capacityBidsRouter;
