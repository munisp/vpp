import { z } from 'zod';
import { router, protectedProcedure } from '../../_core/trpc';
import { TRPCError } from '@trpc/server';
import {
  cancelListing,
  createListing,
  listActiveListings,
  listMyListings,
  listMyTransfers,
  purchaseListing,
} from '../../services/innov3-offset-market';

function toError(error: unknown, fallback: string): TRPCError {
  const message = error instanceof Error ? error.message : '';
  if (message === 'CERTIFICATE_NOT_FOUND') return new TRPCError({ code: 'NOT_FOUND', message: 'Certificate not found.' });
  if (message === 'NOT_CERTIFICATE_OWNER') return new TRPCError({ code: 'FORBIDDEN', message: 'You can only list certificates you own.' });
  if (message === 'CERTIFICATE_NOT_SELLABLE') return new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This certificate is not in a sellable state (retired, or already transferred).' });
  if (message === 'CERTIFICATE_ALREADY_LISTED') return new TRPCError({ code: 'CONFLICT', message: 'This certificate already has an active listing.' });
  if (message === 'LISTING_NOT_ACTIVE') return new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Listing is not active (missing, sold, or cancelled).' });
  if (message === 'CANNOT_BUY_OWN_LISTING') return new TRPCError({ code: 'BAD_REQUEST', message: 'You cannot buy your own listing.' });
  if (message === 'INVALID_PRICE') return new TRPCError({ code: 'BAD_REQUEST', message: 'Asking price must be a positive whole number of minor currency units.' });
  if (message === 'UNSUPPORTED_CURRENCY') return new TRPCError({ code: 'BAD_REQUEST', message: 'Currency must be one of NGN, TZS, USD.' });
  console.error('[OffsetMarket]', error);
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: fallback });
}

/**
 * Carbon offset marketplace.
 *
 * Only real, VERIFIED carbon_certificates rows in a sellable state
 * (status 'minted', still the seller's, never previously transferred) can
 * be listed, and the purchase enforces that state with a conditional update
 * inside one transaction. The price is the seller's own declared ask. No
 * money moves here — the transfer row is the receipt of the ownership
 * change only.
 */
export const offsetMarketRouter = router({
  createListing: protectedProcedure
    .input(z.object({
      certificateId: z.number().int().positive(),
      askingPriceCents: z.number().int().positive(),
      currency: z.enum(['NGN', 'TZS', 'USD']),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await createListing(ctx.user.id, input);
      } catch (error) {
        throw toError(error, 'Failed to create listing.');
      }
    }),

  cancelListing: protectedProcedure
    .input(z.object({ listingId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await cancelListing(ctx.user.id, input.listingId);
      } catch (error) {
        throw toError(error, 'Failed to cancel listing.');
      }
    }),

  purchase: protectedProcedure
    .input(z.object({ listingId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await purchaseListing(ctx.user.id, input.listingId);
      } catch (error) {
        throw toError(error, 'Failed to purchase listing.');
      }
    }),

  // Open marketplace: active listings with the underlying certificate facts.
  browse: protectedProcedure
    .input(z.object({ limit: z.number().int().positive().max(100).default(50) }))
    .query(async ({ input }) => {
      try {
        return await listActiveListings(input);
      } catch (error) {
        throw toError(error, 'Failed to list marketplace.');
      }
    }),

  myListings: protectedProcedure
    .input(z.object({ limit: z.number().int().positive().max(100).default(50) }))
    .query(async ({ ctx, input }) => {
      try {
        return await listMyListings(ctx.user.id, input);
      } catch (error) {
        throw toError(error, 'Failed to list your listings.');
      }
    }),

  // Transfers where the caller was buyer or seller.
  myTransfers: protectedProcedure
    .input(z.object({ limit: z.number().int().positive().max(100).default(50) }))
    .query(async ({ ctx, input }) => {
      try {
        return await listMyTransfers(ctx.user.id, input);
      } catch (error) {
        throw toError(error, 'Failed to list your transfers.');
      }
    }),
});

export type OffsetMarketRouter = typeof offsetMarketRouter;
