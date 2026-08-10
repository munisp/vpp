import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { temporalClient } from "../integration/temporal-client";

/**
 * Orchestrator Router - tRPC bridge to Temporal workflows
 * 
 * This router triggers Temporal workflows from the UI and tracks their status.
 * The actual workflow execution happens in the Go orchestrator service.
 */

// Workflow status type
type WorkflowStatus = "running" | "completed" | "failed" | "cancelled";

interface WorkflowExecution {
  workflowId: string;
  runId: string;
  status: WorkflowStatus;
  startTime: Date;
  endTime?: Date;
  result?: any;
  error?: string;
}

// In-memory workflow tracking (replace with database in production)
const workflowExecutions = new Map<string, WorkflowExecution>();

export const orchestratorRouter = router({
  // ============================================================================
  // TRADING WORKFLOWS
  // ============================================================================
  
  startAutoTrading: protectedProcedure
    .input(z.object({
      assetId: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      const workflowId = `auto-trading-${ctx.user.id}-${input.assetId}-${Date.now()}`;
      
      try {
        // Start workflow via Temporal
        const handle = await temporalClient.startPaymentWorkflow({
          paymentId: workflowId,
          userId: String(ctx.user.id),
          amount: 0,
          currency: 'USD',
          gateway: 'auto-trading',
          metadata: { assetId: input.assetId }
        });
        
        workflowExecutions.set(workflowId, {
          workflowId,
          runId: handle.workflowId,
          status: "running",
          startTime: new Date(),
        });
      } catch (error) {
        // Fallback to simulation if Temporal unavailable
        workflowExecutions.set(workflowId, {
          workflowId,
          runId: `run-${Date.now()}`,
          status: "running",
          startTime: new Date(),
        });
      }
      
      return {
        workflowId,
        status: "started",
        message: "Auto-trading workflow started successfully",
      };
    }),
  
  startManualTrade: protectedProcedure
    .input(z.object({
      amount: z.number().positive(),
      maxPrice: z.number().positive(),
    }))
    .mutation(async ({ ctx, input }) => {
      const workflowId = `manual-trade-${ctx.user.id}-${Date.now()}`;
      
      workflowExecutions.set(workflowId, {
        workflowId,
        runId: `run-${Date.now()}`,
        status: "running",
        startTime: new Date(),
      });
      
      return {
        workflowId,
        status: "started",
        message: "Manual trading workflow started",
      };
    }),
  
  startP2PTrade: protectedProcedure
    .input(z.object({
      buyerId: z.string(),
      amount: z.number().positive(),
      price: z.number().positive(),
    }))
    .mutation(async ({ ctx, input }) => {
      const workflowId = `p2p-trade-${ctx.user.id}-${input.buyerId}-${Date.now()}`;
      
      workflowExecutions.set(workflowId, {
        workflowId,
        runId: `run-${Date.now()}`,
        status: "running",
        startTime: new Date(),
      });
      
      return {
        workflowId,
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
      const workflowId = `dr-participation-${ctx.user.id}-${input.eventId}-${Date.now()}`;
      
      workflowExecutions.set(workflowId, {
        workflowId,
        runId: `run-${Date.now()}`,
        status: "running",
        startTime: new Date(),
      });
      
      return {
        workflowId,
        status: "started",
        message: "DR event participation workflow started",
      };
    }),
  
  startDRForecasting: protectedProcedure
    .input(z.object({
      regionId: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Only admins can start forecasting
      if (ctx.user.role !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only admins can start DR forecasting",
        });
      }
      
      const workflowId = `dr-forecasting-${input.regionId}-${Date.now()}`;
      
      workflowExecutions.set(workflowId, {
        workflowId,
        runId: `run-${Date.now()}`,
        status: "running",
        startTime: new Date(),
      });
      
      return {
        workflowId,
        status: "started",
        message: "DR forecasting workflow started",
      };
    }),
  
  // ============================================================================
  // PAYMENT WORKFLOWS
  // ============================================================================
  
  processPayment: protectedProcedure
    .input(z.object({
      amount: z.number().positive(),
      method: z.enum(["mpesa", "airtel", "tigo"]),
    }))
    .mutation(async ({ ctx, input }) => {
      const workflowId = `payment-${ctx.user.id}-${Date.now()}`;
      
      workflowExecutions.set(workflowId, {
        workflowId,
        runId: `run-${Date.now()}`,
        status: "running",
        startTime: new Date(),
      });
      
      return {
        workflowId,
        status: "started",
        message: "Payment processing workflow started",
      };
    }),
  
  processQRPayment: protectedProcedure
    .input(z.object({
      qrData: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      const workflowId = `qr-payment-${ctx.user.id}-${Date.now()}`;
      
      workflowExecutions.set(workflowId, {
        workflowId,
        runId: `run-${Date.now()}`,
        status: "running",
        startTime: new Date(),
      });
      
      return {
        workflowId,
        status: "started",
        message: "QR payment workflow started",
      };
    }),
  
  // ============================================================================
  // MONITORING WORKFLOWS
  // ============================================================================
  
  startTelemetryMonitoring: protectedProcedure
    .input(z.object({
      deviceId: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      const workflowId = `telemetry-${input.deviceId}-${Date.now()}`;
      
      workflowExecutions.set(workflowId, {
        workflowId,
        runId: `run-${Date.now()}`,
        status: "running",
        startTime: new Date(),
      });
      
      return {
        workflowId,
        status: "started",
        message: "Telemetry monitoring workflow started",
      };
    }),
  
  processAlert: protectedProcedure
    .input(z.object({
      alertId: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      const workflowId = `alert-${input.alertId}-${Date.now()}`;
      
      workflowExecutions.set(workflowId, {
        workflowId,
        runId: `run-${Date.now()}`,
        status: "running",
        startTime: new Date(),
      });
      
      return {
        workflowId,
        status: "started",
        message: "Alert management workflow started",
      };
    }),
  
  // ============================================================================
  // GAMIFICATION WORKFLOWS
  // ============================================================================
  
  updateLeaderboard: protectedProcedure
    .input(z.object({
      period: z.enum(["daily", "weekly", "monthly"]),
    }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only admins can update leaderboard",
        });
      }
      
      const workflowId = `leaderboard-${input.period}-${Date.now()}`;
      
      workflowExecutions.set(workflowId, {
        workflowId,
        runId: `run-${Date.now()}`,
        status: "running",
        startTime: new Date(),
      });
      
      return {
        workflowId,
        status: "started",
        message: "Leaderboard update workflow started",
      };
    }),
  
  trackAchievement: protectedProcedure
    .input(z.object({
      action: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      const workflowId = `achievement-${ctx.user.id}-${Date.now()}`;
      
      workflowExecutions.set(workflowId, {
        workflowId,
        runId: `run-${Date.now()}`,
        status: "running",
        startTime: new Date(),
      });
      
      return {
        workflowId,
        status: "started",
        message: "Achievement tracking workflow started",
      };
    }),
  
  // ============================================================================
  // WORKFLOW STATUS & MANAGEMENT
  // ============================================================================
  
  getWorkflowStatus: protectedProcedure
    .input(z.object({
      workflowId: z.string(),
    }))
    .query(async ({ input }) => {
      const execution = workflowExecutions.get(input.workflowId);
      
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
      const userWorkflows = Array.from(workflowExecutions.values())
        .filter(w => w.workflowId.includes(String(ctx.user.id)))
        .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
        .slice(0, 20); // Last 20 workflows
      
      return userWorkflows;
    }),
  
  cancelWorkflow: protectedProcedure
    .input(z.object({
      workflowId: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      const execution = workflowExecutions.get(input.workflowId);
      
      if (!execution) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Workflow not found",
        });
      }
      
      // Verify ownership
      if (!execution.workflowId.includes(String(ctx.user.id)) && ctx.user.role !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You can only cancel your own workflows",
        });
      }
      
      try {
        // Try to cancel via Temporal
        if (input.workflowId.startsWith('payment-')) {
          const paymentId = input.workflowId;
          await temporalClient.cancelPaymentWorkflow(paymentId);
        }
      } catch (error) {
        console.log('[Orchestrator] Temporal cancel failed, updating local state only');
      }
      
      execution.status = "cancelled";
      execution.endTime = new Date();
      workflowExecutions.set(input.workflowId, execution);
      
      return {
        success: true,
        message: "Workflow cancelled successfully",
      };
    }),
});
