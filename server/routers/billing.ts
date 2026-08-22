import { z } from 'zod';
import { router, protectedProcedure, adminProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import * as db from '../db';
import { payments } from '../../drizzle/schema';
import { and, eq } from 'drizzle-orm';

const CreateBillingInputSchema = z.object({
  userId: z.number().int().positive(),
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
  /**
   * Issue an invoice. Invoice inputs (metered energy, export revenue) determine
   * what the consumer is paid and owed, so they are settlement inputs and are
   * never accepted from the billed consumer.
   */
  create: adminProcedure
    .input(CreateBillingInputSchema)
    .mutation(async ({ input }) => {
      try {
        const contract = await db.getUserActiveContract(input.userId);
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
          userId: input.userId,
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

  /**
   * Move an invoice between lifecycle states. `paid` is only reachable with a
   * completed payment covering the consumer share, so an invoice can never be
   * settled without gateway-confirmed money.
   */
  updateStatus: adminProcedure
    .input(UpdateBillingStatusInputSchema)
    .mutation(async ({ input }) => {
      try {
        const billing = await db.getBillingById(input.billingId);

        if (!billing) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Billing not found.',
          });
        }

        if (input.status === 'paid') {
          const dbInstance = await db.getDb();
          if (!dbInstance) throw new Error('Database not available');

          const completed = await dbInstance
            .select({ amount: payments.amount, transactionId: payments.transactionId })
            .from(payments)
            .where(
              and(
                eq(payments.billingId, billing.id),
                eq(payments.status, 'completed')
              )
            );

          const settledCents = completed.reduce((sum, row) => sum + row.amount, 0);

          if (settledCents < billing.consumerShare) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `Invoice cannot be marked paid: confirmed payments total ${settledCents} of ${billing.consumerShare} cents.`,
            });
          }

          if (
            input.transactionId &&
            !completed.some((row) => row.transactionId === input.transactionId)
          ) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'transactionId does not match any confirmed payment for this invoice.',
            });
          }
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
