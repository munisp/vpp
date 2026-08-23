/**
 * Dynamic Tariff Engine
 *
 * Learns a time-of-use tariff from REAL marketPrices history: hourly
 * averages over a trailing window are classified into off_peak / shoulder /
 * peak bands using the actual price distribution percentiles (p33/p67).
 * A grid-stress multiplier is derived from demandResponseEvents activity
 * overlapping each hour. Admin publication is versioned and append-only —
 * history is never overwritten.
 *
 * Fails loud: when there is insufficient market price history, computing a
 * tariff throws instead of fabricating prices.
 */

import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { getDb } from '../db';
import { demandResponseEvents, marketPrices } from '../../drizzle/schema';
import { dynamicTariffs } from '../../drizzle/innovations-schema';

const LEARNING_WINDOW_DAYS = 30;
const MIN_SAMPLES = 48; // absolute minimum observations to learn a profile
const MIN_HOURS_COVERED = 18; // of 24 hours must have at least one observation

// Grid-stress pricing: multiplier = 1 + MAX_STRESS_PREMIUM * stressRatio where
// stressRatio = (sum of targetReduction kW of DR events overlapping the hour)
// / (max targetReduction ever observed). All inputs are real query results.
const MAX_STRESS_PREMIUM = 0.5;

export type TariffBand = 'off_peak' | 'shoulder' | 'peak';
export type TariffCountry = 'nigeria' | 'tanzania';

export interface TariffPeriod {
  hourStart: string; // ISO timestamp
  band: TariffBand;
  basePriceCentsPerKwh: number | null;
  interpolated: boolean;
  gridStressMultiplier: number;
  finalPriceCentsPerKwh: number | null;
  overlappingDrEvents: number;
}

export interface LearnedProfile {
  windowDays: number;
  sampleCount: number;
  hoursCovered: number;
  p33CentsPerKwh: number | null;
  p67CentsPerKwh: number | null;
  hourlyAvgCents: (number | null)[]; // index 0..23
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Learn the hourly price profile from real marketPrices rows.
 * Throws when history is insufficient — no fabricated prices.
 */
export async function learnHourlyProfile(country: TariffCountry): Promise<LearnedProfile> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const since = new Date(Date.now() - LEARNING_WINDOW_DAYS * 86400000);
  const rows = await db
    .select({ timestamp: marketPrices.timestamp, price: marketPrices.price })
    .from(marketPrices)
    .where(and(eq(marketPrices.country, country), gte(marketPrices.timestamp, since)));

  const buckets: number[][] = Array.from({ length: 24 }, () => []);
  for (const r of rows) {
    buckets[new Date(r.timestamp).getHours()].push(r.price);
  }

  const hourlyAvg: (number | null)[] = buckets.map(b =>
    b.length > 0 ? Math.round(b.reduce((s, v) => s + v, 0) / b.length) : null
  );
  const hoursCovered = hourlyAvg.filter(v => v !== null).length;

  if (rows.length < MIN_SAMPLES || hoursCovered < MIN_HOURS_COVERED) {
    throw new Error(
      `Insufficient market price history for ${country}: ${rows.length} samples covering ${hoursCovered}/24 hours in the last ${LEARNING_WINDOW_DAYS} days (need >= ${MIN_SAMPLES} samples across >= ${MIN_HOURS_COVERED} hours). Cannot compute a tariff without real price data.`
    );
  }

  const knownAvgs = hourlyAvg.filter((v): v is number => v !== null).sort((a, b) => a - b);
  return {
    windowDays: LEARNING_WINDOW_DAYS,
    sampleCount: rows.length,
    hoursCovered,
    p33CentsPerKwh: percentile(knownAvgs, 1 / 3) !== null ? Math.round(percentile(knownAvgs, 1 / 3)!) : null,
    p67CentsPerKwh: percentile(knownAvgs, 2 / 3) !== null ? Math.round(percentile(knownAvgs, 2 / 3)!) : null,
    hourlyAvgCents: hourlyAvg,
  };
}

/**
 * Linear interpolation for hours with no observations, between the nearest
 * known hours (wrapping around midnight). Returns null only if no hour has
 * any data (already excluded by the sufficiency check).
 */
function interpolatedHourlyAvg(profile: LearnedProfile): { value: number | null; interpolated: boolean }[] {
  const known = profile.hourlyAvgCents;
  return known.map((v, hour) => {
    if (v !== null) return { value: v, interpolated: false };
    let before: number | null = null;
    let after: number | null = null;
    for (let d = 1; d < 24; d++) {
      const b = known[(hour - d + 24) % 24];
      const a = known[(hour + d) % 24];
      if (before === null && b !== null) before = d;
      if (after === null && a !== null) after = d;
      if (before !== null && after !== null) break;
    }
    if (before === null || after === null) return { value: null, interpolated: false };
    const vb = known[(hour - before + 24) % 24]!;
    const va = known[(hour + after) % 24]!;
    const t = before / (before + after);
    return { value: Math.round(vb + (va - vb) * t), interpolated: true };
  });
}

interface StressInfo {
  multiplier: number;
  overlappingEvents: number;
  totalTargetReductionKw: number;
  maxObservedTargetReductionKw: number | null;
}

/**
 * Grid-stress multiplier for a given hour, from real DR event activity.
 */
async function stressForHour(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, hourStart: Date, hourEnd: Date, maxObservedKw: number | null): Promise<StressInfo> {
  const overlapping = await db
    .select({ targetReduction: demandResponseEvents.targetReduction })
    .from(demandResponseEvents)
    .where(
      and(
        sql`${demandResponseEvents.status} IN ('scheduled', 'active')`,
        lte(demandResponseEvents.startTime, hourEnd),
        gte(demandResponseEvents.endTime, hourStart)
      )
    );

  const totalKw = overlapping.reduce((s, e) => s + e.targetReduction, 0);
  const ratio = maxObservedKw && maxObservedKw > 0 ? Math.min(1, totalKw / maxObservedKw) : 0;
  return {
    multiplier: Math.round((1 + MAX_STRESS_PREMIUM * ratio) * 1000) / 1000,
    overlappingEvents: overlapping.length,
    totalTargetReductionKw: totalKw,
    maxObservedTargetReductionKw: maxObservedKw,
  };
}

function classifyBand(avg: number | null, p33: number | null, p67: number | null): TariffBand {
  if (avg === null || p33 === null || p67 === null) return 'shoulder';
  if (avg <= p33) return 'off_peak';
  if (avg <= p67) return 'shoulder';
  return 'peak';
}

/**
 * Build a 24-hour tariff schedule starting at the top of the hour containing
 * `from`. Every price is derived from learned market data; hours without any
 * data are linearly interpolated and flagged.
 */
export async function buildTariffSchedule(country: TariffCountry, from: Date): Promise<{
  country: TariffCountry;
  learnedFrom: Omit<LearnedProfile, 'hourlyAvgCents'>;
  periods: TariffPeriod[];
}> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const profile = await learnHourlyProfile(country); // throws when insufficient
  const filled = interpolatedHourlyAvg(profile);

  // Real maximum observed DR target for stress normalization.
  const maxRows = await db
    .select({ maxTarget: sql<number | null>`MAX(${demandResponseEvents.targetReduction})` })
    .from(demandResponseEvents);
  const maxObservedKw = maxRows[0]?.maxTarget ?? null;

  const startHour = new Date(from);
  startHour.setMinutes(0, 0, 0);

  const periods: TariffPeriod[] = [];
  for (let i = 0; i < 24; i++) {
    const hourStart = new Date(startHour.getTime() + i * 3600000);
    const hourEnd = new Date(hourStart.getTime() + 3600000);
    const hourOfDay = hourStart.getHours();
    const { value: base, interpolated } = filled[hourOfDay];
    const stress = await stressForHour(db, hourStart, hourEnd, maxObservedKw);

    periods.push({
      hourStart: hourStart.toISOString(),
      band: classifyBand(base, profile.p33CentsPerKwh, profile.p67CentsPerKwh),
      basePriceCentsPerKwh: base,
      interpolated,
      gridStressMultiplier: stress.multiplier,
      finalPriceCentsPerKwh: base !== null ? Math.round(base * stress.multiplier) : null,
      overlappingDrEvents: stress.overlappingEvents,
    });
  }

  const { hourlyAvgCents: _omit, ...learnedFrom } = profile;
  return { country, learnedFrom, periods };
}

/**
 * Admin publication: persists the schedule as a new version and supersedes
 * the previous published version. Append-only — old versions are kept.
 */
export async function publishTariff(country: TariffCountry, effectiveFrom: Date, adminUserId: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const schedule = await buildTariffSchedule(country, effectiveFrom);

  return db.transaction(async (tx) => {
    const versionRows = await tx
      .select({ maxVersion: sql<number | null>`MAX(${dynamicTariffs.version})` })
      .from(dynamicTariffs)
      .where(eq(dynamicTariffs.country, country));
    const nextVersion = (versionRows[0]?.maxVersion ?? 0) + 1;

    await tx
      .update(dynamicTariffs)
      .set({ status: 'superseded' })
      .where(and(eq(dynamicTariffs.country, country), eq(dynamicTariffs.status, 'published')));

    const insert = await tx.insert(dynamicTariffs).values({
      country,
      version: nextVersion,
      status: 'published',
      effectiveFrom,
      periods: schedule.periods,
      learnedFrom: schedule.learnedFrom,
      publishedBy: adminUserId,
    }).returning({ id: dynamicTariffs.id });

    return {
      id: Number(insert[0].id ?? 0) || null,
      country,
      version: nextVersion,
      effectiveFrom: effectiveFrom.toISOString(),
      periods: schedule.periods,
      learnedFrom: schedule.learnedFrom,
    };
  });
}

export async function getPublishedTariff(country: TariffCountry) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const [row] = await db
    .select()
    .from(dynamicTariffs)
    .where(and(eq(dynamicTariffs.country, country), eq(dynamicTariffs.status, 'published')))
    .orderBy(desc(dynamicTariffs.version))
    .limit(1);
  return row ?? null;
}

export async function listTariffVersions(country: TariffCountry, limit: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  return db
    .select({
      id: dynamicTariffs.id,
      country: dynamicTariffs.country,
      version: dynamicTariffs.version,
      status: dynamicTariffs.status,
      effectiveFrom: dynamicTariffs.effectiveFrom,
      publishedBy: dynamicTariffs.publishedBy,
      createdAt: dynamicTariffs.createdAt,
    })
    .from(dynamicTariffs)
    .where(eq(dynamicTariffs.country, country))
    .orderBy(desc(dynamicTariffs.version))
    .limit(limit);
}
