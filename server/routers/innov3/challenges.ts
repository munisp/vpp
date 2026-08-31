import { z } from 'zod';
import { router, protectedProcedure } from '../../_core/trpc';
import { TRPCError } from '@trpc/server';
import {
  createChallenge,
  getChallenge,
  getLeaderboard,
  getMyProgress,
  joinChallenge,
  listChallenges,
  setChallengeStatus,
  withdrawFromChallenge,
} from '../../services/innov3-challenges';

function toError(error: unknown, fallback: string): TRPCError {
  const message = error instanceof Error ? error.message : '';
  if (message === 'CHALLENGE_NOT_FOUND') return new TRPCError({ code: 'NOT_FOUND', message: 'Challenge not found.' });
  if (message === 'CHALLENGE_NOT_OPEN') return new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Challenge is not open (closed/cancelled), or you are not its creator.' });
  if (message === 'ALREADY_JOINED') return new TRPCError({ code: 'CONFLICT', message: 'You have already joined this challenge.' });
  if (message === 'ENTRY_NOT_ACTIVE') return new TRPCError({ code: 'PRECONDITION_FAILED', message: 'No active participation to withdraw.' });
  if (message === 'INVALID_GOAL') return new TRPCError({ code: 'BAD_REQUEST', message: 'Goal must be between 0 and 100 percent.' });
  if (message === 'INVALID_WINDOW') return new TRPCError({ code: 'BAD_REQUEST', message: "Invalid windows: baseline must fully precede the measurement window, and each window's start must be before its end." });
  if (message === 'INVALID_INPUT') return new TRPCError({ code: 'BAD_REQUEST', message: 'A title is required.' });
  console.error('[Challenges]', error);
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: fallback });
}

/**
 * Community challenges.
 *
 * Goals are declared by a creator against explicit baseline and measurement
 * windows; progress and the leaderboard are computed from real meter
 * telemetry on read. Participants without baseline readings appear with
 * progressAvailable:false and a reason — they are unranked, not zero.
 */
export const challengesRouter = router({
  create: protectedProcedure
    .input(z.object({
      title: z.string().min(1).max(255),
      description: z.string().max(4000).optional(),
      /** Percent * 100 (1500 = 15% reduction goal). */
      goalPercent100: z.number().int().positive().max(10000),
      baselineStart: z.coerce.date(),
      baselineEnd: z.coerce.date(),
      periodStart: z.coerce.date(),
      periodEnd: z.coerce.date(),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await createChallenge(ctx.user.id, input);
      } catch (error) {
        throw toError(error, 'Failed to create challenge.');
      }
    }),

  list: protectedProcedure
    .input(z.object({
      limit: z.number().int().positive().max(100).default(50),
      status: z.enum(['open', 'closed', 'cancelled']).optional(),
    }))
    .query(async ({ input }) => {
      try {
        return await listChallenges(input);
      } catch (error) {
        throw toError(error, 'Failed to list challenges.');
      }
    }),

  get: protectedProcedure
    .input(z.object({ challengeId: z.number().int().positive() }))
    .query(async ({ input }) => {
      try {
        return await getChallenge(input.challengeId);
      } catch (error) {
        throw toError(error, 'Failed to load challenge.');
      }
    }),

  join: protectedProcedure
    .input(z.object({ challengeId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await joinChallenge(ctx.user.id, input.challengeId);
      } catch (error) {
        throw toError(error, 'Failed to join challenge.');
      }
    }),

  withdraw: protectedProcedure
    .input(z.object({ challengeId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await withdrawFromChallenge(ctx.user.id, input.challengeId);
      } catch (error) {
        throw toError(error, 'Failed to withdraw from challenge.');
      }
    }),

  close: protectedProcedure
    .input(z.object({ challengeId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await setChallengeStatus(ctx.user.id, input.challengeId, 'closed');
      } catch (error) {
        throw toError(error, 'Failed to close challenge.');
      }
    }),

  cancel: protectedProcedure
    .input(z.object({ challengeId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await setChallengeStatus(ctx.user.id, input.challengeId, 'cancelled');
      } catch (error) {
        throw toError(error, 'Failed to cancel challenge.');
      }
    }),

  // Computed from real telemetry at read time; unranked entries carry
  // progressAvailable:false with their reason.
  leaderboard: protectedProcedure
    .input(z.object({ challengeId: z.number().int().positive() }))
    .query(async ({ input }) => {
      try {
        return await getLeaderboard(input.challengeId);
      } catch (error) {
        throw toError(error, 'Failed to compute leaderboard.');
      }
    }),

  myProgress: protectedProcedure
    .input(z.object({ challengeId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      try {
        return await getMyProgress(ctx.user.id, input.challengeId);
      } catch (error) {
        throw toError(error, 'Failed to compute your progress.');
      }
    }),
});

export type ChallengesRouter = typeof challengesRouter;
