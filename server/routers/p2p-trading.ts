import { z } from 'zod';
import { router, publicProcedure, protectedProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import { getDb } from '../db';
import { trades, users } from '../../drizzle/schema';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';

/**
 * Peer-to-peer energy trading router.
 *
 * Offers live on the real `trades` table: sellers publish `p2p_sell` rows
 * with status 'pending'; accepting an offer atomically transitions it to
 * 'executed' and records the buyer's counter `p2p_buy` trade. The trades
 * status enum has no 'accepted' value, so 'executed' is the real matched
 * state.
 */

function affectedRows(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  return (header as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
}

const CreateOfferSchema = z.object({
  energy: z.number().int().positive(), // watt-hours
  price: z.number().int().positive(), // cents per kWh
});

export const p2pTradingRouter = router({
  // Open sell offers on the marketplace (excludes the caller's own offers)
  getOffers: publicProcedure
    .input(z.object({ limit: z.number().int().positive().max(100).default(50) }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database not available' });

      const conditions = [
        eq(trades.tradeType, 'p2p_sell'),
        eq(trades.status, 'pending'),
      ];
      if (ctx.user) {
        conditions.push(ne(trades.userId, ctx.user.id));
      }

      const offers = await db
        .select({
          id: trades.id,
          userId: trades.userId,
          energy: trades.energy,
          price: trades.price,
          totalAmount: trades.totalAmount,
          timestamp: trades.timestamp,
          createdAt: trades.createdAt,
          sellerName: users.name,
        })
        .from(trades)
        .leftJoin(users, eq(trades.userId, users.id))
        .where(and(...conditions))
        .orderBy(desc(trades.createdAt))
        .limit(input?.limit ?? 50);

      return offers;
    }),

  // The caller's own P2P trades (both offers and purchases)
  getMyOffers: protectedProcedure
    .query(async ({ ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database not available' });

      return db
        .select()
        .from(trades)
        .where(
          and(
            eq(trades.userId, ctx.user.id),
            inArray(trades.tradeType, ['p2p_sell', 'p2p_buy'])
          )
        )
        .orderBy(desc(trades.createdAt));
    }),

  // Publish a new sell offer
  createOffer: protectedProcedure
    .input(CreateOfferSchema)
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database not available' });

      const totalAmount = Math.floor((input.energy * input.price) / 1000);
      if (totalAmount <= 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Offer total amount must be greater than zero; increase energy or price.',
        });
      }

      const insertResult = await db.insert(trades).values({
        userId: ctx.user.id,
        tradeType: 'p2p_sell',
        tradingMode: 'p2p',
        energy: input.energy,
        price: input.price,
        totalAmount,
        timestamp: new Date(),
        status: 'pending',
      });

      return {
        success: true,
        offerId: Number((insertResult as any)[0]?.insertId ?? (insertResult as any).insertId),
        message: 'P2P sell offer created.',
      };
    }),

  // Accept an open offer: atomically marks it executed and records the buy side
  acceptOffer: protectedProcedure
    .input(z.object({ offerId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database not available' });

      return db.transaction(async (tx) => {
        const [offer] = await tx
          .select()
          .from(trades)
          .where(eq(trades.id, input.offerId))
          .limit(1);

        if (!offer || offer.tradeType !== 'p2p_sell') {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'P2P offer not found.' });
        }
        if (offer.userId === ctx.user.id) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'You cannot accept your own offer.' });
        }
        if (offer.status !== 'pending') {
          throw new TRPCError({ code: 'CONFLICT', message: 'This offer has already been taken or cancelled.' });
        }

        // Status-conditional update: only one buyer can win the offer.
        const updateResult = await tx
          .update(trades)
          .set({ status: 'executed', counterpartyId: ctx.user.id })
          .where(and(eq(trades.id, input.offerId), eq(trades.status, 'pending')));

        if (affectedRows(updateResult) === 0) {
          throw new TRPCError({ code: 'CONFLICT', message: 'This offer has already been taken.' });
        }

        // Record the buyer's counter trade.
        const buyInsert = await tx.insert(trades).values({
          userId: ctx.user.id,
          tradeType: 'p2p_buy',
          tradingMode: 'p2p',
          energy: offer.energy,
          price: offer.price,
          totalAmount: offer.totalAmount,
          timestamp: new Date(),
          status: 'executed',
          counterpartyId: offer.userId,
        });

        return {
          success: true,
          offerId: offer.id,
          buyTradeId: Number((buyInsert as any)[0]?.insertId ?? (buyInsert as any).insertId),
          message: 'Offer accepted and trade executed.',
        };
      });
    }),

  // Cancel an open offer (owner only, while still pending)
  cancelOffer: protectedProcedure
    .input(z.object({ offerId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database not available' });

      const result = await db
        .update(trades)
        .set({ status: 'cancelled' })
        .where(
          and(
            eq(trades.id, input.offerId),
            eq(trades.userId, ctx.user.id),
            eq(trades.tradeType, 'p2p_sell'),
            eq(trades.status, 'pending')
          )
        );

      if (affectedRows(result) === 0) {
        const [offer] = await db
          .select({ id: trades.id, userId: trades.userId, status: trades.status })
          .from(trades)
          .where(eq(trades.id, input.offerId))
          .limit(1);

        if (!offer || offer.userId !== ctx.user.id) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'P2P offer not found.' });
        }
        throw new TRPCError({
          code: 'CONFLICT',
          message: `Offer cannot be cancelled while in status '${offer.status}'.`,
        });
      }

      return { success: true, message: 'Offer cancelled.' };
    }),
});

export type P2pTradingRouter = typeof p2pTradingRouter;
