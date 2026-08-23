import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { adminProcedure, protectedProcedure, router } from '../_core/trpc';
import {
  assignmentsForUser,
  controlHealth,
  maxValiditySeconds,
  recentAssignments,
  ControlValidityError,
  EXPIRING_WINDOW_SECONDS,
  MIN_VALIDITY_SECONDS,
} from '../services/control-validity';
import {
  dispatchChargingPlan,
  installFallbackProfile,
  sweepExpiredControls,
} from '../services/control-delivery';
import { GridCommandError } from '../services/grid-commands';

/**
 * Control validity windows.
 *
 * Read paths are honest about what the hardware is doing: a control whose window
 * closed reads `expired_awaiting_fallback` until the fallback is delivered, and a
 * fallback the device refused reads `fallback_failed` rather than disappearing.
 */

function mapError(error: unknown): never {
  if (error instanceof ControlValidityError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
  }
  if (error instanceof GridCommandError) {
    throw new TRPCError({
      code: error.status === 503 || error.status === 502 ? 'SERVICE_UNAVAILABLE' : 'BAD_REQUEST',
      message: error.message,
    });
  }
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: error instanceof Error ? error.message : 'control operation failed',
  });
}

export const controlWindowsRouter = router({
  /** Policy the deployment enforces, so clients can validate before dispatching. */
  policy: protectedProcedure.query(() => {
    try {
      return {
        maxValiditySeconds: maxValiditySeconds(),
        minValiditySeconds: MIN_VALIDITY_SECONDS,
        expiringWithinSeconds: EXPIRING_WINDOW_SECONDS,
      };
    } catch (error) {
      mapError(error);
    }
  }),

  /** The caller's own controls (their EV, their battery). */
  mine: protectedProcedure
    .input(z.object({ limit: z.number().int().positive().max(100).default(25) }).optional())
    .query(async ({ ctx, input }) => {
      const rows = await assignmentsForUser(ctx.user.id, input?.limit ?? 25);
      return { assignments: rows, count: rows.length };
    }),

  /** Fleet view for operators. */
  fleet: adminProcedure
    .input(z.object({ limit: z.number().int().positive().max(200).default(50) }).optional())
    .query(async ({ input }) => {
      const rows = await recentAssignments(input?.limit ?? 50);
      return { assignments: rows, count: rows.length };
    }),

  health: adminProcedure.query(async () => controlHealth()),

  /**
   * Dispatches a bounded charging plan. There is no unbounded variant on
   * purpose: a caller that cannot say when its setpoint expires cannot dispatch.
   */
  dispatchChargingPlan: adminProcedure
    .input(
      z.object({
        chargePointId: z.string().min(1).max(191),
        connectorId: z.number().int().min(0),
        chargingProfileId: z.number().int().positive(),
        transactionId: z.number().int().positive().optional(),
        periods: z
          .array(
            z.object({
              startPeriodSeconds: z.number().int().min(0),
              limitWatts: z.number().finite(),
              numberPhases: z.number().int().min(1).max(3).optional(),
            })
          )
          .min(1),
        validFrom: z.coerce.date().optional(),
        validTo: z.coerce.date().optional(),
        validForSeconds: z.number().int().positive().optional(),
        fallbackPolicy: z.enum(['safe_limit', 'resume_local', 'hold_last']),
        fallbackLimitWatts: z.number().finite().optional(),
        assetId: z.number().int().positive().optional(),
        evId: z.number().int().positive().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await dispatchChargingPlan({ ...input, source: 'manual', userId: ctx.user.id });
      } catch (error) {
        mapError(error);
      }
    }),

  /** Installs the standing safe-limit profile a charge point degrades to. */
  installFallbackProfile: adminProcedure
    .input(
      z.object({
        chargePointId: z.string().min(1).max(191),
        connectorId: z.number().int().min(0),
        limitWatts: z.number().finite().optional(),
        chargingProfileId: z.number().int().positive().optional(),
      })
    )
    .mutation(async ({ input }) => {
      try {
        return await installFallbackProfile(input);
      } catch (error) {
        mapError(error);
      }
    }),

  /** Runs the fallback sweep now; the periodic sweeper calls the same code. */
  sweepNow: adminProcedure.mutation(async () => {
    try {
      return await sweepExpiredControls();
    } catch (error) {
      mapError(error);
    }
  }),
});
