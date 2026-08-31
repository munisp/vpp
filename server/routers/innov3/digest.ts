import { z } from 'zod';
import { router, protectedProcedure } from '../../_core/trpc';
import { TRPCError } from '@trpc/server';
import {
  compileWeeklyStats,
  isoWeekStart,
  listMyRuns,
  listMySubscriptions,
  subscribeDigest,
  unsubscribeDigest,
} from '../../services/innov3-digest';

function toError(error: unknown, fallback: string): TRPCError {
  const message = error instanceof Error ? error.message : '';
  if (message === 'USER_NOT_FOUND') return new TRPCError({ code: 'NOT_FOUND', message: 'User not found.' });
  if (message === 'NO_EMAIL_ON_FILE') return new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Add an email address to your account before subscribing to the email digest.' });
  if (message === 'NO_PHONE_ON_FILE') return new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Add a phone number to your account before subscribing to the SMS digest.' });
  if (message === 'SUBSCRIPTION_NOT_FOUND') return new TRPCError({ code: 'NOT_FOUND', message: 'No subscription on that channel.' });
  console.error('[Digest]', error);
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: fallback });
}

const channelSchema = z.enum(['email', 'sms']);

/**
 * Weekly digest subscriptions.
 *
 * Dispatch runs happen in the scheduler via runWeeklyDigests() (exported
 * from server/services/innov3-digest.ts). This router covers opt-in/out and
 * inspecting the real, recorded run history. `preview` compiles the
 * caller's current week-to-date stats without sending anything.
 */
export const digestRouter = router({
  subscribe: protectedProcedure
    .input(z.object({ channel: channelSchema }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await subscribeDigest(ctx.user.id, input.channel);
      } catch (error) {
        throw toError(error, 'Failed to subscribe.');
      }
    }),

  unsubscribe: protectedProcedure
    .input(z.object({ channel: channelSchema }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await unsubscribeDigest(ctx.user.id, input.channel);
      } catch (error) {
        throw toError(error, 'Failed to unsubscribe.');
      }
    }),

  mySubscriptions: protectedProcedure
    .query(async ({ ctx }) => {
      try {
        return await listMySubscriptions(ctx.user.id);
      } catch (error) {
        throw toError(error, 'Failed to list subscriptions.');
      }
    }),

  // Recorded dispatch history: sent / failed / skipped with real errors.
  myRuns: protectedProcedure
    .input(z.object({ limit: z.number().int().positive().max(52).default(12) }))
    .query(async ({ ctx, input }) => {
      try {
        return await listMyRuns(ctx.user.id, input);
      } catch (error) {
        throw toError(error, 'Failed to list digest runs.');
      }
    }),

  // The caller's stats for the current week so far. Nulls mean "no data".
  preview: protectedProcedure
    .query(async ({ ctx }) => {
      try {
        const periodEnd = new Date();
        const periodStart = isoWeekStart(periodEnd);
        return await compileWeeklyStats(ctx.user.id, periodStart, periodEnd);
      } catch (error) {
        throw toError(error, 'Failed to compile weekly stats.');
      }
    }),
});

export type DigestRouter = typeof digestRouter;
