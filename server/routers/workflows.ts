import { z } from 'zod';
import { adminProcedure, router } from '../_core/trpc';
import { temporalQueryService } from '../integration/temporal-query';
import { temporalClient } from '../integration/temporal-client';

// Workflow types the server actually starts (server/integration/temporal-client.ts,
// server/routers/orchestrator.ts, server/services/prepaid-issuance-entry.ts, the
// prepaid-consumption-sweep Temporal Schedule, and the trading-execution worker).
// Temporal's `WorkflowType = '...'` visibility filter matches the registered type
// name exactly, so these must be the runtime names, not class-style aliases.
const WORKFLOW_TYPES = [
  'processPayment',
  'refundWorkflow',
  'orchestrateDREvent',
  'cancelDREventWorkflow',
  'executeTrade',
  'automatedTradingWorkflow',
  'p2pTradingWorkflow',
  'prepaidIssuanceWorkflow',
  'prepaidConsumptionSweepWorkflow',
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
   * Start a refund workflow for a payment.
   *
   * Refunds have no self-service trigger: they are an operator action. This
   * admin mutation is the single entry point, so a refund is always the
   * durable `refundWorkflow` execution (gateway refund + billing revert) and
   * never an in-process attempt lost on restart. Starting twice for the same
   * transaction fails with WorkflowExecutionAlreadyStartedError, surfaced
   * here as a 400-style error rather than a silent duplicate refund.
   */
  startRefund: adminProcedure
    .input(z.object({
      transactionId: z.string().min(1),
      gateway: z.enum(['mpesa', 'airtel', 'tigo']),
      userId: z.number().int().positive(),
      billingId: z.number().int().positive(),
    }))
    .mutation(async ({ input }) => {
      try {
        const handle = await temporalClient.startRefundWorkflow(input);
        return {
          success: true,
          workflowId: handle.workflowId,
          message: 'Refund workflow started',
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('WorkflowExecutionAlreadyStarted')) {
          throw new Error(`A refund workflow is already running for transaction ${input.transactionId}`);
        }
        throw error;
      }
    }),

  /**
   * Cancel a scheduled DR event: starts `cancelDREventWorkflow`, which marks
   * the event cancelled and notifies enrolled participants, and cancels the
   * running orchestration execution for the event when there is one.
   */
  cancelDREvent: adminProcedure
    .input(z.object({
      eventId: z.number().int().positive(),
      reason: z.string().min(1),
    }))
    .mutation(async ({ input }) => {
      const handle = await temporalClient.startCancelDREventWorkflow(input.eventId, input.reason);

      // The orchestration workflow (dr-event-<id>) may still be waiting on
      // timers/signals; cancel it too so it does not keep running against an
      // event that is now cancelled. A missing or already-closed execution is
      // not an error: the event is cancelled either way.
      try {
        await temporalQueryService.cancelWorkflow(`dr-event-${input.eventId}`, input.reason);
      } catch (error) {
        console.warn(
          `[Workflows] No running orchestration workflow to cancel for DR event ${input.eventId}:`,
          error instanceof Error ? error.message : error
        );
      }

      return {
        success: true,
        workflowId: handle.workflowId,
        message: 'DR event cancellation workflow started',
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
