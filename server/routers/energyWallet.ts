import { z } from 'zod';
import { router, protectedProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import { energyWallet } from '../services/energy-wallet';

const TopUpMethodSchema = z.enum(['mpesa', 'airtel_money', 'tigo_pesa']);

/**
 * Energy wallet router. Balances are derived from the real payments/billings
 * ledger on every read (with an audit snapshot persisted per computation).
 * Top-ups go through the real payment gateways; *_NOT_CONFIGURED errors are
 * propagated to the caller.
 */
export const energyWalletRouter = router({
  /**
   * Wallet view: freshly derived balance, ledger breakdown, settings.
   */
  getWallet: protectedProcedure.query(async ({ ctx }) => {
    try {
      return await energyWallet.getWallet(ctx.user.id);
    } catch (error: any) {
      console.error('[EnergyWallet] getWallet error:', error);
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message || 'Failed to load wallet' });
    }
  }),

  /**
   * Update wallet settings (threshold, auto top-up, method, phone).
   */
  updateWalletSettings: protectedProcedure
    .input(z.object({
      lowBalanceThresholdCents: z.number().int().nonnegative().nullable().optional(),
      autoTopUp: z.boolean().optional(),
      topUpAmountCents: z.number().int().positive().nullable().optional(),
      preferredMethod: TopUpMethodSchema.nullable().optional(),
      phoneNumber: z.string().min(9).max(20).nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        const settings = await energyWallet.updateSettings(ctx.user.id, input);
        return { success: true, settings };
      } catch (error: any) {
        console.error('[EnergyWallet] updateWalletSettings error:', error);
        throw new TRPCError({ code: 'BAD_REQUEST', message: error.message || 'Failed to update wallet settings' });
      }
    }),

  /**
   * Evaluate the auto top-up rule against the current derived balance.
   * Initiates a real gateway top-up when balance < threshold and autoTopUp
   * is enabled. Gateway configuration errors are propagated.
   */
  checkAutoTopUp: protectedProcedure.mutation(async ({ ctx }) => {
    try {
      return await energyWallet.maybeAutoTopUp(ctx.user.id);
    } catch (error: any) {
      console.error('[EnergyWallet] checkAutoTopUp error:', error);
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message || 'Auto top-up check failed' });
    }
  }),

  /**
   * Manually initiate a top-up via a chosen gateway.
   */
  requestTopUp: protectedProcedure
    .input(z.object({
      amountCents: z.number().int().positive(),
      method: TopUpMethodSchema,
      phoneNumber: z.string().min(9).max(20),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await energyWallet.initiateTopUp(ctx.user.id, input.amountCents, input.method, input.phoneNumber, 'manual');
      } catch (error: any) {
        console.error('[EnergyWallet] requestTopUp error:', error);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message || 'Top-up initiation failed' });
      }
    }),

  /**
   * Reconcile the caller's initiated top-ups against the gateway status APIs.
   * Moves attempts to completed/failed based only on gateway-confirmed status.
   */
  reconcileWallet: protectedProcedure.mutation(async ({ ctx }) => {
    try {
      return await energyWallet.reconcileTopUps(ctx.user.id);
    } catch (error: any) {
      console.error('[EnergyWallet] reconcileWallet error:', error);
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message || 'Reconciliation failed' });
    }
  }),

  /**
   * List the caller's top-up attempts.
   */
  listTopUpAttempts: protectedProcedure
    .input(z.object({ limit: z.number().int().positive().max(100).default(20) }))
    .query(async ({ ctx, input }) => {
      try {
        const attempts = await energyWallet.listTopUpAttempts(ctx.user.id, input.limit);
        return { attempts, count: attempts.length };
      } catch (error: any) {
        console.error('[EnergyWallet] listTopUpAttempts error:', error);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to retrieve top-up attempts' });
      }
    }),
});
