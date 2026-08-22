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
 * quantities are tracked in `p2p_matches`, and an order flips to 'executed'
 * (via a status-conditional update, same convention as routers/p2p-trading.ts)
 * only when fully filled. Fully-filled incoming orders also flip atomically.
 */

import { and, asc, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { getDb } from '../db';
import { trades } from '../../drizzle/schema';
import { p2pMatches } from '../../drizzle/innovations-schema';

function affectedRows(result: { rowCount: number | null }): number {
  return result.rowCount ?? 0;
}

function insertedId(returned: { id: number }[]): number | null {
  const id = Number(returned[0]?.id);
  return Number.isFinite(id) && id > 0 ? id : null;
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
  status: 'pending' | 'executed';
  requestedEnergyWh: number;
  filledEnergyWh: number;
  remainingEnergyWh: number;
  matches: MatchExecution[];
}

async function filledEnergyWh(tx: any, orderId: number, side: OrderSide): Promise<number> {
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
export async function submitOrder(userId: number, side: OrderSide, energyWh: number, priceCentsPerKwh: number): Promise<SubmitOrderResult> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const totalAmount = Math.floor((energyWh * priceCentsPerKwh) / 1000);
  if (totalAmount <= 0) {
    throw new Error('ORDER_VALUE_TOO_SMALL');
  }

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

      // Fully filled opposing order -> executed (status-conditional so a
      // concurrent matcher cannot double-execute it; failure rolls back).
      if (fill === oppRemaining) {
        const upd = await tx
          .update(trades)
          .set({ status: 'executed', counterpartyId: userId })
          .where(and(eq(trades.id, opp.id), eq(trades.status, 'pending')));
        if (affectedRows(upd) === 0) {
          throw new Error(`MATCH_CONFLICT: opposing order ${opp.id} changed state concurrently`);
        }
      }

      remaining -= fill;
    }

    // 4. Flip the incoming order if fully filled.
    const filledWh = energyWh - remaining;
    let finalStatus: 'pending' | 'executed' = 'pending';
    if (remaining === 0) {
      const upd = await tx
        .update(trades)
        .set({ status: 'executed' })
        .where(and(eq(trades.id, orderId), eq(trades.status, 'pending')));
      if (affectedRows(upd) === 0) {
        throw new Error(`MATCH_CONFLICT: order ${orderId} changed state concurrently`);
      }
      finalStatus = 'executed';
    }

    return {
      orderId,
      side,
      status: finalStatus,
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
      filled: sql<number>`COALESCE((SELECT SUM(m.energyWh) FROM p2p_matches m WHERE m.buyOrderId = ${trades.id} OR m.sellOrderId = ${trades.id}), 0)`,
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
      filled: sql<number>`COALESCE((SELECT SUM(m.energyWh) FROM p2p_matches m WHERE m.buyOrderId = ${trades.id} OR m.sellOrderId = ${trades.id}), 0)`,
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
