import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { adminProcedure, protectedProcedure, router } from '../../_core/trpc';
import {
  applyMeteredConsumption,
  checkTokenAgainstDevice,
  issueTokenForPayment,
  listPrepaidAccounts,
  listPrepaidConsumption,
  listPrepaidTokens,
  listSupplyEvents,
  openPrepaidAccount,
  prepaidAccountView,
  PrepaidError,
  PrepaidUnavailableError,
  recordSupplyDecision,
  recordTokenRedemption,
} from '../../services/prepaid-energy';
import { vendingConfigured } from '../../services/prepaid-openpaygo';

/**
 * Prepaid / pay-as-you-go energy, read and operated.
 *
 * Ownership is enforced on the server for every procedure a customer can call:
 * an account id is not a capability, so each read re-checks that the caller owns
 * the account and refuses with `FORBIDDEN` otherwise. Admins see every account.
 *
 * Every response distinguishes four things a plain balance would blur together:
 * energy bought, energy measured as taken, energy remaining, and energy remaining
 * being *unknown* because no meter reports on that account.
 */

const accountIdInput = z.object({ accountId: z.number().int().positive() });

function refusalStatus(error: unknown): never {
  if (error instanceof PrepaidUnavailableError) {
    throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: error.message, cause: error });
  }
  if (error instanceof PrepaidError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message, cause: error });
  }
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: error instanceof Error ? error.message : 'prepaid operation failed',
  });
}

async function assertCallerOwnsAccount(accountId: number, userId: number, isAdmin: boolean): Promise<void> {
  const accounts = await listPrepaidAccounts(isAdmin ? {} : { userId });
  if (!accounts.some((account) => account.id === accountId)) {
    // Deliberately the same answer whether the account belongs to somebody else
    // or does not exist: an id probe should learn nothing either way.
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'That prepaid account is not yours.',
    });
  }
}

export const prepaidRouter = router({
  /** Whether this deployment can vend tokens at all, and what that means. */
  vendingStatus: protectedProcedure.query(() => ({
    configured: vendingConfigured(),
    scheme: 'openpaygo' as const,
    detail: vendingConfigured()
      ? 'An OpenPAYGO keyring is configured; a confirmed payment can be vended as a token.'
      : 'No OpenPAYGO keyring is configured (PREPAID_OPENPAYGO_KEYS / PREPAID_OPENPAYGO_KEYRING_FILE are unset). Payments are still recorded and the energy is owed, but no token can be produced here.',
  })),

  /** The caller's own prepaid accounts. */
  myAccounts: protectedProcedure.query(async ({ ctx }) => {
    const accounts = await listPrepaidAccounts({ userId: ctx.user.id });
    return { accounts };
  }),

  /** One account with its balance, latest vend, consumption and supply state. */
  account: protectedProcedure.input(accountIdInput).query(async ({ ctx, input }) => {
    await assertCallerOwnsAccount(input.accountId, ctx.user.id, ctx.user.role === 'admin');
    try {
      return await prepaidAccountView(input.accountId);
    } catch (error) {
      refusalStatus(error);
    }
  }),

  tokens: protectedProcedure
    .input(accountIdInput.extend({ limit: z.number().int().positive().max(200).default(50) }))
    .query(async ({ ctx, input }) => {
      await assertCallerOwnsAccount(input.accountId, ctx.user.id, ctx.user.role === 'admin');
      return { tokens: await listPrepaidTokens({ accountId: input.accountId, limit: input.limit }) };
    }),

  consumption: protectedProcedure
    .input(accountIdInput.extend({ limit: z.number().int().positive().max(500).default(100) }))
    .query(async ({ ctx, input }) => {
      await assertCallerOwnsAccount(input.accountId, ctx.user.id, ctx.user.role === 'admin');
      return { periods: await listPrepaidConsumption(input.accountId, input.limit) };
    }),

  supplyEvents: protectedProcedure
    .input(accountIdInput.extend({ limit: z.number().int().positive().max(200).default(50) }))
    .query(async ({ ctx, input }) => {
      await assertCallerOwnsAccount(input.accountId, ctx.user.id, ctx.user.role === 'admin');
      return { events: await listSupplyEvents(input.accountId, input.limit) };
    }),

  /**
   * Bring the caller's own account up to date from its meter.
   *
   * Refuses with `SERVICE_UNAVAILABLE` on an account with no meter integration,
   * rather than returning a zero-consumption result that would read as "you have
   * used nothing".
   */
  refreshConsumption: protectedProcedure.input(accountIdInput).mutation(async ({ ctx, input }) => {
    await assertCallerOwnsAccount(input.accountId, ctx.user.id, ctx.user.role === 'admin');
    try {
      return await applyMeteredConsumption({ accountId: input.accountId });
    } catch (error) {
      refusalStatus(error);
    }
  }),

  /**
   * Check a code the way the customer's meter would, without crediting anything.
   *
   * This is how a support agent answers "my token was rejected": the answer comes
   * from the standard's own decoder and the counts already accepted on that
   * device, not from our record of what we sent.
   */
  checkToken: protectedProcedure
    .input(accountIdInput.extend({ tokenCode: z.string().min(4).max(64) }))
    .query(async ({ ctx, input }) => {
      await assertCallerOwnsAccount(input.accountId, ctx.user.id, ctx.user.role === 'admin');
      try {
        return await checkTokenAgainstDevice(input);
      } catch (error) {
        refusalStatus(error);
      }
    }),

  // ---- operator surfaces ----

  allAccounts: adminProcedure
    .input(
      z
        .object({
          userId: z.number().int().positive().optional(),
          status: z.enum(['active', 'suspended', 'disconnected', 'closed']).optional(),
        })
        .optional()
    )
    .query(async ({ input }) => ({
      accounts: await listPrepaidAccounts({ userId: input?.userId, status: input?.status }),
      vendingConfigured: vendingConfigured(),
    })),

  openAccount: adminProcedure
    .input(
      z.object({
        userId: z.number().int().positive(),
        meterSerial: z.string().min(1).max(64),
        deviceProfile: z.string().min(1).max(160),
        keyRef: z.string().min(1).max(160),
        startingCode: z.number().int().min(0),
        tariffMinorPerKwh: z.number().int().positive(),
        currency: z.enum(['NGN', 'TZS', 'USD']),
        whPerValueUnit: z.number().int().positive().max(100_000).optional(),
        meterAssetId: z.number().int().positive().nullable().optional(),
        notes: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await openPrepaidAccount(input, ctx.user.id);
      } catch (error) {
        refusalStatus(error);
      }
    }),

  /**
   * Vend the token a confirmed payment bought.
   *
   * Idempotent: called twice for one payment, the second call returns the token
   * the first one vended (`replay: true`) rather than a second token.
   */
  issueForPayment: adminProcedure
    .input(
      z.object({
        paymentId: z.number().int().positive(),
        accountId: z.number().int().positive().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await issueTokenForPayment({ ...input, issuedBy: ctx.user.id });
      } catch (error) {
        refusalStatus(error);
      }
    }),

  /** Record that a meter accepted a token. Single use, and evidence is required. */
  recordRedemption: adminProcedure
    .input(
      z.object({
        accountId: z.number().int().positive(),
        tokenCode: z.string().min(4).max(64),
        evidenceRef: z.string().min(1).max(200),
      })
    )
    .mutation(async ({ input }) => {
      try {
        return await recordTokenRedemption(input);
      } catch (error) {
        refusalStatus(error);
      }
    }),

  recordSupplyDecision: adminProcedure
    .input(
      z.object({
        accountId: z.number().int().positive(),
        action: z.enum(['disconnect', 'reconnect']),
        reason: z.enum(['credit_exhausted', 'operator_request', 'customer_request', 'fault', 'credit_restored']),
        evidenceRef: z.string().max(200).optional(),
        enforcedAtMeter: z.boolean().optional(),
        detail: z.string().max(300).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await recordSupplyDecision({ ...input, actorUserId: ctx.user.id });
      } catch (error) {
        refusalStatus(error);
      }
    }),

  /** Every vend on the fleet, for investigating an issuance or a dispute. */
  allTokens: adminProcedure
    .input(
      z
        .object({
          accountId: z.number().int().positive().optional(),
          userId: z.number().int().positive().optional(),
          limit: z.number().int().positive().max(500).default(100),
        })
        .optional()
    )
    .query(async ({ input }) => ({
      tokens: await listPrepaidTokens({
        accountId: input?.accountId,
        userId: input?.userId,
        limit: input?.limit ?? 100,
      }),
    })),
});
