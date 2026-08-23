import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { adminProcedure, router } from '../../_core/trpc';
import { modelHealth } from '../../services/ml/model-health';

/**
 * Model health, read by operators.
 *
 * The registry existed before any trainer did: rows could describe a `production`
 * model with no weights behind them, and the UI reported them as deployed. This
 * surface reports what is verifiable — the training data's origin, the run that
 * produced the weights, whether those weights still hash to what was evaluated,
 * and live accuracy measured only where actuals exist.
 */
export const modelHealthRouter = router({
  overview: adminProcedure
    .input(z.object({ limit: z.number().int().positive().max(200).default(50) }).optional())
    .query(async ({ input }) => {
      try {
        return await modelHealth(input?.limit ?? 50);
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'could not read model health',
        });
      }
    }),
});
