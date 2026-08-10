import { z } from 'zod';
import { protectedProcedure, router } from '../_core/trpc';
import { temporalQueryService } from '../integration/temporal-query';

export const workflowsRouter = router({
  /**
   * List workflows with filters
   */
  list: protectedProcedure
    .input(
      z.object({
        workflowType: z.enum(['DREventWorkflow', 'AutomatedTradingWorkflow', 'P2PTradingWorkflow', 'PaymentProcessingWorkflow']).optional(),
        status: z.enum(['running', 'completed', 'failed', 'cancelled', 'terminated']).optional(),
        limit: z.number().min(1).max(100).optional(),
        offset: z.number().min(0).optional(),
      }).optional()
    )
    .query(async ({ input }) => {
      const workflows = await temporalQueryService.listWorkflows(input || {});
      return workflows;
    }),

  /**
   * Get workflow details
   */
  getDetails: protectedProcedure
    .input(z.object({
      workflowId: z.string(),
    }))
    .query(async ({ input }) => {
      const workflow = await temporalQueryService.getWorkflowDetails(input.workflowId);
      
      if (!workflow) {
        throw new Error('Workflow not found');
      }
      
      return workflow;
    }),

  /**
   * Get workflow statistics
   */
  getStats: protectedProcedure
    .input(z.object({
      workflowType: z.enum(['DREventWorkflow', 'AutomatedTradingWorkflow', 'P2PTradingWorkflow', 'PaymentProcessingWorkflow']).optional(),
    }).optional())
    .query(async ({ input }) => {
      const stats = await temporalQueryService.getWorkflowStats(input?.workflowType);
      return stats;
    }),

  /**
   * Cancel workflow
   */
  cancel: protectedProcedure
    .input(z.object({
      workflowId: z.string(),
      reason: z.string(),
    }))
    .mutation(async ({ input }) => {
      const success = await temporalQueryService.cancelWorkflow(input.workflowId, input.reason);
      
      return {
        success,
        message: success ? 'Workflow cancelled successfully' : 'Failed to cancel workflow',
      };
    }),

  /**
   * Terminate workflow
   */
  terminate: protectedProcedure
    .input(z.object({
      workflowId: z.string(),
      reason: z.string(),
    }))
    .mutation(async ({ input }) => {
      const success = await temporalQueryService.terminateWorkflow(input.workflowId, input.reason);
      
      return {
        success,
        message: success ? 'Workflow terminated successfully' : 'Failed to terminate workflow',
      };
    }),

  /**
   * Get workflow history
   */
  getHistory: protectedProcedure
    .input(z.object({
      workflowId: z.string(),
    }))
    .query(async ({ input }) => {
      const history = await temporalQueryService.getWorkflowHistory(input.workflowId);
      return history;
    }),
});
