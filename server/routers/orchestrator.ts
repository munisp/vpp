import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { getTemporalClient, TASK_QUEUES } from "../integration/temporal-config";
import { temporalClient } from "../integration/temporal-client";
import { temporalQueryService } from "../integration/temporal-query";
import * as db from "../db";
import * as drDb from "../dr-db";

/**
 * Orchestrator Router - tRPC bridge to Temporal workflows
 *
 * Every mutation dispatches a REAL, registered workflow type to the Temporal
 * server. Registered workflow types live in server/workflows/*.ts:
 *   - payment-processing queue:  processPayment, refundWorkflow
 *   - trading-execution queue:   automatedTradingWorkflow, p2pTradingWorkflow,
 *                                executeTrade, marketMakingWorkflow
 *   - dr-orchestration queue:    orchestrateDREvent, cancelDREventWorkflow
 *
 * If dispatch fails, the procedure fails loudly with INTERNAL_SERVER_ERROR;
 * no execution is ever faked locally. Procedures whose workflow type is not
 * registered anywhere fail loudly with NOT_IMPLEMENTED.
 */

/**
 * Honest failure for procedures whose Temporal workflow type is not
 * registered on any worker. Never fake a dispatch.
 */
function workflowNotAvailable(name: string): never {
  throw new TRPCError({
    code: "NOT_IMPLEMENTED",
    message: `${name} workflow is not yet available`,
  });
}

/**
 * Parse a client-supplied string id into a positive integer or fail loudly.
 */
function parsePositiveIntId(raw: string, field: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${field} must be a positive integer, got '${raw}'`,
    });
  }
  return value;
}

type TaskQueue = (typeof TASK_QUEUES)[keyof typeof TASK_QUEUES];

/**
 * Start a Temporal workflow and fail loudly when dispatch is impossible.
 */
async function dispatchWorkflow(
  workflowType: string,
  taskQueue: TaskQueue,
  workflowId: string,
  args: Record<string, unknown>[]
): Promise<{ workflowId: string; runId: string }> {
  try {
    const client = await getTemporalClient();
    const handle = await client.workflow.start(workflowType, {
      taskQueue,
      workflowId,
      args,
    });
    return { workflowId: handle.workflowId, runId: handle.firstExecutionRunId };
  } catch (error) {
    console.error(`[Orchestrator] Failed to dispatch ${workflowType} (${workflowId}):`, error);
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Failed to start workflow '${workflowType}': workflow dispatch unavailable.`,
    });
  }
}

export const orchestratorRouter = router({
  // ============================================================================
  // TRADING WORKFLOWS
  // ============================================================================

  startAutoTrading: protectedProcedure
    .input(z.object({
      assetId: z.string(),
      strategy: z.enum(['sell_excess', 'buy_deficit', 'arbitrage']).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const assetId = parsePositiveIntId(input.assetId, 'assetId');
      const workflowId = `auto-trading-${ctx.user.id}-${assetId}-${Date.now()}`;

      // Args match AutomatedTradingWorkflowInput in server/workflows/trading-workflow.ts
      const handle = await dispatchWorkflow(
        'automatedTradingWorkflow',
        TASK_QUEUES.TRADING_EXECUTION,
        workflowId,
        [{
          userId: ctx.user.id,
          assetId,
          strategy: input.strategy ?? 'sell_excess',
        }]
      );

      return {
        workflowId: handle.workflowId,
        status: "started",
        message: "Auto-trading workflow started successfully",
      };
    }),

  startManualTrade: protectedProcedure
    .input(z.object({
      amount: z.number().positive(), // kWh to buy
      maxPrice: z.number().positive(), // maximum cents per kWh
      counterpartyId: z.number().int().positive().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Create a real pending trade record first so the workflow executes a
      // persisted trade (same pattern as server/routers/trading.ts create).
      // energy is stored in watt-hours; price in cents per kWh.
      const energyWh = Math.round(input.amount * 1000);
      const pricePerKwh = Math.round(input.maxPrice);
      const totalAmount = Math.floor((energyWh * pricePerKwh) / 1000);

      const trade = await db.createTrade({
        userId: ctx.user.id,
        tradeType: 'import',
        tradingMode: 'manual',
        energy: energyWh,
        price: pricePerKwh,
        totalAmount,
        timestamp: new Date(),
        status: 'pending',
        counterpartyId: input.counterpartyId,
      });

      const workflowId = `manual-trade-${ctx.user.id}-${trade.id}-${Date.now()}`;

      // Args match the executeTrade input in server/workflows/trading-workflow.ts.
      // Note: executeTrade settles peer-to-peer and honestly reports failure
      // when no counterparty is available — it never fakes a fill.
      const handle = await dispatchWorkflow(
        'executeTrade',
        TASK_QUEUES.TRADING_EXECUTION,
        workflowId,
        [{
          tradeId: trade.id,
          userId: ctx.user.id,
          tradeType: 'import',
          energy: energyWh,
          price: pricePerKwh,
          ...(input.counterpartyId ? { counterpartyId: input.counterpartyId } : {}),
        }]
      );

      return {
        workflowId: handle.workflowId,
        tradeId: trade.id,
        status: "started",
        message: "Manual trading workflow started",
      };
    }),

  startP2PTrade: protectedProcedure
    .input(z.object({
      buyerId: z.string(),
      amount: z.number().positive(), // kWh
      price: z.number().positive(), // cents per kWh
      deliveryTime: z.coerce.date().optional(),
      duration: z.number().positive().optional(), // delivery window, hours
    }))
    .mutation(async ({ ctx, input }) => {
      const buyerId = parsePositiveIntId(input.buyerId, 'buyerId');
      const workflowId = `p2p-trade-${ctx.user.id}-${buyerId}-${Date.now()}`;

      // Args match P2PTradingWorkflowInput in server/workflows/trading-workflow.ts
      const handle = await dispatchWorkflow(
        'p2pTradingWorkflow',
        TASK_QUEUES.TRADING_EXECUTION,
        workflowId,
        [{
          sellerId: ctx.user.id,
          buyerId,
          quantity: input.amount,
          pricePerKwh: Math.round(input.price),
          deliveryTime: input.deliveryTime ?? new Date(),
          duration: input.duration ?? 1,
        }]
      );

      return {
        workflowId: handle.workflowId,
        status: "started",
        message: "P2P trading workflow started",
      };
    }),

  // ============================================================================
  // DEMAND RESPONSE WORKFLOWS
  // ============================================================================

  enrollInDREvent: protectedProcedure
    .input(z.object({
      eventId: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      const eventId = parsePositiveIntId(input.eventId, 'eventId');

      // Load the real event so the workflow is dispatched with the event's
      // actual parameters — never fabricated ones.
      const event = await drDb.getDREventById(eventId);
      if (!event) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Demand response event ${eventId} not found`,
        });
      }

      const workflowId = `dr-event-${eventId}-orchestration-${Date.now()}`;

      // Args match DREventWorkflowInput in server/workflows/dr-event-workflow.ts.
      // The workflow runs the full DR lifecycle (create orchestration record,
      // enroll eligible participants, notify, monitor, compensate).
      const handle = await dispatchWorkflow(
        'orchestrateDREvent',
        TASK_QUEUES.DR_ORCHESTRATION,
        workflowId,
        [{
          type: event.eventType === 'peak_shaving'
            ? 'peak_reduction'
            : event.eventType === 'emergency'
              ? 'emergency'
              : 'scheduled',
          startTime: event.startTime,
          endTime: event.endTime,
          targetReduction: event.targetReduction,
          compensationRate: event.compensationRate,
          autoEnroll: true,
        }]
      );

      return {
        workflowId: handle.workflowId,
        status: "started",
        message: "DR event orchestration workflow started",
      };
    }),

  startDRForecasting: protectedProcedure
    .input(z.object({
      regionId: z.string(),
    }))
    .mutation(async () => {
      // No 'forecastDRLoad' workflow type is registered on any worker
      // (see server/workflows/*). Fail loudly instead of fake-dispatching.
      workflowNotAvailable('startDRForecasting');
    }),

  // ============================================================================
  // PAYMENT WORKFLOWS
  // ============================================================================

  processPayment: protectedProcedure
    .input(z.object({
      amount: z.number().positive(),
      method: z.enum(["mpesa", "airtel", "tigo"]),
      phoneNumber: z.string().optional(),
      billingId: z.number().int().positive().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const paymentRef = `${ctx.user.id}-${Date.now()}`;

      try {
        // Dispatches the registered 'processPayment' workflow type on the
        // payment-processing queue (server/workflows/payment-workflow.ts).
        const handle = await temporalClient.startPaymentWorkflow({
          paymentId: paymentRef,
          userId: String(ctx.user.id),
          amount: input.amount,
          currency: ctx.user.currency,
          gateway: input.method,
          phoneNumber: input.phoneNumber,
          billingId: input.billingId,
        });

        return {
          workflowId: handle.workflowId,
          status: "started",
          message: "Payment processing workflow started",
        };
      } catch (error) {
        console.error(`[Orchestrator] Failed to dispatch payment workflow:`, error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to start payment workflow: workflow dispatch unavailable.",
        });
      }
    }),

  processQRPayment: protectedProcedure
    .input(z.object({
      qrData: z.string(),
    }))
    .mutation(async () => {
      // No 'processQRPayment' workflow type is registered on any worker
      // (see server/workflows/*). Fail loudly instead of fake-dispatching.
      workflowNotAvailable('processQRPayment');
    }),

  // ============================================================================
  // MONITORING WORKFLOWS
  // ============================================================================

  startTelemetryMonitoring: protectedProcedure
    .input(z.object({
      deviceId: z.string(),
    }))
    .mutation(async () => {
      // No 'monitorTelemetry' workflow type is registered on any worker
      // (see server/workflows/*). Fail loudly instead of fake-dispatching.
      workflowNotAvailable('startTelemetryMonitoring');
    }),

  processAlert: protectedProcedure
    .input(z.object({
      alertId: z.string(),
    }))
    .mutation(async () => {
      // No 'processAlert' workflow type is registered on any worker
      // (see server/workflows/*). Fail loudly instead of fake-dispatching.
      workflowNotAvailable('processAlert');
    }),

  // ============================================================================
  // GAMIFICATION WORKFLOWS
  // ============================================================================

  updateLeaderboard: protectedProcedure
    .input(z.object({
      period: z.enum(["daily", "weekly", "monthly"]),
    }))
    .mutation(async () => {
      // No 'updateLeaderboard' workflow type is registered on any worker
      // (see server/workflows/*). Fail loudly instead of fake-dispatching.
      workflowNotAvailable('updateLeaderboard');
    }),

  trackAchievement: protectedProcedure
    .input(z.object({
      action: z.string(),
    }))
    .mutation(async () => {
      // No 'trackAchievement' workflow type is registered on any worker
      // (see server/workflows/*). Fail loudly instead of fake-dispatching.
      workflowNotAvailable('trackAchievement');
    }),

  // ============================================================================
  // WORKFLOW STATUS & MANAGEMENT
  // ============================================================================

  getWorkflowStatus: protectedProcedure
    .input(z.object({
      workflowId: z.string(),
    }))
    .query(async ({ input }) => {
      let execution;
      try {
        execution = await temporalQueryService.getWorkflowDetails(input.workflowId);
      } catch (error) {
        console.error(`[Orchestrator] Failed to query workflow ${input.workflowId}:`, error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to query workflow status.",
        });
      }

      if (!execution) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Workflow not found",
        });
      }

      return execution;
    }),

  listUserWorkflows: protectedProcedure
    .query(async ({ ctx }) => {
      const userMarker = `-${ctx.user.id}-`;
      const workflows = await temporalQueryService.listWorkflows({ limit: 200 });

      return workflows
        .filter((w) => w.workflowId.includes(userMarker))
        .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
        .slice(0, 20); // Last 20 workflows
    }),

  cancelWorkflow: protectedProcedure
    .input(z.object({
      workflowId: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Verify ownership: user workflow IDs embed the user id.
      const userMarker = `-${ctx.user.id}-`;
      if (!input.workflowId.includes(userMarker) && ctx.user.role !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You can only cancel your own workflows",
        });
      }

      try {
        await temporalQueryService.cancelWorkflow(
          input.workflowId,
          `Cancelled by user ${ctx.user.id}`
        );
      } catch (error) {
        console.error(`[Orchestrator] Failed to cancel workflow ${input.workflowId}:`, error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to cancel workflow.",
        });
      }

      return {
        success: true,
        message: "Workflow cancelled successfully",
      };
    }),
});
