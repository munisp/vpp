import { z } from 'zod';
import { router, protectedProcedure } from '../../_core/trpc';
import { TRPCError } from '@trpc/server';
import {
  downloadExport,
  ExportJobError,
  getExport,
  listExports,
  requestExport,
} from '../../services/innov3-green-button';

function toError(error: unknown): TRPCError {
  if (error instanceof ExportJobError) {
    const notFound = error.message.includes('not found');
    return new TRPCError({ code: notFound ? 'NOT_FOUND' : 'BAD_REQUEST', message: error.message });
  }
  console.error('[Innov3GreenButton]', error);
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Export failed.' });
}

/**
 * Green Button data export router (innovation 16).
 *
 * A user exports their OWN usage/billing data as CSV or an ESPI-flavored
 * XML envelope. The job lifecycle (queued -> ready/failed) is persisted;
 * an empty period is ready with zero rows and empty:true — never
 * synthesized data.
 */
export const greenButtonRouter = router({
  /** Create and run an export job; returns the job in its terminal state. */
  requestExport: protectedProcedure
    .input(
      z.object({
        periodStart: z.coerce.date(),
        periodEnd: z.coerce.date(),
        format: z.enum(['csv', 'espi_xml']),
        scope: z.enum(['usage', 'billing', 'both']).default('both'),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await requestExport(ctx.user.id, {
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          format: input.format,
          scope: input.scope,
        });
      } catch (error) {
        throw toError(error);
      }
    }),

  /** List the user's export jobs (metadata, newest first). */
  listExports: protectedProcedure
    .input(z.object({ limit: z.number().int().positive().max(100).default(20) }))
    .query(async ({ ctx, input }) => {
      try {
        return { jobs: await listExports(ctx.user.id, input.limit) };
      } catch (error) {
        throw toError(error);
      }
    }),

  /** Get one job's status and counts (content excluded). */
  getExport: protectedProcedure
    .input(z.object({ jobId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      try {
        const { content: _content, ...job } = await getExport(ctx.user.id, input.jobId);
        return job;
      } catch (error) {
        throw toError(error);
      }
    }),

  /** Download a ready job: base64 content + SHA-256 checksum + filename. */
  downloadExport: protectedProcedure
    .input(z.object({ jobId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      try {
        return await downloadExport(ctx.user.id, input.jobId);
      } catch (error) {
        throw toError(error);
      }
    }),
});

export type GreenButtonRouter = typeof greenButtonRouter;
