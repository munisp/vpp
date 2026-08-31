/**
 * Grid-Services Revenue Ledger (innovation 11)
 *
 * A read-model ledger of what a user actually earned from grid services.
 * Every row in `grid_service_revenues` is a copy of facts taken from a real
 * source record at recording time:
 *
 *  - `dr_compensation`: a drCompensation row. Only `paid` rows are earnings;
 *    a pending or failed compensation is refused, not recorded.
 *  - `p2p_match`: a p2p_matches row where the user was the seller. The
 *    amount is the executed fill total; the currency is the seller's own
 *    platform currency (users.currency), because p2p_matches carries no
 *    currency of its own — this is recorded in metadata, not hidden.
 *  - `referral_reward`: a referral_rewards row. Only `processed` rows are
 *    earnings. CREDITS-denominated rewards are recorded with currency
 *    'CREDITS', never converted to money they are not.
 *
 * Recording is idempotent: (sourceType, sourceId) is unique, so recording
 * the same source twice returns the existing row. A source id that does not
 * exist, belongs to another user, or is not yet an earning is refused with
 * a typed error — unknown sources are never written.
 */

import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { getDb } from '../db';
import { drCompensation, users } from '../../drizzle/schema';
import { p2pMatches } from '../../drizzle/innovations-schema';
import { referralRewards } from '../../drizzle/referrals-schema';
import {
  gridServiceRevenues,
  type GridServiceRevenue,
} from '../../drizzle/innov3-market-schema';

export type RevenueSourceType = 'dr_compensation' | 'p2p_match' | 'referral_reward';

interface ResolvedSource {
  userId: number;
  amountCents: number;
  currency: string;
  occurredAt: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Read the source record and extract the earning. Throws:
 *  - SOURCE_NOT_FOUND   — no row with that id in the source table
 *  - SOURCE_NOT_PAYABLE — the row exists but is not an earning yet
 *    (dr compensation not paid, referral reward not processed)
 */
async function resolveSource(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  sourceType: RevenueSourceType,
  sourceId: number
): Promise<ResolvedSource> {
  if (sourceType === 'dr_compensation') {
    const [row] = await db.select().from(drCompensation).where(eq(drCompensation.id, sourceId)).limit(1);
    if (!row) throw new Error('SOURCE_NOT_FOUND');
    if (row.status !== 'paid') throw new Error('SOURCE_NOT_PAYABLE');
    return {
      userId: row.userId,
      amountCents: row.amount,
      currency: row.currency,
      occurredAt: row.paidAt ?? row.updatedAt,
      metadata: { eventId: row.eventId, responseId: row.responseId, paymentReference: row.paymentReference },
    };
  }

  if (sourceType === 'p2p_match') {
    const [row] = await db.select().from(p2pMatches).where(eq(p2pMatches.id, sourceId)).limit(1);
    if (!row) throw new Error('SOURCE_NOT_FOUND');
    // The seller earned the fill total; the buyer spent it.
    const [seller] = await db.select({ currency: users.currency }).from(users).where(eq(users.id, row.sellerId)).limit(1);
    return {
      userId: row.sellerId,
      amountCents: row.totalAmountCents,
      currency: seller?.currency ?? 'USD',
      occurredAt: row.executedAt,
      metadata: {
        energyWh: row.energyWh,
        priceCentsPerKwh: row.priceCentsPerKwh,
        currencyBasis: 'seller_users_currency', // p2p_matches has no currency column
      },
    };
  }

  if (sourceType === 'referral_reward') {
    const [row] = await db.select().from(referralRewards).where(eq(referralRewards.id, sourceId)).limit(1);
    if (!row) throw new Error('SOURCE_NOT_FOUND');
    if (row.status !== 'processed') throw new Error('SOURCE_NOT_PAYABLE');
    return {
      userId: row.userId,
      amountCents: row.amount,
      currency: row.currency,
      occurredAt: row.processedAt ?? row.updatedAt,
      metadata: { referralId: row.referralId, rewardType: row.rewardType },
    };
  }

  throw new Error('UNKNOWN_SOURCE_TYPE');
}

export interface RecordRevenueResult {
  recorded: boolean; // false = already recorded (idempotent replay)
  revenue: GridServiceRevenue;
}

/**
 * Record one earning from a real source record. The caller's userId must
 * match the source record's owner — you cannot record someone else's
 * earnings.
 */
export async function recordRevenue(
  userId: number,
  sourceType: RevenueSourceType,
  sourceId: number
): Promise<RecordRevenueResult> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const resolved = await resolveSource(db, sourceType, sourceId);
  if (resolved.userId !== userId) throw new Error('SOURCE_USER_MISMATCH');

  const inserted = await db
    .insert(gridServiceRevenues)
    .values({
      userId,
      sourceType,
      sourceId,
      amountCents: resolved.amountCents,
      currency: resolved.currency,
      occurredAt: resolved.occurredAt,
      metadata: resolved.metadata ? JSON.stringify(resolved.metadata) : null,
    })
    .onConflictDoNothing({
      target: [gridServiceRevenues.sourceType, gridServiceRevenues.sourceId],
    })
    .returning();

  if (inserted.length > 0) return { recorded: true, revenue: inserted[0] };

  const [existing] = await db
    .select()
    .from(gridServiceRevenues)
    .where(and(eq(gridServiceRevenues.sourceType, sourceType), eq(gridServiceRevenues.sourceId, sourceId)))
    .limit(1);
  if (!existing) throw new Error('Database not available');
  return { recorded: false, revenue: existing };
}

/**
 * Scan all three real source tables for a user and record everything that
 * is currently an earning. Returns per-source counts. Idempotent.
 */
export async function syncUserRevenues(userId: number): Promise<{
  drCompensation: { found: number; newlyRecorded: number };
  p2pMatches: { found: number; newlyRecorded: number };
  referralRewards: { found: number; newlyRecorded: number };
}> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const result = {
    drCompensation: { found: 0, newlyRecorded: 0 },
    p2pMatches: { found: 0, newlyRecorded: 0 },
    referralRewards: { found: 0, newlyRecorded: 0 },
  };

  const drRows = await db
    .select({ id: drCompensation.id })
    .from(drCompensation)
    .where(and(eq(drCompensation.userId, userId), eq(drCompensation.status, 'paid')));
  result.drCompensation.found = drRows.length;
  for (const row of drRows) {
    const r = await recordRevenue(userId, 'dr_compensation', row.id);
    if (r.recorded) result.drCompensation.newlyRecorded++;
  }

  const p2pRows = await db
    .select({ id: p2pMatches.id })
    .from(p2pMatches)
    .where(eq(p2pMatches.sellerId, userId));
  result.p2pMatches.found = p2pRows.length;
  for (const row of p2pRows) {
    const r = await recordRevenue(userId, 'p2p_match', row.id);
    if (r.recorded) result.p2pMatches.newlyRecorded++;
  }

  const refRows = await db
    .select({ id: referralRewards.id })
    .from(referralRewards)
    .where(and(eq(referralRewards.userId, userId), eq(referralRewards.status, 'processed')));
  result.referralRewards.found = refRows.length;
  for (const row of refRows) {
    const r = await recordRevenue(userId, 'referral_reward', row.id);
    if (r.recorded) result.referralRewards.newlyRecorded++;
  }

  return result;
}

export async function listRevenues(
  userId: number,
  opts: { limit: number; sourceType?: RevenueSourceType }
): Promise<GridServiceRevenue[]> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const where = opts.sourceType
    ? and(eq(gridServiceRevenues.userId, userId), eq(gridServiceRevenues.sourceType, opts.sourceType))
    : eq(gridServiceRevenues.userId, userId);
  return db
    .select()
    .from(gridServiceRevenues)
    .where(where)
    .orderBy(desc(gridServiceRevenues.occurredAt))
    .limit(opts.limit);
}

export interface RevenueSummary {
  userId: number;
  from: string | null;
  to: string | null;
  /** Per (source, currency) totals. Amounts in whole minor units. */
  bySource: Array<{ sourceType: RevenueSourceType; currency: string; totalAmountCents: number; count: number }>;
  /** Per (UTC month, currency) totals across all sources. */
  byMonth: Array<{ month: string; currency: string; totalAmountCents: number; count: number }>;
}

/**
 * Aggregated views over recorded revenue rows, grouped by source and by
 * UTC month. Currencies are never mixed: each bucket is per-currency.
 */
export async function getRevenueSummary(
  userId: number,
  opts: { from?: Date; to?: Date }
): Promise<RevenueSummary> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const conditions = [eq(gridServiceRevenues.userId, userId)];
  if (opts.from) conditions.push(gte(gridServiceRevenues.occurredAt, opts.from));
  if (opts.to) conditions.push(lt(gridServiceRevenues.occurredAt, opts.to));
  const where = and(...conditions);

  const bySourceRows = await db
    .select({
      sourceType: gridServiceRevenues.sourceType,
      currency: gridServiceRevenues.currency,
      totalAmountCents: sql<number>`SUM(${gridServiceRevenues.amountCents})`,
      count: sql<number>`COUNT(*)`,
    })
    .from(gridServiceRevenues)
    .where(where)
    .groupBy(gridServiceRevenues.sourceType, gridServiceRevenues.currency);

  const byMonthRows = await db
    .select({
      month: sql<string>`TO_CHAR(${gridServiceRevenues.occurredAt} AT TIME ZONE 'UTC', 'YYYY-MM')`,
      currency: gridServiceRevenues.currency,
      totalAmountCents: sql<number>`SUM(${gridServiceRevenues.amountCents})`,
      count: sql<number>`COUNT(*)`,
    })
    .from(gridServiceRevenues)
    .where(where)
    .groupBy(sql`TO_CHAR(${gridServiceRevenues.occurredAt} AT TIME ZONE 'UTC', 'YYYY-MM')`, gridServiceRevenues.currency)
    .orderBy(sql`TO_CHAR(${gridServiceRevenues.occurredAt} AT TIME ZONE 'UTC', 'YYYY-MM')`);

  return {
    userId,
    from: opts.from?.toISOString() ?? null,
    to: opts.to?.toISOString() ?? null,
    bySource: bySourceRows.map((r) => ({
      sourceType: r.sourceType,
      currency: r.currency,
      totalAmountCents: Number(r.totalAmountCents),
      count: Number(r.count),
    })),
    byMonth: byMonthRows.map((r) => ({
      month: r.month,
      currency: r.currency,
      totalAmountCents: Number(r.totalAmountCents),
      count: Number(r.count),
    })),
  };
}
