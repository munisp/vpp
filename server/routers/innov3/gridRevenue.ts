import { z } from 'zod';
import { router, protectedProcedure } from '../../_core/trpc';
import { TRPCError } from '@trpc/server';
import {
  getRevenueSummary,
  listRevenues,
  recordRevenue,
  syncUserRevenues,
} from '../../services/innov3-grid-revenue';

function toError(error: unknown, fallback: string): TRPCError {
  const message = error instanceof Error ? error.message : '';
  if (message === 'SOURCE_NOT_FOUND') return new TRPCError({ code: 'NOT_FOUND', message: 'No record with that id exists in the named source table.' });
  if (message === 'SOURCE_USER_MISMATCH') return new TRPCError({ code: 'FORBIDDEN', message: 'That source record belongs to another user.' });
  if (message === 'SOURCE_NOT_PAYABLE') return new TRPCError({ code: 'PRECONDITION_FAILED', message: 'The source record exists but is not an earning yet (e.g. compensation not paid, reward not processed).' });
  if (message === 'UNKNOWN_SOURCE_TYPE') return new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown revenue source type.' });
  console.error('[GridRevenue]', error);
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: fallback });
}

const sourceTypeSchema = z.enum(['dr_compensation', 'p2p_match', 'referral_reward']);

/**
 * Grid-services revenue ledger.
 *
 * Earnings are never entered by hand: each row is recorded from a real
 * source record (a paid drCompensation row, a p2p_matches fill the caller
 * sold into, or a processed referral_rewards row) and unknown or unearned
 * sources are refused. Aggregates are grouped per currency — currencies are
 * never summed together.
 */
export const gridRevenueRouter = router({
  // Record one earning from a specific source record (idempotent).
  record: protectedProcedure
    .input(z.object({ sourceType: sourceTypeSchema, sourceId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await recordRevenue(ctx.user.id, input.sourceType, input.sourceId);
      } catch (error) {
        throw toError(error, 'Failed to record revenue.');
      }
    }),

  // Scan all real source tables and record everything currently earned.
  sync: protectedProcedure
    .mutation(async ({ ctx }) => {
      try {
        return await syncUserRevenues(ctx.user.id);
      } catch (error) {
        throw toError(error, 'Failed to sync revenues.');
      }
    }),

  list: protectedProcedure
    .input(z.object({
      limit: z.number().int().positive().max(200).default(50),
      sourceType: sourceTypeSchema.optional(),
    }))
    .query(async ({ ctx, input }) => {
      try {
        return await listRevenues(ctx.user.id, input);
      } catch (error) {
        throw toError(error, 'Failed to list revenues.');
      }
    }),

  // Totals by source and by UTC month, per currency.
  summary: protectedProcedure
    .input(z.object({
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    }))
    .query(async ({ ctx, input }) => {
      try {
        return await getRevenueSummary(ctx.user.id, input);
      } catch (error) {
        throw toError(error, 'Failed to compute revenue summary.');
      }
    }),
});

export type GridRevenueRouter = typeof gridRevenueRouter;
