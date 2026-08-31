import { z } from 'zod';
import { router, protectedProcedure } from '../../_core/trpc';
import { TRPCError } from '@trpc/server';
import {
  BudgetError,
  getBudget,
  listBudgets,
  listCheckpoints,
  recordCheckpoint,
  setBudget,
} from '../../services/innov3-budget-planner';

function toError(error: unknown): TRPCError {
  if (error instanceof BudgetError) {
    const notFound = error.message.includes('not found');
    return new TRPCError({ code: notFound ? 'NOT_FOUND' : 'BAD_REQUEST', message: error.message });
  }
  console.error('[Innov3BudgetPlanner]', error);
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Budget operation failed.' });
}

/**
 * Energy budget planner router (innovation 20).
 *
 * Monthly kWh and/or cost targets with weekly checkpoints of real measured
 * consumption pace (meter register deltas, falling back to real billings).
 * Month-end figures are pace projections, labelled as such, and withheld
 * (projectionAvailable:false) until at least 3 days of real data exist.
 */
export const budgetPlannerRouter = router({
  /** Create or update the user's budget for a month. */
  setBudget: protectedProcedure
    .input(
      z.object({
        year: z.number().int().min(2020).max(2100),
        month: z.number().int().min(1).max(12),
        targetKwh: z.number().int().positive().nullish(),
        targetCostCents: z.number().int().positive().nullish(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await setBudget(ctx.user.id, input);
      } catch (error) {
        throw toError(error);
      }
    }),

  listBudgets: protectedProcedure
    .input(z.object({ limit: z.number().int().positive().max(60).default(12) }))
    .query(async ({ ctx, input }) => {
      try {
        return { budgets: await listBudgets(ctx.user.id, input.limit) };
      } catch (error) {
        throw toError(error);
      }
    }),

  getBudget: protectedProcedure
    .input(z.object({ budgetId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      try {
        return await getBudget(ctx.user.id, input.budgetId);
      } catch (error) {
        throw toError(error);
      }
    }),

  /** Record (or refresh) this week's checkpoint against the budget. */
  recordCheckpoint: protectedProcedure
    .input(z.object({ budgetId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await recordCheckpoint(ctx.user.id, input.budgetId);
      } catch (error) {
        throw toError(error);
      }
    }),

  listCheckpoints: protectedProcedure
    .input(
      z.object({
        budgetId: z.number().int().positive(),
        limit: z.number().int().positive().max(60).default(12),
      })
    )
    .query(async ({ ctx, input }) => {
      try {
        return { checkpoints: await listCheckpoints(ctx.user.id, input.budgetId, input.limit) };
      } catch (error) {
        throw toError(error);
      }
    }),
});

export type BudgetPlannerRouter = typeof budgetPlannerRouter;
