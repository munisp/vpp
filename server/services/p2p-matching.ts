/**
 * P2P Order-Book Matching Engine
 *
 * Real price-time priority matcher over the existing `trades` table:
 * pending `p2p_sell` / `p2p_buy` rows are the order book. A new order is
 * matched inside a single DB transaction against the best opposing offers:
 *  - incoming sell matches the HIGHEST bid >= the seller's minimum price
 *  - incoming buy  matches the LOWEST ask <= the buyer's maximum price
 * Ties break by earliest createdAt (time priority). Execution price is the
 * maker's (resting order's) price. Partial fills are supported: filled
 * quantities are tracked in `p2p_matches`.
 *
 * A fill is not a settlement. `trades.status = 'executed'` is read as revenue by
 * analytics and as earnings by the seller, so a fill never sets it: a fully
 * filled order keeps status 'pending', carries its counterparty, and records
 * `settlement: 'awaiting_payment'` until the buyer's payment is confirmed by the
 * provider (server/services/p2p-settlement.ts).
 */

import { and, asc, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getDb } from '../db';
import { trades } from '../../drizzle/schema';
import { p2pMatches } from '../../drizzle/innovations-schema';
import type { ParticipantType } from './p2p-participants';

function affectedRows(result: { rowCount: number | null }): number {
  return result.rowCount ?? 0;
}

function insertedId(returned: { id: number }[]): number | null {
  const id = Number(returned[0]?.id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function withSettlement(existing: string | null, patch: Record<string, unknown>): string {
  let base: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      if (parsed && typeof parsed === 'object') base = parsed as Record<string, unknown>;
    } catch {
      base = {};
    }
  }
  return JSON.stringify({ ...base, ...patch });
}

export type OrderSide = 'buy' | 'sell';

export interface MatchExecution {
  matchId: number | null;
  buyOrderId: number;
  sellOrderId: number;
  buyerId: number;
  sellerId: number;
  energyWh: number;
  priceCentsPerKwh: number;
  totalAmountCents: number;
}

export interface SubmitOrderResult {
  orderId: number;
  side: OrderSide;
  /**
   * 'open' still has unfilled energy; 'filled' is fully matched but unpaid and
   * therefore still a pending trade row.
   */
  status: 'open' | 'filled';
  settlement: 'awaiting_payment' | 'unmatched';
  requestedEnergyWh: number;
  filledEnergyWh: number;
  remainingEnergyWh: number;
  matches: MatchExecution[];
}

type MatchingTx = Parameters<
  Parameters<NodePgDatabase<Record<string, unknown>>['transaction']>[0]
>[0];

async function filledEnergyWh(tx: MatchingTx, orderId: number, side: OrderSide): Promise<number> {
  const col = side === 'buy' ? p2pMatches.buyOrderId : p2pMatches.sellOrderId;
  const rows = await tx
    .select({ filled: sql<number>`COALESCE(SUM(${p2pMatches.energyWh}), 0)` })
    .from(p2pMatches)
    .where(eq(col, orderId));
  return Number(rows[0]?.filled ?? 0);
}

/**
 * Submit an order and run the matcher atomically. The order row and all of
 * its fills commit or roll back together.
 */
export async function submitOrder(
  userId: number,
  side: OrderSide,
  energyWh: number,
  priceCentsPerKwh: number,
  participantType: ParticipantType
): Promise<SubmitOrderResult> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const totalAmount = Math.floor((energyWh * priceCentsPerKwh) / 1000);
  if (totalAmount <= 0) {
    throw new Error('ORDER_VALUE_TOO_SMALL');
  }

  const ownMetadata = JSON.stringify(
    side === 'sell'
      ? { sellerParticipantType: participantType }
      : { buyerParticipantType: participantType }
  );

  return db.transaction(async (tx) => {
    // 1. Create the resting order.
    const orderInsert = await tx.insert(trades).values({
      userId,
      tradeType: side === 'sell' ? 'p2p_sell' : 'p2p_buy',
      tradingMode: 'p2p',
      energy: energyWh,
      price: priceCentsPerKwh,
      totalAmount,
      timestamp: new Date(),
      status: 'pending',
      metadata: ownMetadata,
    }).returning({ id: trades.id });
    const orderId = insertedId(orderInsert);
    if (!orderId) throw new Error('Failed to create order');

    // 2. Find opposing orders by price-time priority.
    const opposing =
      side === 'sell'
        ? await tx
            .select()
            .from(trades)
            .where(
              and(
                eq(trades.tradeType, 'p2p_buy'),
                eq(trades.status, 'pending'),
                ne(trades.userId, userId),
                sql`${trades.price} >= ${priceCentsPerKwh}` // bid covers my minimum ask
              )
            )
            .orderBy(desc(trades.price), asc(trades.createdAt)) // best (highest) bid first
        : await tx
            .select()
            .from(trades)
            .where(
              and(
                eq(trades.tradeType, 'p2p_sell'),
                eq(trades.status, 'pending'),
                ne(trades.userId, userId),
                sql`${trades.price} <= ${priceCentsPerKwh}` // ask within my maximum bid
              )
            )
            .orderBy(asc(trades.price), asc(trades.createdAt)); // best (lowest) ask first

    // 3. Walk the book, filling against each opposing order.
    const matches: MatchExecution[] = [];
    let remaining = energyWh;

    for (const opp of opposing) {
      if (remaining <= 0) break;
      const oppSide: OrderSide = side === 'sell' ? 'buy' : 'sell';
      const oppFilled = await filledEnergyWh(tx, opp.id, oppSide);
      const oppRemaining = opp.energy - oppFilled;
      if (oppRemaining <= 0) continue;

      const fill = Math.min(remaining, oppRemaining);
      const execPrice = opp.price; // maker price
      const fillAmount = Math.floor((fill * execPrice) / 1000);

      const buyOrderId = side === 'buy' ? orderId : opp.id;
      const sellOrderId = side === 'sell' ? orderId : opp.id;
      const buyerId = side === 'buy' ? userId : opp.userId;
      const sellerId = side === 'sell' ? userId : opp.userId;

      const matchInsert = await tx.insert(p2pMatches).values({
        buyOrderId,
        sellOrderId,
        buyerId,
        sellerId,
        energyWh: fill,
        priceCentsPerKwh: execPrice,
        totalAmountCents: fillAmount,
      }).returning({ id: p2pMatches.id });

      matches.push({
        matchId: insertedId(matchInsert),
        buyOrderId,
        sellOrderId,
        buyerId,
        sellerId,
        energyWh: fill,
        priceCentsPerKwh: execPrice,
        totalAmountCents: fillAmount,
      });

      // Fully filled opposing order -> matched but unpaid. The status stays
      // 'pending' (status-conditional so a concurrent matcher cannot re-match
      // it; failure rolls back) because nobody has paid for this energy yet.
      if (fill === oppRemaining) {
        const upd = await tx
          .update(trades)
          .set({
            counterpartyId: userId,
            metadata: withSettlement(opp.metadata, {
              settlement: 'awaiting_payment',
              matchedAt: new Date().toISOString(),
              ...(side === 'sell'
                ? { sellerParticipantType: participantType }
                : { buyerParticipantType: participantType }),
            }),
          })
          .where(and(eq(trades.id, opp.id), eq(trades.status, 'pending')));
        if (affectedRows(upd) === 0) {
          throw new Error(`MATCH_CONFLICT: opposing order ${opp.id} changed state concurrently`);
        }
      }

      remaining -= fill;
    }

    // 4. Mark the incoming order matched if fully filled — still unpaid, so
    //    still a pending trade.
    const filledWh = energyWh - remaining;
    // counterpartyId can only name one party, so it is set only when the order
    // was filled by exactly one: a multi-counterparty fill records the list in
    // metadata rather than naming an arbitrary one of them.
    const counterparties = matches.map(m => (side === 'buy' ? m.sellerId : m.buyerId));
    const soleCounterparty = new Set(counterparties).size === 1 ? counterparties[0] : null;
    let finalStatus: 'open' | 'filled' = 'open';
    if (remaining === 0) {
      const upd = await tx
        .update(trades)
        .set({
          counterpartyId: soleCounterparty,
          metadata: withSettlement(ownMetadata, {
            settlement: 'awaiting_payment',
            matchedAt: new Date().toISOString(),
            counterpartyIds: [...new Set(counterparties)],
          }),
        })
        .where(and(eq(trades.id, orderId), eq(trades.status, 'pending')));
      if (affectedRows(upd) === 0) {
        throw new Error(`MATCH_CONFLICT: order ${orderId} changed state concurrently`);
      }
      finalStatus = 'filled';
    }

    return {
      orderId,
      side,
      status: finalStatus,
      settlement: filledWh > 0 ? 'awaiting_payment' : 'unmatched',
      requestedEnergyWh: energyWh,
      filledEnergyWh: filledWh,
      remainingEnergyWh: remaining,
      matches,
    };
  });
}

export interface OrderBookLevel {
  priceCentsPerKwh: number;
  energyWh: number; // aggregated remaining energy at this level
  orderCount: number;
}

/**
 * Aggregated order-book depth by price level, using remaining (unfilled)
 * energy per order. Bids sorted high->low, asks low->high.
 */
export async function getOrderBook(): Promise<{ bids: OrderBookLevel[]; asks: OrderBookLevel[]; generatedAt: string }> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const pending = await db
    .select({
      id: trades.id,
      tradeType: trades.tradeType,
      energy: trades.energy,
      price: trades.price,
      // Quoted identifiers: p2p_matches columns are camelCase, and PostgreSQL
      // folds unquoted names to lowercase, which made this read throw.
      filled: sql<number>`COALESCE((SELECT SUM(m."energyWh") FROM p2p_matches m WHERE m."buyOrderId" = ${trades.id} OR m."sellOrderId" = ${trades.id}), 0)`,
    })
    .from(trades)
    .where(and(inArray(trades.tradeType, ['p2p_buy', 'p2p_sell']), eq(trades.status, 'pending')));

  const bids = new Map<number, OrderBookLevel>();
  const asks = new Map<number, OrderBookLevel>();
  for (const o of pending) {
    const remainingWh = o.energy - Number(o.filled ?? 0);
    if (remainingWh <= 0) continue;
    const book = o.tradeType === 'p2p_buy' ? bids : asks;
    const level = book.get(o.price) ?? { priceCentsPerKwh: o.price, energyWh: 0, orderCount: 0 };
    level.energyWh += remainingWh;
    level.orderCount += 1;
    book.set(o.price, level);
  }

  return {
    bids: [...bids.values()].sort((a, b) => b.priceCentsPerKwh - a.priceCentsPerKwh),
    asks: [...asks.values()].sort((a, b) => a.priceCentsPerKwh - b.priceCentsPerKwh),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Match history involving a user (either leg).
 */
export async function getMatchesForUser(userId: number, limit: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  return db
    .select()
    .from(p2pMatches)
    .where(or(eq(p2pMatches.buyerId, userId), eq(p2pMatches.sellerId, userId)))
    .orderBy(desc(p2pMatches.executedAt))
    .limit(limit);
}

/**
 * The caller's open orders with remaining quantities.
 */
export async function getMyOpenOrders(userId: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const rows = await db
    .select({
      id: trades.id,
      tradeType: trades.tradeType,
      energy: trades.energy,
      price: trades.price,
      status: trades.status,
      createdAt: trades.createdAt,
      filled: sql<number>`COALESCE((SELECT SUM(m."energyWh") FROM p2p_matches m WHERE m."buyOrderId" = ${trades.id} OR m."sellOrderId" = ${trades.id}), 0)`,
    })
    .from(trades)
    .where(
      and(
        eq(trades.userId, userId),
        inArray(trades.tradeType, ['p2p_buy', 'p2p_sell']),
        eq(trades.status, 'pending')
      )
    )
    .orderBy(desc(trades.createdAt));

  return rows.map(r => ({
    ...r,
    filledEnergyWh: Number(r.filled ?? 0),
    remainingEnergyWh: r.energy - Number(r.filled ?? 0),
  }));
}
