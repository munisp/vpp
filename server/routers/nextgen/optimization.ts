import { z } from 'zod';
import { protectedProcedure, router } from '../../_core/trpc';
import { optimizationEngine } from '../../services/optimization-engine';

export const optimizationRouter = router({
  optimize: protectedProcedure
    .input(z.object({
      objective: z.enum(['minimize_cost', 'maximize_revenue', 'minimize_emissions', 'maximize_self_consumption', 'balance_grid']),
      horizonHours: z.number().default(24),
      intervalMinutes: z.number().default(15),
      assetIds: z.array(z.number()).optional(),
      constraints: z.object({
        maxGridExport: z.number().optional(),
        maxGridImport: z.number().optional(),
        minSocReserve: z.number().optional(),
        priorityServices: z.array(z.string()).optional(),
      }).optional(),
      serviceEnrollments: z.array(z.number()).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      return optimizationEngine.optimize({
        scope: { userId: ctx.user.id, assetIds: input.assetIds },
        objective: input.objective,
        horizonHours: input.horizonHours,
        intervalMinutes: input.intervalMinutes,
        constraints: input.constraints,
        serviceEnrollments: input.serviceEnrollments,
      });
    }),

  executeSchedule: protectedProcedure
    .input(z.object({ scheduleId: z.string() }))
    .mutation(async ({ input }) => {
      return optimizationEngine.executeSchedule(input.scheduleId);
    }),
});
