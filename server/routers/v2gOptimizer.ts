import { z } from 'zod';
import { router, protectedProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import { v2gOptimizer } from '../services/v2g-optimizer';

/**
 * V2G departure-aware optimizer router.
 * Schedules are computed from real market prices or the trained ML forecast;
 * when no real price series exists the plan endpoint returns
 * { scheduleAvailable: false, reason }.
 */
export const v2gOptimizerRouter = router({
  /**
   * Compute and persist a departure-aware charge/discharge schedule.
   */
  planSchedule: protectedProcedure
    .input(z.object({
      evId: z.number().int().positive(),
      departureTime: z.coerce.date(),
      targetSocPercent: z.number().min(0).max(100),
      minSocReservePercent: z.number().min(0).max(100).optional(),
      allowV2g: z.boolean().default(false),
      batteryCapacityKwh: z.number().positive().optional(),
      startSocPercent: z.number().min(0).max(100).optional(),
      maxChargeKw: z.number().positive().optional(),
      maxDischargeKw: z.number().positive().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await v2gOptimizer.planSchedule(ctx.user.id, input);
      } catch (error: any) {
        console.error('[V2GOptimizer] planSchedule error:', error);
        throw new TRPCError({ code: 'BAD_REQUEST', message: error.message || 'Failed to compute schedule' });
      }
    }),

  /**
   * Get one of the caller's schedules.
   */
  getSchedule: protectedProcedure
    .input(z.object({ scheduleId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const schedule = await v2gOptimizer.getSchedule(input.scheduleId);
      if (!schedule) throw new TRPCError({ code: 'NOT_FOUND', message: 'Schedule not found' });
      if (schedule.userId !== ctx.user.id && ctx.user.role !== 'admin') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Schedule does not belong to you' });
      }
      return { ...schedule, intervals: JSON.parse(schedule.scheduleJson) };
    }),

  /**
   * List the caller's schedules (newest first).
   */
  listSchedules: protectedProcedure
    .input(z.object({ limit: z.number().int().positive().max(100).default(20) }))
    .query(async ({ ctx, input }) => {
      try {
        const schedules = await v2gOptimizer.listSchedules(ctx.user.id, input.limit);
        return { schedules, count: schedules.length };
      } catch (error: any) {
        console.error('[V2GOptimizer] listSchedules error:', error);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to retrieve schedules' });
      }
    }),

  /**
   * Cancel an active/draft schedule.
   */
  cancelSchedule: protectedProcedure
    .input(z.object({ scheduleId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const schedule = await v2gOptimizer.cancelSchedule(input.scheduleId, ctx.user.id);
        return { success: true, schedule };
      } catch (error: any) {
        console.error('[V2GOptimizer] cancelSchedule error:', error);
        throw new TRPCError({ code: 'BAD_REQUEST', message: error.message || 'Failed to cancel schedule' });
      }
    }),
});
