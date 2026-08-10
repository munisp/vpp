import { z } from 'zod';
import { protectedProcedure, router } from '../../_core/trpc';
import { settlementLedger } from '../../services/settlement-ledger';

export const settlementRouter = router({
    createEvent: protectedProcedure
      .input(z.object({
        eventType: z.enum([
          'dispatch_completed', 'service_delivered', 'measurement_verified',
          'compensation_calculated', 'payment_initiated', 'payment_completed',
          'dispute_raised', 'dispute_resolved', 'adjustment_applied'
        ]),
        sourceType: z.string(),
        sourceId: z.number(),
        energyWh: z.number().optional(),
        grossAmount: z.number(),
        fees: z.number().default(0),
        netAmount: z.number(),
        currency: z.enum(['NGN', 'TZS', 'USD']).default('TZS'),
        eventData: z.record(z.string(), z.any()).optional(),
      }))
            .mutation(async ({ input, ctx }) => {
              return settlementLedger.createEvent({
                ...input,
                userId: ctx.user.id,
                eventData: input.eventData || {},
              });
            }),

    getUserEvents: protectedProcedure
      .input(z.object({
        fromDate: z.date().optional(),
        toDate: z.date().optional(),
        eventTypes: z.array(z.string()).optional(),
        limit: z.number().default(50),
        offset: z.number().default(0),
      }).optional())
      .query(async ({ input, ctx }) => {
        return settlementLedger.getUserEvents(ctx.user.id, input || {});
      }),

  verifyChain: protectedProcedure
    .input(z.object({
      fromSequence: z.number().optional(),
      toSequence: z.number().optional(),
    }).optional())
    .query(async ({ input }) => {
      return settlementLedger.verifyChain(input?.fromSequence, input?.toSequence);
    }),

  calculatePeriodSummary: protectedProcedure
    .input(z.object({
      periodStart: z.date(),
      periodEnd: z.date(),
    }))
    .query(async ({ input, ctx }) => {
      return settlementLedger.calculatePeriodSummary(ctx.user.id, input.periodStart, input.periodEnd);
    }),
});
