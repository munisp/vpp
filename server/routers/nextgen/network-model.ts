/**
 * Network model and feasibility studies.
 *
 * Admin-only throughout: conductor impedances, transformer ratings and which
 * element limits a feeder are network information, and a member cannot act on
 * a study in any case. Every read can come back saying the network is not
 * modelled — that is an answer, not an empty state to hide.
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { adminProcedure, router } from '../../_core/trpc';
import {
  NetworkFeasibilityError,
  isNetworkFeasibilityConfigured,
  networkModelSummary,
  recentStudies,
  registerLine,
  registerTransformer,
  setNodeElectrical,
  studyFeasibility,
} from '../../services/network-feasibility';

function toTRPCError(error: unknown): never {
  if (error instanceof NetworkFeasibilityError) {
    throw new TRPCError({
      code: error.message === 'Database not available' ? 'SERVICE_UNAVAILABLE' : 'BAD_REQUEST',
      message: error.message,
    });
  }
  throw error;
}

export const networkModelRouter = router({
  /** Whether a feasibility engine is even configured for this deployment. */
  serviceStatus: adminProcedure.query(() => ({
    configured: isNetworkFeasibilityConfigured(),
    /** Read by the UI to explain an unchecked dispatch rather than blame the data. */
    note: isNetworkFeasibilityConfigured()
      ? null
      : 'GRIDMODEL_SERVICE_URL is not set: dispatch and clearing run network-unchecked',
  })),

  summary: adminProcedure
    .input(z.object({ nodeId: z.number().int().positive() }))
    .query(async ({ input }) => {
      try {
        return await networkModelSummary(input.nodeId);
      } catch (error) {
        toTRPCError(error);
      }
    }),

  setNodeElectrical: adminProcedure
    .input(
      z.object({
        nodeId: z.number().int().positive(),
        nominalVolts: z.number().int().positive(),
        isSource: z.boolean().optional(),
        voltageMinPuX1000: z.number().int().positive().optional(),
        voltageMaxPuX1000: z.number().int().positive().optional(),
      })
    )
    .mutation(async ({ input }) => {
      try {
        await setNodeElectrical(input);
        return { ok: true as const };
      } catch (error) {
        toTRPCError(error);
      }
    }),

  registerLine: adminProcedure
    .input(
      z.object({
        code: z.string().min(1).max(80),
        fromNodeId: z.number().int().positive(),
        toNodeId: z.number().int().positive(),
        lengthM: z.number().int().positive(),
        resistanceMohmPerKm: z.number().int().positive(),
        reactanceMohmPerKm: z.number().int().positive(),
        maxCurrentMa: z.number().int().positive(),
        capacitanceNfPerKm: z.number().int().nonnegative().optional(),
        parallelCircuits: z.number().int().positive().optional(),
        dataSource: z.string().max(200).optional(),
      })
    )
    .mutation(async ({ input }) => {
      try {
        return { lineId: await registerLine(input) };
      } catch (error) {
        toTRPCError(error);
      }
    }),

  registerTransformer: adminProcedure
    .input(
      z.object({
        code: z.string().min(1).max(80),
        hvNodeId: z.number().int().positive(),
        lvNodeId: z.number().int().positive(),
        ratedKva: z.number().int().positive(),
        hvVolts: z.number().int().positive(),
        lvVolts: z.number().int().positive(),
        shortCircuitPercentX100: z.number().int().positive(),
        shortCircuitResistivePercentX100: z.number().int().nonnegative().optional(),
        ironLossW: z.number().int().nonnegative().optional(),
        openLoopCurrentPercentX100: z.number().int().nonnegative().optional(),
        dataSource: z.string().max(200).optional(),
      })
    )
    .mutation(async ({ input }) => {
      try {
        return { transformerId: await registerTransformer(input) };
      } catch (error) {
        toTRPCError(error);
      }
    }),

  /**
   * Run a connection enquiry: what could this node host, and what stops more.
   *
   * A study is a study whatever it concludes, so a `model_unavailable` or
   * `service_unavailable` answer is returned rather than thrown.
   */
  study: adminProcedure
    .input(
      z.object({
        nodeId: z.number().int().positive(),
        reference: z.string().max(200).optional(),
        candidate: z
          .array(
            z.object({
              bus: z.string().min(1).max(80),
              delta_p_w: z.number(),
              delta_q_var: z.number().optional(),
              reference: z.string().max(200).optional(),
            })
          )
          .max(50)
          .optional(),
        hostingCapacity: z
          .array(
            z.object({
              bus: z.string().min(1).max(80),
              direction: z.enum(['injection', 'consumption']).optional(),
              /** Search ceiling: the answer is capped here and says so. */
              limit_w: z.number().positive().max(50_000_000).optional(),
            })
          )
          .max(10)
          .optional(),
      })
    )
    .mutation(async ({ input }) => {
      try {
        return await studyFeasibility({
          subject: 'connection_enquiry',
          subjectReference: input.reference,
          nodeId: input.nodeId,
          candidate: input.candidate,
          hostingCapacity: input.hostingCapacity,
        });
      } catch (error) {
        toTRPCError(error);
      }
    }),

  studies: adminProcedure
    .input(
      z
        .object({
          subject: z
            .enum(['dispatch', 'flexibility_clearing', 'connection_enquiry'])
            .optional(),
          subjectReference: z.string().max(200).optional(),
          nodeId: z.number().int().positive().optional(),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .default({ limit: 50 })
    )
    .query(async ({ input }) => {
      try {
        return await recentStudies(
          {
            subject: input.subject,
            subjectReference: input.subjectReference,
            nodeId: input.nodeId,
          },
          input.limit
        );
      } catch (error) {
        toTRPCError(error);
      }
    }),
});
