import { z } from 'zod';
import { router, protectedProcedure } from '../../_core/trpc';
import { TRPCError } from '@trpc/server';
import {
  cancelEvChargingPlan,
  createEvChargingPlan,
  listEvChargingPlans,
  listEvChargingSessions,
  syncEvChargingSessions,
} from '../../services/innov3-ev-charging';

function toError(error: unknown): TRPCError {
  const message = error instanceof Error ? error.message : '';
  if (message === 'ASSET_NOT_FOUND') return new TRPCError({ code: 'NOT_FOUND', message: 'Asset not found.' });
  if (message === 'ASSET_NOT_OWNED') return new TRPCError({ code: 'FORBIDDEN', message: 'You do not own this asset.' });
  if (message === 'ASSET_NOT_BATTERY') return new TRPCError({ code: 'BAD_REQUEST', message: 'EV charging planning is only available for battery assets.' });
  if (message === 'DEPARTURE_IN_PAST') return new TRPCError({ code: 'BAD_REQUEST', message: 'Departure time must be in the future.' });
  if (message === 'INVALID_CHARGE_POWER') return new TRPCError({ code: 'BAD_REQUEST', message: 'Charge power must be positive.' });
  if (message === 'PLAN_NOT_FOUND') return new TRPCError({ code: 'NOT_FOUND', message: 'Plan not found.' });
  if (message === 'PLAN_NOT_OWNED') return new TRPCError({ code: 'FORBIDDEN', message: 'You do not own this plan.' });
  if (message === 'PLAN_NOT_CANCELLABLE') return new TRPCError({ code: 'BAD_REQUEST', message: 'Only scheduled or active plans can be cancelled.' });
  console.error('[Innov3EvCharging]', error);
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'EV charging planner request failed.' });
}

/**
 * EV smart charging planner router.
 *
 * Plans are priced exclusively from the published dynamic tariff for the
 * user's country; when none is published the plan is persisted with
 * scheduleAvailable:false and reason 'no_tariff' — no schedule is invented.
 * Sessions are derived from real SoC telemetry only.
 */
export const evChargingRouter = router({
  createPlan: protectedProcedure
    .input(z.object({
      assetId: z.number().int().positive(),
      departureTime: z.coerce.date(),
      targetSocPct100: z.number().int().min(0).max(10000),
      maxChargePowerW: z.number().int().positive().max(1_000_000),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await createEvChargingPlan(ctx.user.id, ctx.user.country, input);
      } catch (error) {
        throw toError(error);
      }
    }),

  listPlans: protectedProcedure
    .input(z.object({
      assetId: z.number().int().positive().optional(),
      limit: z.number().int().positive().max(50).default(20),
    }))
    .query(async ({ ctx, input }) => {
      try {
        return await listEvChargingPlans(ctx.user.id, input.assetId, input.limit);
      } catch (error) {
        throw toError(error);
      }
    }),

  cancelPlan: protectedProcedure
    .input(z.object({ planId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await cancelEvChargingPlan(input.planId, ctx.user.id);
      } catch (error) {
        throw toError(error);
      }
    }),

  // Derive actual charging sessions from the asset's SoC telemetry (idempotent).
  syncSessions: protectedProcedure
    .input(z.object({ assetId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await syncEvChargingSessions(input.assetId, ctx.user.id);
      } catch (error) {
        throw toError(error);
      }
    }),

  listSessions: protectedProcedure
    .input(z.object({
      assetId: z.number().int().positive(),
      limit: z.number().int().positive().max(100).default(20),
    }))
    .query(async ({ ctx, input }) => {
      try {
        return await listEvChargingSessions(input.assetId, ctx.user.id, input.limit);
      } catch (error) {
        throw toError(error);
      }
    }),
});

export type EvChargingRouter = typeof evChargingRouter;
