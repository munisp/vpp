import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { adminProcedure, router } from '../../_core/trpc';
import { collectEvidence } from '../../services/diagnostics/evidence';
import { diagnose, recentDiagnoses } from '../../services/diagnostics/diagnose';
import { loadOllamaConfig, ollamaHealth } from '../../services/diagnostics/ollama';

/**
 * Operator diagnosis with a local model.
 *
 * Admin-only: the evidence includes payment and ledger counts, and a diagnosis
 * names the jobs and tables to inspect. `evidence` is exposed on its own so an
 * operator can read the measurements without a model in the loop at all — that is
 * the fallback here, rather than generated text.
 */
export const diagnosticsRouter = router({
  /** Is a local model actually available? Reported as measurements, not a boolean. */
  health: adminProcedure.query(async () => {
    return ollamaHealth(loadOllamaConfig());
  }),

  evidence: adminProcedure.query(async () => {
    try {
      return await collectEvidence();
    } catch (error) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: error instanceof Error ? error.message : 'could not collect diagnostic evidence',
      });
    }
  }),

  diagnose: adminProcedure
    .input(z.object({ question: z.string().trim().min(8).max(2000) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await diagnose({ question: input.question, requestedBy: ctx.user.id });
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'diagnosis could not be run',
        });
      }
    }),

  runs: adminProcedure
    .input(z.object({ limit: z.number().int().positive().max(100).default(20) }).optional())
    .query(async ({ input }) => {
      try {
        return { runs: await recentDiagnoses(input?.limit ?? 20) };
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'could not read past diagnoses',
        });
      }
    }),
});
