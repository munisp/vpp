import { z } from 'zod';
import { router, protectedProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import { communityPools } from '../services/community-pools';

const RuleTypeSchema = z.enum(['proportional_consumption', 'equal', 'proportional_generation', 'custom_weights']);

/**
 * Community energy pools router — allocation rules engine.
 * Pool rules are set by pool admins; allocation runs value real pool
 * surplus/deficit at real period prices (community service getPeriodPrices;
 * its insufficient-data error is propagated).
 */
export const communityPoolsRouter = router({
  /**
   * Set/replace the pool's allocation rule (pool admin/operator or platform admin).
   */
  setPoolRules: protectedProcedure
    .input(z.object({
      communityId: z.number().int().positive(),
      ruleType: RuleTypeSchema,
      customWeights: z.record(z.string(), z.number().positive()).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        const rule = await communityPools.setPoolRules(
          input.communityId,
          ctx.user.id,
          ctx.user.role === 'admin',
          { ruleType: input.ruleType, customWeights: input.customWeights }
        );
        return { success: true, rule };
      } catch (error: any) {
        console.error('[CommunityPools] setPoolRules error:', error);
        throw new TRPCError({ code: 'BAD_REQUEST', message: error.message || 'Failed to set pool rules' });
      }
    }),

  /**
   * Read the pool's current rule (members).
   */
  getPoolRules: protectedProcedure
    .input(z.object({ communityId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      try {
        await communityPools.requireMembership(input.communityId, ctx.user.id, ctx.user.role === 'admin');
        const rule = await communityPools.getPoolRules(input.communityId);
        return { rule };
      } catch (error: any) {
        console.error('[CommunityPools] getPoolRules error:', error);
        throw new TRPCError({ code: 'FORBIDDEN', message: error.message || 'Failed to load pool rules' });
      }
    }),

  /**
   * Run an allocation over a period (pool admin/operator or platform admin).
   */
  runAllocation: protectedProcedure
    .input(z.object({
      communityId: z.number().int().positive(),
      periodStart: z.coerce.date(),
      periodEnd: z.coerce.date(),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await communityPools.runAllocation(
          input.communityId,
          input.periodStart,
          input.periodEnd,
          ctx.user.id,
          ctx.user.role === 'admin'
        );
      } catch (error: any) {
        console.error('[CommunityPools] runAllocation error:', error);
        throw new TRPCError({ code: 'BAD_REQUEST', message: error.message || 'Allocation run failed' });
      }
    }),

  /**
   * The caller's statement for a run (defaults to the latest run).
   */
  getMyStatement: protectedProcedure
    .input(z.object({
      communityId: z.number().int().positive(),
      runId: z.number().int().positive().optional(),
    }))
    .query(async ({ ctx, input }) => {
      try {
        return await communityPools.getMyStatement(input.communityId, ctx.user.id, input.runId);
      } catch (error: any) {
        console.error('[CommunityPools] getMyStatement error:', error);
        throw new TRPCError({ code: 'BAD_REQUEST', message: error.message || 'Failed to load statement' });
      }
    }),

  /**
   * List allocation runs for a community (members / platform admin).
   */
  listRuns: protectedProcedure
    .input(z.object({
      communityId: z.number().int().positive(),
      limit: z.number().int().positive().max(100).default(20),
    }))
    .query(async ({ ctx, input }) => {
      try {
        const runs = await communityPools.listRuns(input.communityId, ctx.user.id, ctx.user.role === 'admin', input.limit);
        return { runs, count: runs.length };
      } catch (error: any) {
        console.error('[CommunityPools] listRuns error:', error);
        throw new TRPCError({ code: 'FORBIDDEN', message: error.message || 'Failed to list allocation runs' });
      }
    }),
});
