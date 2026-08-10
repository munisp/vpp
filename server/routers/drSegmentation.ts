import { z } from 'zod';
import { router, protectedProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import { DRSegmentationEngine } from '../dr-segmentation';

/**
 * Admin-only procedure
 */
const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== 'admin') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Admin access required',
    });
  }
  return next({ ctx });
});

/**
 * DR Segmentation Router
 * Participant scoring and segmentation
 */
export const drSegmentationRouter = router({
  /**
   * Get participant score
   */
  getParticipantScore: protectedProcedure
    .input(z.object({ userId: z.number().optional() }))
    .query(async ({ input, ctx }) => {
      const userId = input.userId || ctx.user.id;
      await DRSegmentationEngine.updateParticipantScore(userId);
      return await DRSegmentationEngine.calculateParticipantScore(userId);
    }),

  /**
   * Update all participant scores (admin only)
   */
  updateAllScores: adminProcedure.mutation(async () => {
    const updated = await DRSegmentationEngine.updateAllScores();
    return { updated };
  }),

  /**
   * Get participants by segment (admin only)
   */
  getParticipantsBySegment: adminProcedure
    .input(z.object({ segment: z.enum(['platinum', 'gold', 'silver', 'bronze', 'inactive']) }))
    .query(async ({ input }) => {
      return await DRSegmentationEngine.getParticipantsBySegment(input.segment);
    }),

  /**
   * Get top performers (admin only)
   */
  getTopPerformers: adminProcedure
    .input(z.object({ limit: z.number().default(10) }))
    .query(async ({ input }) => {
      return await DRSegmentationEngine.getTopPerformers(input.limit);
    }),

  /**
   * Get targeted participants for campaign (admin only)
   */
  getTargetedParticipants: adminProcedure
    .input(
      z.object({
        minScore: z.number().optional(),
        segments: z.array(z.string()).optional(),
        minCapacity: z.number().optional(),
        limit: z.number().optional(),
      })
    )
    .query(async ({ input }) => {
      return await DRSegmentationEngine.getTargetedParticipants(input);
    }),

  /**
   * Get segment distribution (admin only)
   */
  getSegmentDistribution: adminProcedure.query(async () => {
    return await DRSegmentationEngine.getSegmentDistribution();
  }),

  /**
   * Predict participation likelihood
   */
  predictParticipation: protectedProcedure
    .input(
      z.object({
        userId: z.number().optional(),
        compensationRate: z.number(),
        targetReduction: z.number(),
        urgency: z.enum(['low', 'medium', 'high']),
      })
    )
    .query(async ({ input, ctx }) => {
      const userId = input.userId || ctx.user.id;
      return await DRSegmentationEngine.predictParticipation(userId, {
        compensationRate: input.compensationRate,
        targetReduction: input.targetReduction,
        urgency: input.urgency,
      });
    }),
});
