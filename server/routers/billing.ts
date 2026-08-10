import { z } from 'zod';
import { router, protectedProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import * as db from '../db';

const CreateBillingInputSchema = z.object({
  billingType: z.enum(['postpaid', 'prepaid']),
  periodStart: z.date().or(z.string().datetime()),
  periodEnd: z.date().or(z.string().datetime()),
  generationKwh: z.number().int().nonnegative().default(0),
  consumptionKwh: z.number().int().nonnegative().default(0),
  exportKwh: z.number().int().nonnegative().default(0),
  exportRevenue: z.number().int().nonnegative().default(0),
  selfConsumptionSavings: z.number().int().nonnegative().default(0),
});

const UpdateBillingStatusInputSchema = z.object({
  billingId: z.number().int().positive(),
  status: z.enum(['draft', 'issued', 'paid', 'overdue', 'cancelled']),
  paymentMethod: z.string().optional(),
  transactionId: z.string().optional(),
});

export const billingRouter = router({
  create: protectedProcedure
    .input(CreateBillingInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const contract = await db.getUserActiveContract(ctx.user.id);
        if (!contract) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'No active contract found.',
          });
        }

        const totalValue = input.exportRevenue + input.selfConsumptionSavings;
        const consumerShare = Math.floor((totalValue * contract.revenueSharePercentage) / 100);
        const vppCommission = totalValue - consumerShare;

        const billing = await db.createBilling({
          userId: ctx.user.id,
          billingType: input.billingType,
          periodStart: new Date(input.periodStart),
          periodEnd: new Date(input.periodEnd),
          generationKwh: input.generationKwh,
          consumptionKwh: input.consumptionKwh,
          exportKwh: input.exportKwh,
          exportRevenue: input.exportRevenue,
          selfConsumptionSavings: input.selfConsumptionSavings,
          totalValue,
          consumerShare,
          vppCommission,
          status: 'draft',
        });

        return {
          success: true,
          billing,
          message: 'Billing created successfully.',
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error('Error creating billing:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to create billing.',
        });
      }
    }),

  list: protectedProcedure
    .input(z.object({ limit: z.number().int().positive().max(50).default(12) }))
    .query(async ({ ctx, input }) => {
      try {
        const billings = await db.getUserBillings(ctx.user.id, input.limit);
        return {
          billings,
          count: billings.length,
        };
      } catch (error) {
        console.error('Error listing billings:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to retrieve billings.',
        });
      }
    }),

  getById: protectedProcedure
    .input(z.object({ billingId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      try {
        const billing = await db.getBillingById(input.billingId);
        
        if (!billing || billing.userId !== ctx.user.id) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Billing not found.',
          });
        }

        return billing;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error('Error getting billing:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to retrieve billing.',
        });
      }
    }),

  updateStatus: protectedProcedure
    .input(UpdateBillingStatusInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const billing = await db.getBillingById(input.billingId);
        
        if (!billing || billing.userId !== ctx.user.id) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Billing not found.',
          });
        }

        const paidAt = input.status === 'paid' ? new Date() : undefined;
        
        await db.updateBillingStatus(
          input.billingId,
          input.status,
          paidAt,
          input.paymentMethod,
          input.transactionId
        );

        return {
          success: true,
          message: 'Billing status updated successfully.',
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error('Error updating billing status:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update billing status.',
        });
      }
    }),
});

export type BillingRouter = typeof billingRouter;
