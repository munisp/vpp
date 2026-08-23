import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { adminProcedure, router } from '../../_core/trpc';
import { lakehouseStatus, recentRuns } from '../../services/lakehouse/status';

/**
 * The lakehouse, read by operators.
 *
 * The infrastructure audit found a lakehouse that existed as a client nothing
 * called: docs described analytics over Iceberg while no job ran and no dataset
 * was ever written. This surface exists so that stays visible — a dataset with no
 * runs reads as `never_run`, not as an empty result set.
 */
export const lakehouseRouter = router({
  status: adminProcedure.query(async () => {
    try {
      return await lakehouseStatus();
    } catch (error) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message:
          error instanceof Error ? error.message : 'could not read lakehouse ingestion state',
      });
    }
  }),

  runs: adminProcedure
    .input(z.object({ limit: z.number().int().positive().max(200).default(50) }).optional())
    .query(async ({ input }) => {
      try {
        return { runs: await recentRuns(input?.limit ?? 50) };
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'could not read lakehouse runs',
        });
      }
    }),
});
