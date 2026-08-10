import { z } from 'zod';
import { router, protectedProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import * as db from '../db';

const CreateAlertInputSchema = z.object({
  alertType: z.enum(['system', 'trading', 'billing', 'maintenance']),
  severity: z.enum(['info', 'warning', 'error', 'critical']),
  title: z.string().min(1).max(255),
  message: z.string().min(1),
  metadata: z.string().optional(),
});

const MarkAsReadInputSchema = z.object({
  alertId: z.number().int().positive(),
});

const DeleteAlertInputSchema = z.object({
  alertId: z.number().int().positive(),
});

export const alertsRouter = router({
  list: protectedProcedure
    .input(z.object({ limit: z.number().int().positive().max(100).default(50) }))
    .query(async ({ ctx, input }) => {
      try {
        const alerts = await db.getUserAlerts(ctx.user.id, input.limit);
        return {
          alerts,
          count: alerts.length,
        };
      } catch (error) {
        console.error('Error listing alerts:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to retrieve alerts.',
        });
      }
    }),

  create: protectedProcedure
    .input(CreateAlertInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const alert = await db.createAlert({
          userId: ctx.user.id,
          alertType: input.alertType,
          severity: input.severity,
          title: input.title,
          message: input.message,
          isRead: false,
          metadata: input.metadata,
        });

        return {
          success: true,
          alert,
          message: 'Alert created successfully.',
        };
      } catch (error) {
        console.error('Error creating alert:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to create alert.',
        });
      }
    }),

  markAsRead: protectedProcedure
    .input(MarkAsReadInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const alert = await db.getAlertById(input.alertId);
        
        if (!alert || alert.userId !== ctx.user.id) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Alert not found.',
          });
        }

        await db.markAlertAsRead(input.alertId);

        return {
          success: true,
          message: 'Alert marked as read.',
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error('Error marking alert as read:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to mark alert as read.',
        });
      }
    }),

  delete: protectedProcedure
    .input(DeleteAlertInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const alert = await db.getAlertById(input.alertId);
        
        if (!alert || alert.userId !== ctx.user.id) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Alert not found.',
          });
        }

        await db.deleteAlert(input.alertId);

        return {
          success: true,
          message: 'Alert deleted successfully.',
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error('Error deleting alert:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to delete alert.',
        });
      }
    }),
});

export type AlertsRouter = typeof alertsRouter;
