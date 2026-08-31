import { z } from 'zod';
import { router, protectedProcedure } from '../../_core/trpc';
import { TRPCError } from '@trpc/server';
import {
  addWorkOrderNote,
  assignWorkOrder,
  createWorkOrder,
  getWorkOrder,
  listWorkOrders,
  updateWorkOrderStatus,
} from '../../services/innov3-work-orders';

const StatusSchema = z.enum(['open', 'assigned', 'in_progress', 'done', 'verified', 'cancelled']);

function toError(error: unknown): TRPCError {
  const message = error instanceof Error ? error.message : '';
  if (message === 'WORK_ORDER_NOT_FOUND' || message === 'ASSET_NOT_FOUND') {
    return new TRPCError({ code: 'NOT_FOUND', message: 'Work order or asset not found.' });
  }
  if (message === 'ANOMALY_SCORE_NOT_FOUND' || message === 'NTL_FLAG_NOT_FOUND') {
    return new TRPCError({ code: 'NOT_FOUND', message: 'Referenced detection record not found.' });
  }
  if (message === 'ASSIGNEE_NOT_FOUND') return new TRPCError({ code: 'NOT_FOUND', message: 'Assignee user not found.' });
  if (message === 'STAFF_REQUIRED') return new TRPCError({ code: 'FORBIDDEN', message: 'This action requires an admin or operator.' });
  if (message === 'FORBIDDEN') return new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this work order.' });
  if (message.startsWith('INVALID_TRANSITION')) {
    return new TRPCError({ code: 'BAD_REQUEST', message: `Invalid status transition (${message.split(':')[1]}).` });
  }
  if (message.includes('ASSET_MISMATCH')) {
    return new TRPCError({ code: 'BAD_REQUEST', message: 'Referenced detection record belongs to a different asset.' });
  }
  console.error('[WorkOrders]', error);
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Work order operation failed.' });
}

/**
 * Maintenance work orders router.
 *
 * Status flow is enforced in the service (open → assigned → in_progress →
 * done → verified). Assignment and verification are admin/operator-only
 * (the platform's users table has no global operator role, so staff =
 * admin). The event log is append-only and actor-stamped.
 */
export const workOrdersRouter = router({
  create: protectedProcedure
    .input(z.object({
      assetId: z.number().int().positive(),
      title: z.string().min(1).max(255),
      description: z.string().max(5000).optional(),
      priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
      gridAnomalyScoreId: z.number().int().positive().optional(),
      ntlFlagId: z.number().int().positive().optional(),
      dueAt: z.coerce.date().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        const order = await createWorkOrder(ctx.user.id, ctx.user.role === 'admin', input);
        return { success: true, order };
      } catch (error) {
        throw toError(error);
      }
    }),

  assign: protectedProcedure
    .input(z.object({
      workOrderId: z.number().int().positive(),
      assigneeUserId: z.number().int().positive(),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        const order = await assignWorkOrder(input.workOrderId, input.assigneeUserId, ctx.user.id, ctx.user.role === 'admin');
        return { success: true, order };
      } catch (error) {
        throw toError(error);
      }
    }),

  updateStatus: protectedProcedure
    .input(z.object({
      workOrderId: z.number().int().positive(),
      toStatus: StatusSchema,
      note: z.string().max(2000).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        const order = await updateWorkOrderStatus(input.workOrderId, ctx.user.id, ctx.user.role === 'admin', input.toStatus, input.note);
        return { success: true, order };
      } catch (error) {
        throw toError(error);
      }
    }),

  addNote: protectedProcedure
    .input(z.object({
      workOrderId: z.number().int().positive(),
      note: z.string().min(1).max(2000),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        await addWorkOrderNote(input.workOrderId, ctx.user.id, ctx.user.role === 'admin', input.note);
        return { success: true };
      } catch (error) {
        throw toError(error);
      }
    }),

  get: protectedProcedure
    .input(z.object({ workOrderId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      try {
        return await getWorkOrder(input.workOrderId, ctx.user.id, ctx.user.role === 'admin');
      } catch (error) {
        throw toError(error);
      }
    }),

  list: protectedProcedure
    .input(z.object({
      assetId: z.number().int().positive().optional(),
      status: StatusSchema.optional(),
      limit: z.number().int().positive().max(200).default(50),
    }))
    .query(async ({ ctx, input }) => {
      try {
        const orders = await listWorkOrders(ctx.user.id, ctx.user.role === 'admin', input);
        return { orders, count: orders.length };
      } catch (error) {
        throw toError(error);
      }
    }),
});

export type WorkOrdersRouter = typeof workOrdersRouter;
