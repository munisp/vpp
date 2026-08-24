import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { adminProcedure, protectedProcedure, router } from '../../_core/trpc';
import {
  INTERRUPTION_CAUSES,
  INTERRUPTION_DETECTION_SOURCES,
  SERVICE_POINT_CLASSES,
  SERVICE_POINT_MONITORING,
  ServiceReliabilityError,
  closeInterruption,
  detectInterruptionsFromTelemetryGaps,
  disconnectServicePoint,
  reconnectServicePoint,
  setServicePointMonitoring,
  listInterruptions,
  listServicePoints,
  recordInterruption,
  registerServicePoint,
  reliabilityReport,
} from '../../services/service-reliability';

/**
 * Customer supply reliability: how often the power goes off at a registered
 * connection, and for how long.
 *
 * Operators (admin) register connections, record and close interruptions, run
 * gap detection and read the indices. A member can read the reliability of their
 * own connections only — a household should be able to see its own outage
 * history without seeing the fleet's.
 *
 * Every figure here carries the coverage behind it. An index computed over three
 * monitored connections out of two hundred is reported as exactly that.
 */
function toTRPCError(error: unknown): never {
  if (error instanceof ServiceReliabilityError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
  }
  throw error;
}

const periodInput = z.object({
  start: z.coerce.date(),
  end: z.coerce.date(),
  communityId: z.number().int().positive().optional(),
});

export const reliabilityRouter = router({
  /** IEEE 1366 indices for a period, with coverage and limitations. */
  report: adminProcedure.input(periodInput).query(async ({ input }) => {
    try {
      return await reliabilityReport(
        { start: input.start, end: input.end },
        { communityId: input.communityId }
      );
    } catch (error) {
      toTRPCError(error);
    }
  }),

  /** The connection register an index is averaged over. */
  servicePoints: adminProcedure
    .input(z.object({ communityId: z.number().int().positive().optional() }).optional())
    .query(async ({ input }) => {
      try {
        return await listServicePoints({ communityId: input?.communityId });
      } catch (error) {
        toTRPCError(error);
      }
    }),

  /** A member's own connections. */
  myServicePoints: protectedProcedure.query(async ({ ctx }) => {
    try {
      return await listServicePoints({ userId: ctx.user.id });
    } catch (error) {
      toTRPCError(error);
    }
  }),

  /**
   * A member's own outage history. Computed over their connections only, so the
   * indices describe their supply rather than the fleet's.
   */
  myReliability: protectedProcedure
    .input(z.object({ start: z.coerce.date(), end: z.coerce.date() }))
    .query(async ({ ctx, input }) => {
      try {
        const [assessment, servicePoints, interruptions] = await Promise.all([
          reliabilityReport(
            { start: input.start, end: input.end },
            { userId: ctx.user.id }
          ),
          listServicePoints({ userId: ctx.user.id }),
          listInterruptions({ userId: ctx.user.id, limit: 200 }),
        ]);
        return {
          assessment,
          servicePoints,
          interruptions,
          period: { start: input.start, end: input.end },
        };
      } catch (error) {
        toTRPCError(error);
      }
    }),

  interruptions: adminProcedure
    .input(
      z
        .object({
          communityId: z.number().int().positive().optional(),
          servicePointId: z.number().int().positive().optional(),
          openOnly: z.boolean().optional(),
          limit: z.number().int().min(1).max(500).optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      try {
        return await listInterruptions(input ?? {});
      } catch (error) {
        toTRPCError(error);
      }
    }),

  registerServicePoint: adminProcedure
    .input(
      z.object({
        userId: z.number().int().positive(),
        communityId: z.number().int().positive().nullish(),
        code: z.string().min(1).max(64),
        pointClass: z.enum(SERVICE_POINT_CLASSES),
        monitoring: z.enum(SERVICE_POINT_MONITORING),
        meterAssetId: z.number().int().positive().nullish(),
        expectedReportIntervalSeconds: z.number().int().positive().max(86_400).nullish(),
        connectedAt: z.coerce.date(),
        notes: z.string().max(500).nullish(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await registerServicePoint(input, ctx.user.id);
      } catch (error) {
        toTRPCError(error);
      }
    }),

  /** Move a connection in or out of the observed population. */
  setServicePointMonitoring: adminProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        monitoring: z.enum(SERVICE_POINT_MONITORING),
        meterAssetId: z.number().int().positive().nullish(),
        expectedReportIntervalSeconds: z.number().int().positive().max(86_400).nullish(),
      })
    )
    .mutation(async ({ input }) => {
      try {
        return await setServicePointMonitoring(input.id, input.monitoring, {
          meterAssetId: input.meterAssetId,
          expectedReportIntervalSeconds: input.expectedReportIntervalSeconds,
        });
      } catch (error) {
        toTRPCError(error);
      }
    }),

  /** Stop a connection's exposure at the instant it was disconnected. */
  disconnectServicePoint: adminProcedure
    .input(z.object({ id: z.number().int().positive(), disconnectedAt: z.coerce.date() }))
    .mutation(async ({ input }) => {
      try {
        return await disconnectServicePoint(input.id, input.disconnectedAt);
      } catch (error) {
        toTRPCError(error);
      }
    }),

  reconnectServicePoint: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      try {
        return await reconnectServicePoint(input.id);
      } catch (error) {
        toTRPCError(error);
      }
    }),

  recordInterruption: adminProcedure
    .input(
      z.object({
        servicePointId: z.number().int().positive(),
        startedAt: z.coerce.date(),
        endedAt: z.coerce.date().nullish(),
        cause: z.enum(INTERRUPTION_CAUSES),
        detectionSource: z.enum(INTERRUPTION_DETECTION_SOURCES),
        evidenceRef: z.string().min(1).max(200),
        restoredEvidenceRef: z.string().max(200).nullish(),
        excludeFromIndices: z.boolean().optional(),
        exclusionReason: z.string().max(200).nullish(),
        notes: z.string().max(500).nullish(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await recordInterruption(input, ctx.user.id);
      } catch (error) {
        toTRPCError(error);
      }
    }),

  closeInterruption: adminProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        endedAt: z.coerce.date(),
        restoredEvidenceRef: z.string().min(1).max(200),
      })
    )
    .mutation(async ({ input }) => {
      try {
        return await closeInterruption(input.id, input.endedAt, input.restoredEvidenceRef);
      } catch (error) {
        toTRPCError(error);
      }
    }),

  /**
   * Sweep metered connections for meter silence. Reports what it skipped and
   * why, so an empty result cannot be read as "every meter is reporting".
   */
  detectGaps: adminProcedure
    .input(z.object({ communityId: z.number().int().positive().optional() }).optional())
    .mutation(async ({ input }) => {
      try {
        return await detectInterruptionsFromTelemetryGaps({ communityId: input?.communityId });
      } catch (error) {
        toTRPCError(error);
      }
    }),
});
