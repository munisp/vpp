import { z } from 'zod';
import { protectedProcedure, router, adminProcedure } from '../_core/trpc';
import { drAutomationService, GridStressConditions } from '../services/dr-automation';

export const drAutomationRouter = router({
  /**
   * Get all automation rules
   */
  getRules: adminProcedure
    .query(async () => {
      return drAutomationService.getAutomationRules();
    }),

  /**
   * Update automation rule
   */
  updateRule: adminProcedure
    .input(z.object({
      ruleId: z.string(),
      enabled: z.boolean().optional(),
      conditions: z.object({
        minLoadLevel: z.number().optional(),
        maxFrequency: z.number().optional(),
        minFrequency: z.number().optional(),
        minTemperature: z.number().optional(),
        timeOfDay: z.object({
          start: z.string(),
          end: z.string(),
        }).optional(),
      }).optional(),
      eventConfig: z.object({
        targetReduction: z.number().optional(),
        duration: z.number().optional(),
        baselineCompensation: z.number().optional(),
        performanceBonus: z.number().optional(),
      }).optional(),
      participantCriteria: z.object({
        minReliabilityScore: z.number().optional(),
        minCapacity: z.number().optional(),
        segments: z.array(z.string()).optional(),
      }).optional(),
    }))
    .mutation(async ({ input }) => {
      const { ruleId, ...updates } = input;
      const success = drAutomationService.updateAutomationRule(ruleId, updates as any);
      if (!success) {
        throw new Error('Rule not found');
      }
      return { success: true };
    }),

  /**
   * Trigger grid stress check manually
   */
  checkGridConditions: adminProcedure
    .input(z.object({
      loadLevel: z.number().min(0).max(100),
      frequency: z.number(),
      voltage: z.number(),
      temperature: z.number(),
    }))
    .mutation(async ({ input }) => {
      const conditions: GridStressConditions = {
        ...input,
        timestamp: new Date(),
      };

      const triggeredEventIds = await drAutomationService.checkAndTriggerEvents(conditions);

      return {
        triggeredEvents: triggeredEventIds.length,
        eventIds: triggeredEventIds,
        conditions,
      };
    }),

  /**
   * Simulate grid stress for testing
   */
  simulateGridStress: adminProcedure
    .input(z.object({
      severity: z.enum(['low', 'medium', 'high']),
    }))
    .mutation(async ({ input }) => {
      const conditions = await drAutomationService.simulateGridStress(input.severity);
      return {
        success: true,
        conditions,
      };
    }),

  /**
   * Calculate compensation for participant
   */
  calculateCompensation: protectedProcedure
    .input(z.object({
      eventId: z.number(),
      userId: z.number(),
      actualReduction: z.number(),
    }))
    .query(async ({ input, ctx }) => {
      // Verify user is admin or the participant
      if (ctx.user.role !== 'admin' && ctx.user.id !== input.userId) {
        throw new Error('Unauthorized');
      }

      return await drAutomationService.calculateCompensation(
        input.eventId,
        input.userId,
        input.actualReduction
      );
    }),
});
