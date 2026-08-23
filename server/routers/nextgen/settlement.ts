import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { adminProcedure, protectedProcedure, router } from '../../_core/trpc';
import { settlementLedger } from '../../services/settlement-ledger';
import {
  DegradedOperationError,
  requireCapability,
} from '../../services/degraded-operation';

/**
 * Capability a hand-written settlement event has to satisfy. An event carrying
 * energy is a claim about measured delivery, so it needs the meter path; a
 * payment event is a claim the gateway moved money, so it needs the gateway.
 */
function capabilityFor(eventType: string, hasEnergy: boolean): string {
  if (eventType === 'payment_initiated' || eventType === 'payment_completed') {
    return 'settlement_payout';
  }
  return hasEnergy ? 'metered_settlement' : 'flexibility_settlement';
}

export const settlementRouter = router({
    /**
     * Writing to the settlement ledger by hand is an operator action: the amount
     * is not derived from anything the platform measured, so a member must not be
     * able to append their own compensation. It is still evidence-guarded — an
     * amount written while the meter or gateway path was unobservable is not a
     * measurement of delivery or of payment.
     */
    createEvent: adminProcedure
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
        /** Member the event settles for; an operator never settles to themselves. */
        userId: z.number().int().positive(),
      }))
      .mutation(async ({ input, ctx }) => {
        const capability = capabilityFor(input.eventType, input.energyWh !== undefined);
        try {
          await requireCapability(capability);
        } catch (error) {
          if (error instanceof DegradedOperationError) {
            throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: error.message });
          }
          throw error;
        }

        const { userId, ...event } = input;
        return settlementLedger.createEvent({
          ...event,
          userId,
          // Who typed it stays on the row: a hand-written amount is attributable.
          eventData: { ...(input.eventData ?? {}), recordedByUserId: ctx.user.id },
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
