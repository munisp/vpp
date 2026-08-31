/**
 * Tariff Switch Advisor
 *
 * Prices the user's REAL usage profile — the hour-of-day shape of their
 * interval power telemetry aggregated across all their assets over the
 * trailing window — against every published dynamic tariff version, and
 * ranks them cheapest-first.
 *
 * Honest states (a comparison row is persisted either way):
 *  - no published tariffs at all  -> available:false, reason 'no_published_tariffs'
 *  - too little usage history     -> available:false, reason 'insufficient_usage'
 * A tariff whose profile has null-priced hours prices only the hours it can
 * and is flagged `complete:false` with the unpriced energy reported — the
 * missing hours are never given an assumed price.
 */

import { asc, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db';
import { assets, telemetry } from '../../drizzle/schema';
import { dynamicTariffs } from '../../drizzle/innovations-schema';
import { tariffComparisons } from '../../drizzle/innov3-planning-schema';

const USAGE_WINDOW_DAYS = 30;
const MIN_SPAN_DAYS = 7;
const MIN_SAMPLES = 24 * MIN_SPAN_DAYS; // avg >= 1 sample/hour over a week
const GAP_CAP_MS = 60 * 60 * 1000;
const MAX_SAMPLES = 500000;

export type ComparisonUnavailableReason = 'no_published_tariffs' | 'insufficient_usage';

export interface TariffCostResult {
  tariffId: number;
  version: number;
  country: string;
  computedCostCents: number;
  /** Usage falling in hours the tariff could not price (null price). */
  unpricedWh: number;
  complete: boolean;
  rank: number;
}

export interface TariffComparisonResult {
  comparisonId: number | null;
  userId: number;
  country: string;
  available: boolean;
  unavailableReason: ComparisonUnavailableReason | null;
  windowStart: string | null;
  windowEnd: string | null;
  spanDays: number | null;
  usageWh: number | null;
  hourlyUsageWh: number[] | null;
  results: TariffCostResult[];
  cheapestTariffId: number | null;
  cheapestCostCents: number | null;
  currentTariffId: number | null;
  savingsVsCurrentCents: number | null;
  computedAt: string;
}

export async function compareTariffs(userId: number, country: 'nigeria' | 'tanzania'): Promise<TariffComparisonResult> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const computedAt = new Date().toISOString();

  const persist = async (r: Omit<TariffComparisonResult, 'comparisonId'>): Promise<TariffComparisonResult> => {
    const insert = await db.insert(tariffComparisons).values({
      userId,
      country,
      windowStart: r.windowStart ? new Date(r.windowStart) : null,
      windowEnd: r.windowEnd ? new Date(r.windowEnd) : null,
      spanDays10: r.spanDays !== null ? Math.round(r.spanDays * 10) : null,
      usageWh: r.usageWh,
      hourlyUsageWh: r.hourlyUsageWh,
      available: r.available,
      unavailableReason: r.unavailableReason,
      results: r.results,
      cheapestTariffId: r.cheapestTariffId,
      cheapestCostCents: r.cheapestCostCents,
      currentTariffId: r.currentTariffId,
      savingsVsCurrentCents: r.savingsVsCurrentCents,
    }).returning({ id: tariffComparisons.id });
    return { ...r, comparisonId: Number(insert[0].id ?? 0) || null };
  };

  const empty: Omit<TariffComparisonResult, 'comparisonId'> = {
    userId,
    country,
    available: false,
    unavailableReason: null,
    windowStart: null,
    windowEnd: null,
    spanDays: null,
    usageWh: null,
    hourlyUsageWh: null,
    results: [],
    cheapestTariffId: null,
    cheapestCostCents: null,
    currentTariffId: null,
    savingsVsCurrentCents: null,
    computedAt,
  };

  // Every published tariff version (per country, the latest published row is
  // the live one; older versions are 'superseded' and excluded).
  const published = await db
    .select()
    .from(dynamicTariffs)
    .where(eq(dynamicTariffs.status, 'published'))
    .orderBy(desc(dynamicTariffs.version));

  if (published.length === 0) {
    return persist({ ...empty, unavailableReason: 'no_published_tariffs' });
  }

  // Real usage profile across all of the user's assets.
  const userAssets = await db.select({ id: assets.id }).from(assets).where(eq(assets.userId, userId));
  const assetIds = userAssets.map(a => a.id);

  let hourlyUsageWh: number[] | null = null;
  let usageWh: number | null = null;
  let windowStart: string | null = null;
  let windowEnd: string | null = null;
  let spanDays: number | null = null;

  if (assetIds.length > 0) {
    const since = new Date(Date.now() - USAGE_WINDOW_DAYS * 86400000);
    const samples = await db
      .select({ timestamp: telemetry.timestamp, power: telemetry.power })
      .from(telemetry)
      .where(inArray(telemetry.assetId, assetIds))
      .orderBy(asc(telemetry.timestamp))
      .limit(MAX_SAMPLES);

    const powerSamples = samples.filter(
      (s): s is { timestamp: Date; power: number } =>
        s.power !== null && new Date(s.timestamp) >= since
    );
    const first = powerSamples[0]?.timestamp ?? null;
    const last = powerSamples[powerSamples.length - 1]?.timestamp ?? null;
    const span = first && last ? (new Date(last).getTime() - new Date(first).getTime()) / 86400000 : 0;

    if (powerSamples.length >= MIN_SAMPLES && span >= MIN_SPAN_DAYS) {
      const hourly = new Array<number>(24).fill(0);
      let total = 0;
      for (let i = 1; i < powerSamples.length; i++) {
        const a = powerSamples[i - 1];
        const b = powerSamples[i];
        const dtMs = new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
        if (dtMs <= 0 || dtMs > GAP_CAP_MS) continue;
        const wh = (a.power * dtMs) / 3600000;
        hourly[new Date(a.timestamp).getHours()] += wh;
        total += wh;
      }
      hourlyUsageWh = hourly.map(v => Math.round(v));
      usageWh = Math.round(total);
      windowStart = new Date(first!).toISOString();
      windowEnd = new Date(last!).toISOString();
      spanDays = Math.round(span * 10) / 10;
    }
  }

  if (usageWh === null || hourlyUsageWh === null) {
    return persist({ ...empty, unavailableReason: 'insufficient_usage' });
  }

  // Price the profile under each published tariff.
  const unranked: Array<Omit<TariffCostResult, 'rank'>> = published.map(t => {
    const priceByHour = new Map<number, number>();
    for (const p of t.periods) {
      if (p.finalPriceCentsPerKwh !== null && p.finalPriceCentsPerKwh !== undefined) {
        priceByHour.set(new Date(p.hourStart).getHours(), p.finalPriceCentsPerKwh);
      }
    }
    let costCents = 0;
    let unpricedWh = 0;
    for (let h = 0; h < 24; h++) {
      const price = priceByHour.get(h);
      if (price === undefined) unpricedWh += hourlyUsageWh[h];
      else costCents += (hourlyUsageWh[h] * price) / 1000;
    }
    return {
      tariffId: t.id,
      version: t.version,
      country: t.country,
      computedCostCents: Math.round(costCents),
      unpricedWh: Math.round(unpricedWh),
      complete: unpricedWh === 0,
    };
  });

  // Cheapest-first; incomplete tariffs rank below complete ones at equal cost
  // because their true cost is understated.
  const ranked: TariffCostResult[] = [...unranked]
    .sort((a, b) =>
      a.computedCostCents - b.computedCostCents ||
      Number(b.complete) - Number(a.complete) ||
      a.tariffId - b.tariffId,
    )
    .map((r, i) => ({ ...r, rank: i + 1 }));

  const cheapest = ranked[0] ?? null;
  const current = ranked.find(r => r.country === country) ?? null;

  return persist({
    ...empty,
    available: true,
    windowStart,
    windowEnd,
    spanDays,
    usageWh,
    hourlyUsageWh,
    results: ranked,
    cheapestTariffId: cheapest?.tariffId ?? null,
    cheapestCostCents: cheapest?.computedCostCents ?? null,
    currentTariffId: current?.tariffId ?? null,
    savingsVsCurrentCents: current && cheapest && current.complete && cheapest.complete
      ? current.computedCostCents - cheapest.computedCostCents
      : null,
  });
}

export async function listTariffComparisons(userId: number, limit: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  return db
    .select()
    .from(tariffComparisons)
    .where(eq(tariffComparisons.userId, userId))
    .orderBy(desc(tariffComparisons.computedAt))
    .limit(limit);
}
