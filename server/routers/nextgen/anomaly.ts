import { z } from 'zod';
import { protectedProcedure, router } from '../../_core/trpc';
import { anomalyDetection } from '../../services/anomaly-detection';

export const anomalyRouter = router({
  detectAnomalies: protectedProcedure
    .input(z.object({ assetId: z.number() }))
    .mutation(async ({ input }) => {
      return anomalyDetection.detectAnomalies(input.assetId);
    }),

  getAnomaly: protectedProcedure
    .input(z.object({ anomalyId: z.number() }))
    .query(async ({ input }) => {
      return anomalyDetection.getAnomaly(input.anomalyId);
    }),

  calculateHealthScore: protectedProcedure
    .input(z.object({ assetId: z.number() }))
    .query(async ({ input }) => {
      return anomalyDetection.calculateHealthScore(input.assetId);
    }),

  getMaintenanceRecommendations: protectedProcedure
    .query(async ({ ctx }) => {
      return anomalyDetection.getMaintenanceRecommendations(ctx.user.id);
    }),

  acknowledgeAnomaly: protectedProcedure
    .input(z.object({ anomalyId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      return anomalyDetection.acknowledgeAnomaly(input.anomalyId, ctx.user.id);
    }),

  resolveAnomaly: protectedProcedure
    .input(z.object({ anomalyId: z.number(), resolutionNotes: z.string() }))
    .mutation(async ({ input }) => {
      return anomalyDetection.resolveAnomaly(input.anomalyId, input.resolutionNotes);
    }),

  getUserAnomalies: protectedProcedure
    .input(z.object({ severity: z.string().optional() }).optional())
    .query(async ({ input, ctx }) => {
      return anomalyDetection.getUserAnomalies(ctx.user.id, input?.severity);
    }),

  runDetectionForUser: protectedProcedure
    .mutation(async ({ ctx }) => {
      return anomalyDetection.runDetectionForUser(ctx.user.id);
    }),
});
