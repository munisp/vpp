import { z } from 'zod';
import { adminProcedure, router } from '../_core/trpc';
import { temporalQueryService } from '../integration/temporal-query';

// Workflow types the server actually starts (server/integration/temporal-client.ts,
// server/services/prepaid-issuance-entry.ts, and the trading-execution worker).
// Temporal's `WorkflowType = '...'` visibility filter matches the registered type
// name exactly, so these must be the runtime names, not class-style aliases.
const WORKFLOW_TYPES = [
  'processPayment',
  'orchestrateDREvent',
  'executeTrade',
  'automatedTradingWorkflow',
  'prepaidIssuanceWorkflow',
] as const;

export const workflowsRouter = router({
  /**
   * List workflows with filters
   */
  list: adminProcedure
    .input(
      z.object({
        workflowType: z.enum(WORKFLOW_TYPES).optional(),
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
  getDetails: adminProcedure
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
  getStats: adminProcedure
    .input(z.object({
      workflowType: z.enum(WORKFLOW_TYPES).optional(),
    }).optional())
    .query(async ({ input }) => {
      const stats = await temporalQueryService.getWorkflowStats(input?.workflowType);
      return stats;
    }),

  /**
   * Cancel workflow
   */
  cancel: adminProcedure
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
  terminate: adminProcedure
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
  getHistory: adminProcedure
    .input(z.object({
      workflowId: z.string(),
    }))
    .query(async ({ input }) => {
      const history = await temporalQueryService.getWorkflowHistory(input.workflowId);
      return history;
    }),
});
