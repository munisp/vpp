import { z } from 'zod';
import { router, protectedProcedure, publicProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import {
  getCarbonSummaryAndMint,
  listCertificates,
  verifyCertificate,
} from '../services/carbon-credits';

function toError(error: unknown, fallback: string): TRPCError {
  const message = error instanceof Error ? error.message : '';
  if (message === 'USER_NOT_FOUND') return new TRPCError({ code: 'NOT_FOUND', message: 'User not found.' });
  console.error('[CarbonCredits]', error);
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: fallback });
}

/**
 * Carbon credit tracking router.
 *
 * CO2 avoided is computed from real solar telemetry multiplied by the
 * DB-backed grid emission factor for the user's region (null, never a
 * hardcoded fallback, when no live factor exists). One certificate is
 * minted per 100 kWh of verified generation, with a deterministic SHA-256
 * id that anyone can verify via the public verifyCertificate endpoint.
 */
export const carbonCreditsRouter = router({
  // Real solar generation, CO2 avoided, and certificate tallies.
  // Also mints any certificates newly earned since the last call.
  getMyCarbonSummary: protectedProcedure
    .query(async ({ ctx }) => {
      try {
        return await getCarbonSummaryAndMint(ctx.user.id);
      } catch (error) {
        throw toError(error, 'Failed to compute carbon summary.');
      }
    }),

  // The caller's minted certificates.
  listMyCertificates: protectedProcedure
    .input(z.object({ limit: z.number().int().positive().max(100).default(50) }))
    .query(async ({ ctx, input }) => {
      try {
        return await listCertificates(ctx.user.id, input.limit);
      } catch (error) {
        throw toError(error, 'Failed to list certificates.');
      }
    }),

  // Public verification of a certificate by its deterministic hash.
  verifyCertificate: publicProcedure
    .input(z.object({ certificateHash: z.string().regex(/^[0-9a-fA-F]{64}$/, 'certificateHash must be a 64-char hex SHA-256') }))
    .query(async ({ input }) => {
      try {
        return await verifyCertificate(input.certificateHash);
      } catch (error) {
        throw toError(error, 'Failed to verify certificate.');
      }
    }),
});

export type CarbonCreditsRouter = typeof carbonCreditsRouter;
