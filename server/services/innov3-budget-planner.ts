/**
 * Energy budget planner (innovation 20)
 *
 * A user sets a monthly kWh and/or cost target. Checkpoints (one per ISO
 * week, refreshed on demand) record the REAL consumption pace against the
 * target:
 *
 *   - consumption month-to-date comes from the user's meter assets'
 *     cumulative energy registers (telemetry.energy deltas — the same
 *     register convention as the prepaid subsystem), falling back to real
 *     billings rows when no meter has reported;
 *   - billed cost month-to-date comes from real billings rows only;
 *   - the month-end figure is a pace PROJECTION and is labelled as such.
 *     It is withheld (`projectionAvailable: false`, reason
 *     'insufficient_days') until at least 3 days of real data exist, and
 *     is meaningless for months that are over ('month_complete') or have
 *     not started ('month_not_started').
 *
 * A meter with fewer than two readings in the month contributes an unknown
 * amount, not zero: when any meter is in that state the total is a lower
 * bound and the basis says so.
 */

import { and, asc, desc, eq, gte, lte } from 'drizzle-orm';
import { getDb } from '../db';
import { assets, billings, telemetry, users } from '../../drizzle/schema';
import {
  budgetCheckpoints,
  energyBudgets,
  type BudgetCheckpointRow,
  type EnergyBudgetRow,
} from '../../drizzle/innov3-control-schema';

export class BudgetError extends Error {}

/** Fewer days than this and a pace projection is extrapolating from noise. */
export const MIN_PROJECTION_DAYS = 3;

export interface ConsumptionBasis {
  /** 'telemetry' = meter register deltas; 'billing' = billings rows; null = neither existed. */
  source: 'telemetry' | 'billing' | null;
  meterAssets: number;
  /** Meters with fewer than two in-month readings — their consumption is unknown, not zero. */
  metersWithInsufficientReadings: number[];
  billingRows: number;
  /** True when any meter's consumption is unknown: the total is a lower bound. */
  lowerBound: boolean;
}

function monthBounds(year: number, month: number): { start: Date; end: Date; daysInMonth: number } {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  const daysInMonth = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  return { start, end, daysInMonth };
}

/** Monday (UTC) of the week containing `at`. */
function weekStartOf(at: Date): Date {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(d.getTime() - dow * 86_400_000);
}

/**
 * Measure month-to-date consumption and billed cost for the user.
 */
async function measureMonthToDate(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  userId: number,
  start: Date,
  end: Date
): Promise<{ consumedWh: number | null; billedCostCents: number | null; basis: ConsumptionBasis }> {
  // 1. Meter register deltas (telemetry.energy is cumulative watt-hours).
  const meters = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.userId, userId), eq(assets.assetType, 'meter'), eq(assets.status, 'active')));

  let telemetryWh = 0;
  let telemetryUsable = false;
  const insufficient: number[] = [];
  for (const meter of meters) {
    const rows = await db
      .select({ energy: telemetry.energy, timestamp: telemetry.timestamp })
      .from(telemetry)
      .where(
        and(
          eq(telemetry.assetId, meter.id),
          gte(telemetry.timestamp, start),
          lte(telemetry.timestamp, end)
        )
      )
      .orderBy(asc(telemetry.timestamp));
    const readings = rows.filter((r) => r.energy !== null);
    if (readings.length < 2) {
      insufficient.push(meter.id);
      continue;
    }
    const first = readings[0].energy!;
    const last = readings[readings.length - 1].energy!;
    // A register that moved backwards (reset/replacement) makes the delta
    // meaningless: that meter's month is unknown, not negative.
    if (last >= first) {
      telemetryWh += last - first;
      telemetryUsable = true;
    } else {
      insufficient.push(meter.id);
    }
  }

  // 2. Real billings overlapping the month.
  const billingRows = await db
    .select({
      id: billings.id,
      consumptionKwh: billings.consumptionKwh,
      totalValue: billings.totalValue,
    })
    .from(billings)
    .where(
      and(
        eq(billings.userId, userId),
        lte(billings.periodStart, end),
        gte(billings.periodEnd, start)
      )
    );

  const billingWh = billingRows.reduce((sum, r) => sum + r.consumptionKwh * 1000, 0);
  const billedCostCents = billingRows.length > 0 ? billingRows.reduce((sum, r) => sum + r.totalValue, 0) : null;

  const lowerBound = insufficient.length > 0;
  if (telemetryUsable) {
    return {
      consumedWh: telemetryWh,
      billedCostCents,
      basis: {
        source: 'telemetry',
        meterAssets: meters.length,
        metersWithInsufficientReadings: insufficient,
        billingRows: billingRows.length,
        lowerBound,
      },
    };
  }
  if (billingRows.length > 0) {
    return {
      consumedWh: billingWh,
      billedCostCents,
      basis: {
        source: 'billing',
        meterAssets: meters.length,
        metersWithInsufficientReadings: insufficient,
        billingRows: billingRows.length,
        lowerBound: meters.length > 0, // meters exist but reported nothing usable: unknown on top
      },
    };
  }
  return {
    consumedWh: null,
    billedCostCents: null,
    basis: {
      source: null,
      meterAssets: meters.length,
      metersWithInsufficientReadings: insufficient,
      billingRows: 0,
      lowerBound,
    },
  };
}

/**
 * Create or update the user's budget for a month. At least one target is
 * required — a budget with no target measures nothing.
 */
export async function setBudget(
  userId: number,
  params: { year: number; month: number; targetKwh?: number | null; targetCostCents?: number | null }
): Promise<EnergyBudgetRow> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  if (params.month < 1 || params.month > 12) throw new BudgetError('month must be 1-12');
  const targetKwh = params.targetKwh ?? null;
  const targetCostCents = params.targetCostCents ?? null;
  if (targetKwh === null && targetCostCents === null) {
    throw new BudgetError('A budget needs at least one target: targetKwh and/or targetCostCents');
  }
  if (targetKwh !== null && targetKwh <= 0) throw new BudgetError('targetKwh must be positive');
  if (targetCostCents !== null && targetCostCents <= 0) throw new BudgetError('targetCostCents must be positive');

  const userRows = await db.select({ currency: users.currency }).from(users).where(eq(users.id, userId)).limit(1);
  const currency = userRows[0]?.currency;
  if (!currency) throw new BudgetError(`User ${userId} not found`);

  const existing = await db
    .select()
    .from(energyBudgets)
    .where(and(eq(energyBudgets.userId, userId), eq(energyBudgets.year, params.year), eq(energyBudgets.month, params.month)))
    .limit(1);

  if (existing[0]) {
    const updated = await db
      .update(energyBudgets)
      .set({ targetKwh, targetCostCents })
      .where(eq(energyBudgets.id, existing[0].id))
      .returning();
    return updated[0];
  }

  const inserted = await db
    .insert(energyBudgets)
    .values({ userId, year: params.year, month: params.month, targetKwh, targetCostCents, currency })
    .returning();
  return inserted[0];
}

export async function listBudgets(userId: number, limit: number): Promise<EnergyBudgetRow[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(energyBudgets)
    .where(eq(energyBudgets.userId, userId))
    .orderBy(desc(energyBudgets.year), desc(energyBudgets.month))
    .limit(limit);
}

export async function getBudget(userId: number, budgetId: number): Promise<EnergyBudgetRow> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const rows = await db
    .select()
    .from(energyBudgets)
    .where(and(eq(energyBudgets.id, budgetId), eq(energyBudgets.userId, userId)))
    .limit(1);
  const budget = rows[0];
  if (!budget) throw new BudgetError(`Budget ${budgetId} not found`);
  return budget;
}

export interface CheckpointResult {
  checkpoint: BudgetCheckpointRow;
  budget: EnergyBudgetRow;
  /** kWh target progress, when the budget has a kWh target. Null when it does not. */
  kwhProgress: { consumedKwh: number; targetKwh: number; percentOfTarget: number } | null;
  /** Cost target progress, when the budget has a cost target and billing exists. */
  costProgress: { billedCents: number; targetCents: number; percentOfTarget: number } | null;
}

/**
 * Record this week's checkpoint: measure real month-to-date consumption
 * and cost, and project month-end from the pace where there is enough data
 * to project honestly. One row per budget per ISO week; re-recording in
 * the same week refreshes that row.
 */
export async function recordCheckpoint(userId: number, budgetId: number): Promise<CheckpointResult> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const budget = await getBudget(userId, budgetId);

  const now = new Date();
  const { start, end, daysInMonth } = monthBounds(budget.year, budget.month);

  const measured = await measureMonthToDate(db, userId, start, end < now ? end : now);

  let daysElapsed: number;
  let projectionAvailable = false;
  let projectionUnavailableReason: string | null = null;
  let projectedMonthEndWh: number | null = null;
  let projectedMonthEndCostCents: number | null = null;

  if (now < start) {
    daysElapsed = 0;
    projectionUnavailableReason = 'month_not_started';
  } else if (now >= end) {
    daysElapsed = daysInMonth;
    projectionUnavailableReason = 'month_complete'; // actuals exist; a projection is meaningless
  } else {
    daysElapsed = Math.max(1, Math.floor((now.getTime() - start.getTime()) / 86_400_000) + 1);
    if (measured.consumedWh === null) {
      projectionUnavailableReason = 'no_consumption_data';
    } else if (daysElapsed < MIN_PROJECTION_DAYS) {
      projectionUnavailableReason = 'insufficient_days';
    } else {
      projectionAvailable = true;
      projectedMonthEndWh = Math.round((measured.consumedWh / daysElapsed) * daysInMonth);
      if (measured.billedCostCents !== null) {
        projectedMonthEndCostCents = Math.round((measured.billedCostCents / daysElapsed) * daysInMonth);
      }
    }
  }

  const weekStart = weekStartOf(now);
  const values = {
    checkpointAt: now,
    daysElapsed,
    daysInMonth,
    consumedWh: measured.consumedWh,
    billedCostCents: measured.billedCostCents,
    basisJson: measured.basis,
    projectionAvailable,
    projectionUnavailableReason,
    projectedMonthEndWh,
    projectedMonthEndCostCents,
  };

  const existing = await db
    .select()
    .from(budgetCheckpoints)
    .where(and(eq(budgetCheckpoints.budgetId, budgetId), eq(budgetCheckpoints.weekStart, weekStart)))
    .limit(1);

  let checkpoint: BudgetCheckpointRow;
  if (existing[0]) {
    const updated = await db
      .update(budgetCheckpoints)
      .set(values)
      .where(eq(budgetCheckpoints.id, existing[0].id))
      .returning();
    checkpoint = updated[0];
  } else {
    const inserted = await db
      .insert(budgetCheckpoints)
      .values({ budgetId, weekStart, ...values })
      .returning();
    checkpoint = inserted[0];
  }

  const kwhProgress =
    budget.targetKwh !== null && measured.consumedWh !== null
      ? {
          consumedKwh: Math.round(measured.consumedWh / 10) / 100,
          targetKwh: budget.targetKwh,
          percentOfTarget: Math.round((measured.consumedWh / (budget.targetKwh * 1000)) * 1000) / 10,
        }
      : null;
  const costProgress =
    budget.targetCostCents !== null && measured.billedCostCents !== null
      ? {
          billedCents: measured.billedCostCents,
          targetCents: budget.targetCostCents,
          percentOfTarget: Math.round((measured.billedCostCents / budget.targetCostCents) * 1000) / 10,
        }
      : null;

  return { checkpoint, budget, kwhProgress, costProgress };
}

export async function listCheckpoints(userId: number, budgetId: number, limit: number): Promise<BudgetCheckpointRow[]> {
  const db = await getDb();
  if (!db) return [];
  await getBudget(userId, budgetId); // ownership check
  return db
    .select()
    .from(budgetCheckpoints)
    .where(eq(budgetCheckpoints.budgetId, budgetId))
    .orderBy(desc(budgetCheckpoints.checkpointAt))
    .limit(limit);
}
