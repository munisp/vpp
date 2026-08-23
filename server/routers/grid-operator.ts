import { z } from 'zod';
import { publicProcedure, adminProcedure, router } from '../_core/trpc';
import { gridOperatorService } from '../integration/grid-operator';
import { TRPCError } from '@trpc/server';

// Middleware to authenticate grid operator requests
const gridOperatorProcedure = publicProcedure.use(({ ctx, next }) => {
  const apiKey = ctx.req.headers['x-grid-operator-key'] as string;
  
  if (!gridOperatorService.authenticateRequest(apiKey)) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Invalid grid operator API key',
    });
  }

  return next({ ctx });
});

export const gridOperatorRouter = router({
  /**
   * Get current grid status
   */
  getStatus: gridOperatorProcedure
    .input(z.object({
      region: z.string().optional(),
    }).optional())
    .query(async ({ input }) => {
      const status = await gridOperatorService.getGridStatus(input?.region);
      return status;
    }),

  /**
   * Get current pricing signal
   */
  getPricing: gridOperatorProcedure
    .input(z.object({
      region: z.string().optional(),
    }).optional())
    .query(async ({ input }) => {
      const pricing = await gridOperatorService.getPricingSignal(input?.region);
      return pricing;
    }),

  /**
   * Get grid load forecast
   */
  getForecast: gridOperatorProcedure
    .input(z.object({
      hoursAhead: z.number().min(1).max(168).default(24),
      region: z.string().optional(),
    }).optional())
    .query(async ({ input }) => {
      const forecast = await gridOperatorService.getGridForecast(
        input?.hoursAhead || 24,
        input?.region
      );
      return forecast;
    }),

  /**
   * Trigger DR event
   */
  triggerDREvent: gridOperatorProcedure
    .input(z.object({
      reason: z.string(),
      severity: z.enum(['low', 'medium', 'high', 'critical']),
      targetReduction: z.number().positive(),
      duration: z.number().positive(),
      compensationRate: z.number().positive(),
      region: z.string().optional(),
      autoEnroll: z.boolean().optional(),
    }))
    .mutation(async ({ input }) => {
      const result = await gridOperatorService.triggerDREvent(input);
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error || 'Failed to trigger DR event',
        });
      }

      return result;
    }),

  /**
   * Get VPP aggregate capacity
   */
  getVPPCapacity: gridOperatorProcedure
    .input(z.object({
      region: z.string().optional(),
    }).optional())
    .query(async ({ input }) => {
      const capacity = await gridOperatorService.getVPPCapacity(input?.region);
      return capacity;
    }),

  /**
   * Get VPP performance metrics
   */
  getVPPPerformance: gridOperatorProcedure
    .input(z.object({
      timeWindow: z.number().min(1).max(720).default(24), // hours
    }).optional())
    .query(async ({ input }) => {
      const performance = await gridOperatorService.getVPPPerformance(input?.timeWindow || 24);
      return performance;
    }),

  /**
   * Validate API key (for testing)
   */
  validateKey: gridOperatorProcedure
    .query(() => {
      return {
        valid: true,
        message: 'API key is valid',
      };
    }),

  // Admin endpoints
  
  /**
   * Get grid status (admin view)
   */
  adminGetStatus: adminProcedure
    .input(z.object({
      region: z.string().optional(),
    }).optional())
    .query(async ({ input }) => {
      const status = await gridOperatorService.getGridStatus(input?.region);
      return status;
    }),

  /**
   * Get pricing signal (admin view)
   */
  adminGetPricing: adminProcedure
    .input(z.object({
      region: z.string().optional(),
    }).optional())
    .query(async ({ input }) => {
      const pricing = await gridOperatorService.getPricingSignal(input?.region);
      return pricing;
    }),

  /**
   * Get forecast (admin view)
   */
  adminGetForecast: adminProcedure
    .input(z.object({
      hoursAhead: z.number().min(1).max(168).default(24),
      region: z.string().optional(),
    }).optional())
    .query(async ({ input }) => {
      const forecast = await gridOperatorService.getGridForecast(
        input?.hoursAhead || 24,
        input?.region
      );
      return forecast;
    }),
});
