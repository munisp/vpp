import { z } from 'zod';
import { router, protectedProcedure } from '../../_core/trpc';
import { TRPCError } from '@trpc/server';
import { assessUser, getAssessment, listAssessments } from '../../services/innov3-island-monitor';

function toError(error: unknown): TRPCError {
  if (error instanceof Error && error.message.includes('not found')) {
    return new TRPCError({ code: 'NOT_FOUND', message: error.message });
  }
  console.error('[Innov3IslandMonitor]', error);
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Island assessment failed.' });
}

/**
 * Island-mode monitor router (innovation 18).
 *
 * Autonomy is assessed from the user's REGISTERED storage (capacity Wh,
 * registered usable floor, measured SoC) and measured consumption rate via
 * the shared assessResilience logic — never from an assumed battery. When
 * an input is missing the assessment is persisted with
 * assessmentAvailable:false and the reason. Island event detection is
 * honestly recorded as unavailable: the platform has no per-site
 * grid-status field.
 */
export const islandMonitorRouter = router({
  /** Assess the user's island autonomy now; persists the assessment row. */
  assessNow: protectedProcedure.mutation(async ({ ctx }) => {
    try {
      return await assessUser(ctx.user.id);
    } catch (error) {
      throw toError(error);
    }
  }),

  getAssessment: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      try {
        return await getAssessment(ctx.user.id, input.id);
      } catch (error) {
        throw toError(error);
      }
    }),

  listAssessments: protectedProcedure
    .input(z.object({ limit: z.number().int().positive().max(100).default(20) }))
    .query(async ({ ctx, input }) => {
      try {
        return { assessments: await listAssessments(ctx.user.id, input.limit) };
      } catch (error) {
        throw toError(error);
      }
    }),
});

export type IslandMonitorRouter = typeof islandMonitorRouter;
