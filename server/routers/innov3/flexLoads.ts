import { z } from 'zod';
import { router, protectedProcedure, adminProcedure } from '../../_core/trpc';
import { TRPCError } from '@trpc/server';
import {
  createProgram,
  dispatchProgramToEvent,
  enrollAsset,
  listMyEnrollments,
  listProgramEnrollments,
  listPrograms,
  setEnrollmentStatus,
  setProgramStatus,
  syncIncentives,
} from '../../services/innov3-flex-loads';

const WindowRulesSchema = z.object({
  maxEventsPerDay: z.number().int().positive().optional(),
  windowStartHour: z.number().int().min(0).max(23).optional(),
  windowEndHour: z.number().int().min(0).max(23).optional(),
  maxEventMinutes: z.number().int().positive().optional(),
});

function toError(error: unknown): TRPCError {
  const message = error instanceof Error ? error.message : '';
  if (message === 'PROGRAM_NOT_FOUND' || message === 'ENROLLMENT_NOT_FOUND' || message === 'ASSET_NOT_FOUND') {
    return new TRPCError({ code: 'NOT_FOUND', message: 'Program, enrollment or asset not found.' });
  }
  if (message === 'DR_EVENT_NOT_FOUND') return new TRPCError({ code: 'NOT_FOUND', message: 'Demand response event not found.' });
  if (message === 'ASSET_NOT_OWNED' || message === 'FORBIDDEN') {
    return new TRPCError({ code: 'FORBIDDEN', message: 'You do not own this asset or enrollment.' });
  }
  if (message === 'PROGRAM_NOT_ACTIVE') return new TRPCError({ code: 'BAD_REQUEST', message: 'Program is not active.' });
  if (message === 'ASSET_TYPE_MISMATCH') return new TRPCError({ code: 'BAD_REQUEST', message: 'Asset type does not match the program.' });
  if (message === 'ALREADY_ENROLLED') return new TRPCError({ code: 'CONFLICT', message: 'Asset is already enrolled in this program.' });
  if (message.startsWith('INVALID_TRANSITION') || message.startsWith('INVALID_RULES')) {
    return new TRPCError({ code: 'BAD_REQUEST', message: `Invalid operation (${message.split(':')[1]}).` });
  }
  if (message.startsWith('EVENT_OUTSIDE_RULES')) {
    return new TRPCError({ code: 'BAD_REQUEST', message: `Event violates program window rules: ${message.slice('EVENT_OUTSIDE_RULES:'.length)}` });
  }
  console.error('[FlexLoads]', error);
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Flexible load operation failed.' });
}

/**
 * Flexible load programs router.
 *
 * Programs are admin-defined; users enroll their own assets. Dispatch links
 * enrollments to a real demandResponseEvents row. incentiveCents stays null
 * until a real rate exists on the program AND a real drResponses
 * compensation has been recorded — no invented payouts.
 */
export const flexLoadsRouter = router({
  createProgram: adminProcedure
    .input(z.object({
      name: z.string().min(1).max(255),
      description: z.string().max(5000).optional(),
      assetType: z.enum(['solar', 'battery', 'meter', 'generator', 'wind']),
      eventWindowRules: WindowRulesSchema.optional(),
      incentiveRateCentsPerKwh: z.number().int().nonnegative().nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        const program = await createProgram(ctx.user.id, input);
        return { success: true, program };
      } catch (error) {
        throw toError(error);
      }
    }),

  setProgramStatus: adminProcedure
    .input(z.object({
      programId: z.number().int().positive(),
      status: z.enum(['draft', 'active', 'retired']),
    }))
    .mutation(async ({ input }) => {
      try {
        const program = await setProgramStatus(input.programId, input.status);
        return { success: true, program };
      } catch (error) {
        throw toError(error);
      }
    }),

  listPrograms: protectedProcedure
    .input(z.object({ includeRetired: z.boolean().default(false) }))
    .query(async ({ input }) => {
      try {
        const programs = await listPrograms(input.includeRetired);
        return { programs, count: programs.length };
      } catch (error) {
        throw toError(error);
      }
    }),

  enroll: protectedProcedure
    .input(z.object({
      programId: z.number().int().positive(),
      assetId: z.number().int().positive(),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        const enrollment = await enrollAsset(ctx.user.id, input.programId, input.assetId);
        return { success: true, enrollment };
      } catch (error) {
        throw toError(error);
      }
    }),

  setEnrollmentStatus: protectedProcedure
    .input(z.object({
      enrollmentId: z.number().int().positive(),
      status: z.enum(['active', 'suspended', 'withdrawn']),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        const enrollment = await setEnrollmentStatus(ctx.user.id, input.enrollmentId, input.status);
        return { success: true, enrollment };
      } catch (error) {
        throw toError(error);
      }
    }),

  myEnrollments: protectedProcedure.query(async ({ ctx }) => {
    try {
      const enrollments = await listMyEnrollments(ctx.user.id);
      return { enrollments, count: enrollments.length };
    } catch (error) {
      throw toError(error);
    }
  }),

  programEnrollments: adminProcedure
    .input(z.object({ programId: z.number().int().positive() }))
    .query(async ({ input }) => {
      try {
        const enrollments = await listProgramEnrollments(input.programId);
        return { enrollments, count: enrollments.length };
      } catch (error) {
        throw toError(error);
      }
    }),

  /** Dispatch a program's active enrollments to a real DR event. */
  dispatch: adminProcedure
    .input(z.object({
      programId: z.number().int().positive(),
      drEventId: z.number().int().positive(),
    }))
    .mutation(async ({ input }) => {
      try {
        return await dispatchProgramToEvent(input.programId, input.drEventId);
      } catch (error) {
        throw toError(error);
      }
    }),

  /**
   * Copy real recorded drResponses compensation onto dispatched enrollments.
   * Enrollments with no real rate or no real compensation stay null.
   */
  syncIncentives: adminProcedure
    .input(z.object({
      programId: z.number().int().positive(),
      drEventId: z.number().int().positive(),
    }))
    .mutation(async ({ input }) => {
      try {
        return await syncIncentives(input.programId, input.drEventId);
      } catch (error) {
        throw toError(error);
      }
    }),
});

export type FlexLoadsRouter = typeof flexLoadsRouter;
