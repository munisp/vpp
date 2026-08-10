import { z } from 'zod';
import { router, protectedProcedure, publicProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import {
  getMatchesForUser,
  getMyOpenOrders,
  getOrderBook,
  submitOrder,
} from '../services/p2p-matching';

const SubmitOrderSchema = z.object({
  side: z.enum(['buy', 'sell']),
  energyWh: z.number().int().positive(),
  priceCentsPerKwh: z.number().int().positive(), // maximum for buy, minimum for sell
});

function toError(error: unknown, fallback: string): TRPCError {
  const message = error instanceof Error ? error.message : '';
  if (message === 'ORDER_VALUE_TOO_SMALL') {
    return new TRPCError({ code: 'BAD_REQUEST', message: 'Order total value must be greater than zero; increase energy or price.' });
  }
  if (message.startsWith('MATCH_CONFLICT')) {
    return new TRPCError({ code: 'CONFLICT', message: 'The order book changed while matching; please retry.' });
  }
  console.error('[P2PMatching]', error);
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: fallback });
}

/**
 * P2P order-book matching engine router.
 *
 * Complements routers/p2p-trading.ts (manual offer/accept flow) with a real
 * price-time priority matcher: orders rest on the trades table as pending
 * p2p_buy/p2p_sell rows, fills (including partial fills) are recorded in
 * p2p_matches, and fully-filled orders flip to 'executed' atomically inside
 * one DB transaction.
 */
export const p2pMatchingRouter = router({
  // Create an order and immediately run the matcher against the book.
  submitOrder: protectedProcedure
    .input(SubmitOrderSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await submitOrder(ctx.user.id, input.side, input.energyWh, input.priceCentsPerKwh);
      } catch (error) {
        throw toError(error, 'Failed to submit order.');
      }
    }),

  // Aggregated market depth by price level (remaining unfilled energy).
  getOrderBook: publicProcedure
    .query(async () => {
      try {
        return await getOrderBook();
      } catch (error) {
        throw toError(error, 'Failed to load order book.');
      }
    }),

  // The caller's match executions (either leg).
  getMatches: protectedProcedure
    .input(z.object({ limit: z.number().int().positive().max(100).default(50) }))
    .query(async ({ ctx, input }) => {
      try {
        return await getMatchesForUser(ctx.user.id, input.limit);
      } catch (error) {
        throw toError(error, 'Failed to load matches.');
      }
    }),

  // The caller's resting orders with filled/remaining quantities.
  getMyOrders: protectedProcedure
    .query(async ({ ctx }) => {
      try {
        return await getMyOpenOrders(ctx.user.id);
      } catch (error) {
        throw toError(error, 'Failed to load open orders.');
      }
    }),
});

export type P2pMatchingRouter = typeof p2pMatchingRouter;
