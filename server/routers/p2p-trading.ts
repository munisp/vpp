import { z } from 'zod';
import { router, protectedProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import { getDb } from '../db';
import { assets, trades, users } from '../../drizzle/schema';
import { p2pSettlements } from '../../drizzle/innovations-schema';
import { and, desc, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { P2pSettlementError, startTradePayment } from '../services/p2p-settlement';
import {
  ParticipantError,
  counterpartyFacts,
  loadTradingParticipant,
} from '../services/p2p-participants';

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

function affectedRows(result: { rowCount: number | null }): number {
  return result.rowCount ?? 0;
}

/**
 * Load the caller as a market participant, refusing an unverified business
 * before it can hold a position.
 */
async function toParticipant(userId: number) {
  try {
    return await loadTradingParticipant(userId);
  } catch (error) {
    if (error instanceof ParticipantError) {
      throw new TRPCError({
        code: error.code === 'BUSINESS_NOT_VERIFIED' ? 'FORBIDDEN' : 'NOT_FOUND',
        message: error.message,
      });
    }
    throw error;
  }
}

const CreateOfferSchema = z.object({
  energy: z.number().int().positive(), // watt-hours
  price: z.number().int().positive(), // cents per kWh
});

export const p2pTradingRouter = router({
  // Open sell offers on the marketplace (excludes the caller's own offers).
  // Authenticated: the listing carries seller identity, which is not public.
  getOffers: protectedProcedure
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
      conditions.push(ne(trades.userId, ctx.user.id));

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
          // A buyer is entitled to know whether the counterparty is a household
          // or a business trading under a registered name.
          sellerParticipantType: users.participantType,
          sellerBusinessLegalName: users.businessLegalName,
          sellerBusinessRegistrationNumber: users.businessRegistrationNumber,
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

      // An offer is a promise to deliver energy from equipment. A seller with
      // no active asset cannot deliver anything, so the offer is refused here
      // rather than discovered at dispatch time by the buyer who paid for it.
      const sellerAssets = await db
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.userId, ctx.user.id), eq(assets.status, 'active')))
        .limit(1);

      if (sellerAssets.length === 0) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'You have no active asset that could deliver this energy, so the offer cannot be published.',
        });
      }

      const totalAmount = Math.floor((input.energy * input.price) / 1000);
      if (totalAmount <= 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Offer total amount must be greater than zero; increase energy or price.',
        });
      }

      const seller = await toParticipant(ctx.user.id);

      const insertResult = await db.insert(trades).values({
        userId: ctx.user.id,
        tradeType: 'p2p_sell',
        tradingMode: 'p2p',
        energy: input.energy,
        price: input.price,
        totalAmount,
        timestamp: new Date(),
        status: 'pending',
        metadata: JSON.stringify({ sellerParticipantType: seller.participantType }),
      }).returning({ id: trades.id });

      return {
        success: true,
        offerId: Number(insertResult[0].id),
        sellerParticipantType: seller.participantType,
        message: 'P2P sell offer created.',
      };
    }),

  // Accept an open offer: atomically marks it executed and records the buy side
  acceptOffer: protectedProcedure
    .input(z.object({ offerId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database not available' });

      const buyer = await toParticipant(ctx.user.id);

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

        const seller = await toParticipant(offer.userId);
        const parties = counterpartyFacts(seller, buyer);

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
              ...parties,
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
            ...parties,
          }),
        }).returning({ id: trades.id });

        return {
          success: true,
          offerId: offer.id,
          buyTradeId: Number(buyInsert[0].id),
          settlement: 'awaiting_payment' as const,
          relation: parties.relation,
          amountDueCents: offer.totalAmount,
          message:
            'Offer matched. The trade settles once your payment clears and the energy transfer is confirmed.',
        };
      });
    }),

  // Pay for a matched purchase. The provider is asked for the money; the
  // trade settles only when the provider's callback confirms it.
  payForMatch: protectedProcedure
    .input(
      z.object({
        buyTradeId: z.number().int().positive(),
        gateway: z.enum(['mpesa', 'airtel_money', 'tigo_pesa']),
        phoneNumber: z.string().min(10, 'Invalid phone number'),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await startTradePayment({
          buyTradeId: input.buyTradeId,
          buyerId: ctx.user.id,
          gateway: input.gateway,
          phoneNumber: input.phoneNumber,
        });
      } catch (error) {
        if (error instanceof P2pSettlementError) {
          const code =
            error.code === 'TRADE_NOT_FOUND'
              ? 'NOT_FOUND'
              : error.code === 'NOT_BUYER'
                ? 'FORBIDDEN'
                : error.code === 'DATABASE_UNAVAILABLE'
                  ? 'SERVICE_UNAVAILABLE'
                  : error.code === 'ALREADY_PAID'
                    ? 'CONFLICT'
                    : 'BAD_REQUEST';
          throw new TRPCError({ code, message: error.message });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'The payment request could not be sent to the provider.',
        });
      }
    }),

  // What the platform can actually prove about the caller's own trades. Only a
  // party to a settlement may read it, and every leg is reported as its own
  // evidence rather than rolled into a single "settled" flag.
  mySettlements: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) {
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'Database not available' });
    }

    const rows = await db
      .select()
      .from(p2pSettlements)
      .where(
        or(eq(p2pSettlements.buyerId, ctx.user.id), eq(p2pSettlements.sellerId, ctx.user.id))
      )
      .orderBy(desc(p2pSettlements.createdAt))
      .limit(50);

    return rows.map(row => ({
      settlementId: row.id,
      buyTradeId: row.buyTradeId,
      side: row.buyerId === ctx.user.id ? ('buyer' as const) : ('seller' as const),
      energyWh: row.energyWh,
      amountCents: row.amountCents,
      currency: row.currency,
      state: row.state,
      buyerPaid: row.buyerPaidAt !== null,
      buyerPaidAt: row.buyerPaidAt,
      // The provider's reference, not our row id: it is what a dispute is
      // resolved against.
      buyerPaymentReference: row.buyerPaymentReference,
      delivery: row.delivery,
      deliveredEnergyWh: row.deliveredEnergyWh,
      deliverySamples: row.deliverySamples,
      deliveryNote: row.deliveryNote,
      sellerPayout: row.sellerPayout,
      sellerPayoutReference: row.sellerPayoutReference,
      reconciliation: row.reconciliation,
      reconciliationNote: row.reconciliationNote,
      updatedAt: row.updatedAt,
    }));
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
