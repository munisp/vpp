import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { adminProcedure, router } from '../../_core/trpc';
import { ledgerConfigured } from '../../services/ledger/tigerbeetle';
import { listUnpostedPostings, sweepPendingPostings } from '../../services/ledger/postings';
import { reconcileMemberBalances } from '../../services/ledger/reconcile';

/**
 * The double-entry ledger, read by operators.
 *
 * Every response says whether a ledger exists at all: with none configured the
 * platform has no balance to report, and this reads `unavailable` rather than
 * showing a fleet that owes nothing. Reconciliation is reported, never repaired —
 * a mismatch between the ledger and the platform's own records is a finding for a
 * human, and silently moving either side to agree would destroy the evidence.
 */
export const ledgerRouter = router({
  status: adminProcedure.query(() => ({
    configured: ledgerConfigured(),
    detail: ledgerConfigured()
      ? 'A double-entry ledger is configured; balances below come from it.'
      : 'No double-entry ledger is configured (TIGERBEETLE_ADDRESSES is unset). Money movements are recorded but no balance can be asserted.',
  })),

  /** Entries the ledger has not confirmed: pending retries, refusals, and movements with no ledger. */
  unposted: adminProcedure
    .input(z.object({ limit: z.number().int().positive().max(200).default(50) }).optional())
    .query(async ({ input }) => {
      try {
        return { postings: await listUnpostedPostings(input?.limit ?? 50) };
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'could not read ledger postings',
        });
      }
    }),

  reconciliation: adminProcedure
    .input(z.object({ userIds: z.array(z.number().int().positive()).max(200).optional() }).optional())
    .query(async ({ input }) => {
      try {
        return await reconcileMemberBalances(input?.userIds);
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'could not reconcile balances',
        });
      }
    }),

  /**
   * Retry entries the ledger never confirmed. Safe to call repeatedly: transfer ids
   * are derived from the business fact, so a transfer the ledger already applied
   * comes back as `exists` instead of moving money a second time.
   */
  sweepUnconfirmed: adminProcedure
    .input(
      z
        .object({
          olderThanMs: z.number().int().min(0).max(86_400_000).optional(),
          limit: z.number().int().positive().max(500).optional(),
        })
        .optional()
    )
    .mutation(async ({ input }) => {
      if (!ledgerConfigured()) {
        throw new TRPCError({
          code: 'SERVICE_UNAVAILABLE',
          message: 'No double-entry ledger is configured, so there is nothing to post these entries to.',
        });
      }
      try {
        // An operator asking for a retry means every unconfirmed entry, including
        // the one that failed a second ago: the age floor exists to keep an
        // automated sweep off entries still being written, not to hide rows the
        // operator is looking at.
        return await sweepPendingPostings({ olderThanMs: input?.olderThanMs ?? 0, limit: input?.limit });
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'ledger sweep failed',
        });
      }
    }),
});
