import { z } from 'zod';
import { protectedProcedure, router } from '../../_core/trpc';
import { mlopsPipeline } from '../../services/mlops-pipeline';

export const mlopsRouter = router({
    listModels: protectedProcedure
      .input(z.object({
        status: z.enum(['training', 'validating', 'staged', 'deployed', 'deprecated', 'failed']).optional(),
      }).optional())
      .query(async ({ input }) => {
        return mlopsPipeline.listModels(input?.status);
      }),

  getModel: protectedProcedure
    .input(z.object({ modelId: z.number() }))
    .query(async ({ input }) => {
      return mlopsPipeline.getModel(input.modelId);
    }),

  getDeployedModel: protectedProcedure
    .input(z.object({ modelName: z.string() }))
    .query(async ({ input }) => {
      return mlopsPipeline.getDeployedModel(input.modelName);
    }),

  deployModel: protectedProcedure
    .input(z.object({ modelId: z.number() }))
    .mutation(async ({ input }) => {
      return mlopsPipeline.deployModel(input.modelId);
    }),

  detectDrift: protectedProcedure
    .input(z.object({ modelId: z.number(), windowHours: z.number().default(24) }))
    .mutation(async ({ input }) => {
      return mlopsPipeline.detectDrift(input.modelId, input.windowHours);
    }),

    getModelPerformance: protectedProcedure
      .input(z.object({
        modelId: z.number(),
        periodHours: z.number().default(24),
      }))
      .query(async ({ input }) => {
        return mlopsPipeline.getModelPerformance(input.modelId, input.periodHours);
      }),

  getRecentDriftEvents: protectedProcedure
    .input(z.object({ modelId: z.number().optional(), limit: z.number().default(20) }).optional())
    .query(async ({ input }) => {
      return mlopsPipeline.getRecentDriftEvents(input?.modelId, input?.limit || 20);
    }),

  triggerRetraining: protectedProcedure
    .input(z.object({
      modelId: z.number(),
      triggerType: z.enum(['scheduled', 'drift_detected', 'manual', 'performance_threshold']).default('manual'),
      trainingConfig: z.record(z.string(), z.any()).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      return mlopsPipeline.triggerRetraining(input.modelId, {
        triggerType: input.triggerType,
        triggeredBy: ctx.user.name || 'user',
        trainingConfig: input.trainingConfig,
      });
    }),
});
