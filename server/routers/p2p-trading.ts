import { z } from 'zod';
import { router, publicProcedure, protectedProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import { getDb } from '../db';
import { trades, users } from '../../drizzle/schema';
import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';

/**
 * Peer-to-peer energy trading router.
 *
 * Offers live on the real `trades` table: sellers publish `p2p_sell` rows with
 * status 'pending'; accepting an offer atomically matches it to one buyer and
 * records the buyer's counter `p2p_buy` trade.
 *
 * A match is NOT a settlement. 'executed' is consumed by revenue analytics and
 * by the seller's earnings calculation, so a trade only reaches 'executed' once
 * the buyer's payment has cleared and the energy transfer is confirmed. Until
 * then both sides stay 'pending' with `metadata.settlement = 'awaiting_payment'`
 * and the offer is withdrawn from the marketplace by its `counterpartyId`.
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
        // Already matched offers are no longer available, even though the
        // trade stays pending until settlement.
        isNull(trades.counterpartyId),
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
        if (offer.status !== 'pending' || offer.counterpartyId !== null) {
          throw new TRPCError({ code: 'CONFLICT', message: 'This offer has already been taken or cancelled.' });
        }

        // Conditional update on both status and counterparty: only one buyer
        // can win the offer, and the offer is not settled here.
        const updateResult = await tx
          .update(trades)
          .set({
            counterpartyId: ctx.user.id,
            metadata: JSON.stringify({
              ...(offer.metadata ? JSON.parse(offer.metadata) : {}),
              settlement: 'awaiting_payment',
              matchedAt: new Date().toISOString(),
            }),
          })
          .where(
            and(
              eq(trades.id, input.offerId),
              eq(trades.status, 'pending'),
              isNull(trades.counterpartyId)
            )
          );

        if (affectedRows(updateResult) === 0) {
          throw new TRPCError({ code: 'CONFLICT', message: 'This offer has already been taken.' });
        }

        // Record the buyer's counter trade, also awaiting settlement.
        const buyInsert = await tx.insert(trades).values({
          userId: ctx.user.id,
          tradeType: 'p2p_buy',
          tradingMode: 'p2p',
          energy: offer.energy,
          price: offer.price,
          totalAmount: offer.totalAmount,
          timestamp: new Date(),
          status: 'pending',
          counterpartyId: offer.userId,
          metadata: JSON.stringify({
            settlement: 'awaiting_payment',
            sellOfferId: offer.id,
            matchedAt: new Date().toISOString(),
          }),
        });

        return {
          success: true,
          offerId: offer.id,
          buyTradeId: Number((buyInsert as any)[0]?.insertId ?? (buyInsert as any).insertId),
          settlement: 'awaiting_payment' as const,
          amountDueCents: offer.totalAmount,
          message:
            'Offer matched. The trade settles once your payment clears and the energy transfer is confirmed.',
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
            eq(trades.status, 'pending'),
            // A matched offer has a buyer waiting on it; it cannot be pulled
            // unilaterally by the seller.
            isNull(trades.counterpartyId)
          )
        );

      if (affectedRows(result) === 0) {
        const [offer] = await db
          .select({
            id: trades.id,
            userId: trades.userId,
            status: trades.status,
            counterpartyId: trades.counterpartyId,
          })
          .from(trades)
          .where(eq(trades.id, input.offerId))
          .limit(1);

        if (!offer || offer.userId !== ctx.user.id) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'P2P offer not found.' });
        }
        if (offer.counterpartyId !== null) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Offer has been matched with a buyer and can no longer be cancelled.',
          });
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
