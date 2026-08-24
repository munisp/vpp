/**
 * Protocol conformance surfaces.
 *
 * Reads are admin-only: which adapters have been proven, against what, and which
 * controls went out over a wire nobody had tested is operator information, and a
 * member can act on none of it. The one member-facing read is on their own
 * asset's capability evidence, exposed through `derCapabilities`.
 *
 * There is no procedure here that marks a protocol proven. Proof arrives from
 * the protocol services over the signed ingest route in
 * `server/webhooks/grid-protocols.ts` — the same code that talks to devices —
 * because a conformance claim an operator can type is not evidence.
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { adminProcedure, router } from '../../_core/trpc';
import {
  ConformanceError,
  adapterCoverage,
  certifyAsset,
  getRun,
  listRuns,
  unprovenDispatches,
} from '../../services/protocol-conformance';
import { CONFORMANCE_ADAPTERS } from '../../../shared/protocol-conformance-copy';

const adapterSchema = z.enum(
  CONFORMANCE_ADAPTERS as unknown as [string, ...string[]]
) as z.ZodType<(typeof CONFORMANCE_ADAPTERS)[number]>;

function toTRPCError(error: unknown): never {
  if (error instanceof ConformanceError) {
    throw new TRPCError({
      code:
        error.status === 503
          ? 'SERVICE_UNAVAILABLE'
          : error.status === 404
            ? 'NOT_FOUND'
            : 'BAD_REQUEST',
      message: error.message,
    });
  }
  throw error;
}

export const protocolConformanceRouter = router({
  /** Per-adapter evidence plus how many assets are leaning on each. */
  coverage: adminProcedure.query(async () => {
    try {
      return await adapterCoverage();
    } catch (error) {
      toTRPCError(error);
    }
  }),

  runs: adminProcedure
    .input(
      z
        .object({
          adapter: adapterSchema.optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      try {
        return await listRuns(input ?? {});
      } catch (error) {
        toTRPCError(error);
      }
    }),

  run: adminProcedure
    .input(z.object({ runId: z.number().int().positive() }))
    .query(async ({ input }) => {
      try {
        const run = await getRun(input.runId);
        if (!run) {
          throw new TRPCError({ code: 'NOT_FOUND', message: `no conformance run ${input.runId}` });
        }
        return run;
      } catch (error) {
        toTRPCError(error);
      }
    }),

  /**
   * Controls issued over an adapter with no live proof. The audit question after
   * an incident, and a commissioning to-do list before one.
   */
  unprovenDispatches: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).optional() }).optional())
    .query(async ({ input }) => {
      try {
        return await unprovenDispatches(input?.limit ?? 50);
      } catch (error) {
        toTRPCError(error);
      }
    }),

  /**
   * Records a certification against a passing run. Refused when the run does
   * not exist, did not pass, or exercised a different adapter.
   */
  certifyAsset: adminProcedure
    .input(
      z.object({
        assetId: z.number().int().positive(),
        adapter: adapterSchema,
        conformanceRunId: z.number().int().positive(),
        expiresAt: z.date().optional(),
        note: z.string().max(2000).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await certifyAsset({
          ...input,
          certifiedBy: `user:${ctx.user.id}`,
        });
      } catch (error) {
        toTRPCError(error);
      }
    }),
});
