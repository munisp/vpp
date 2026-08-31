import { z } from 'zod';
import { router, protectedProcedure } from '../../_core/trpc';
import { TRPCError } from '@trpc/server';
import { listVerifications, verifySavings } from '../../services/innov3-savings-verifier';

function toError(error: unknown): TRPCError {
  const message = error instanceof Error ? error.message : '';
  if (message === 'ASSET_NOT_FOUND') return new TRPCError({ code: 'NOT_FOUND', message: 'Asset not found.' });
  if (message === 'ASSET_NOT_OWNED') return new TRPCError({ code: 'FORBIDDEN', message: 'You do not own this asset.' });
  if (message === 'INVALID_PERIOD') return new TRPCError({ code: 'BAD_REQUEST', message: 'Each period must end after it starts.' });
  if (message === 'PERIODS_OVERLAP') return new TRPCError({ code: 'BAD_REQUEST', message: 'Baseline and reporting periods must not overlap.' });
  console.error('[SavingsVerifier]', error);
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Savings verification failed.' });
}

/**
 * M&V savings verifier router.
 *
 * Baseline and reporting periods are measured from the asset's real
 * telemetry. When either period's coverage falls below 80% of hourly
 * buckets, the result is verifiable:false with the reason — the refusal
 * is persisted, not hidden.
 */
export const savingsVerifierRouter = router({
  verify: protectedProcedure
    .input(z.object({
      assetId: z.number().int().positive(),
      baselineStart: z.coerce.date(),
      baselineEnd: z.coerce.date(),
      reportingStart: z.coerce.date(),
      reportingEnd: z.coerce.date(),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await verifySavings(ctx.user.id, input);
      } catch (error) {
        throw toError(error);
      }
    }),

  history: protectedProcedure
    .input(z.object({
      assetId: z.number().int().positive(),
      limit: z.number().int().positive().max(100).default(20),
    }))
    .query(async ({ ctx, input }) => {
      try {
        const verifications = await listVerifications(ctx.user.id, input.assetId, input.limit);
        return { verifications, count: verifications.length };
      } catch (error) {
        throw toError(error);
      }
    }),
});

export type SavingsVerifierRouter = typeof savingsVerifierRouter;
