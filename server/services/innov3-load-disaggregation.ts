/**
 * Load Disaggregation (NILM-lite)
 *
 * Estimates appliance-class shares of an asset's consumption from the shape
 * of its real interval power telemetry. This is not sub-metering: every
 * estimate is labelled with its method and a confidence, and every energy
 * field is named `estimatedWh` to keep that visible.
 *
 * Method `interval_shape_heuristic_v1`:
 *  - always_on_base:              each day's 10th-percentile power, held for
 *                                 24h (the load that never turns off).
 *  - evening_peak_block:          measured energy above that day's base
 *                                 during 17:00-22:00 UTC.
 *  - daytime_variable_above_base: measured energy above base at all other
 *                                 hours.
 * The base estimate is capped so the three classes never exceed the window's
 * total measured energy (long telemetry gaps mean the base load was not truly
 * held for the whole day) — nothing is ever added beyond what was measured.
 *
 * Confidence (0-1000) combines data coverage (days with data / span days)
 * and day-to-day stability (1 - coefficient of variation of daily totals),
 * so sparse or erratic telemetry honestly lowers it.
 *
 * The service REFUSES (< MIN_SPAN_DAYS of history or too few samples) by
 * returning insufficientData:true with a reason and writing no rows.
 */

import { and, asc, desc, eq } from 'drizzle-orm';
import { getDb } from '../db';
import { assets, telemetry } from '../../drizzle/schema';
import { applianceEstimates } from '../../drizzle/innov3-planning-schema';

const MIN_SPAN_DAYS = 14;
const MIN_SAMPLES = MIN_SPAN_DAYS * 12; // avg >= 12 samples/day
const MIN_SAMPLES_PER_DAY = 6; // a day with fewer contributes no base estimate
const GAP_CAP_MS = 60 * 60 * 1000; // don't integrate power across gaps > 1h
const EVENING_START_HOUR = 17; // UTC
const EVENING_END_HOUR = 22; // UTC
const METHOD = 'interval_shape_heuristic_v1';
const MAX_SAMPLES = 500000;

export type ApplianceClass = 'always_on_base' | 'evening_peak_block' | 'daytime_variable_above_base';

export interface ApplianceEstimateResult {
  applianceClass: ApplianceClass;
  estimatedWh: number;
  /** Percent * 1000. */
  shareMilliPct: number;
  /** 0-1000. */
  confidenceMilli: number;
  method: string;
}

export interface DisaggregationResult {
  assetId: number;
  assetName: string;
  insufficientData: boolean;
  reason: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  spanDays: number | null;
  sampleCount: number;
  totalMeasuredWh: number | null;
  daysWithData: number;
  estimates: ApplianceEstimateResult[];
  persistedEstimateIds: number[];
  computedAt: string;
}

function percentile10(sorted: number[]): number {
  const idx = (sorted.length - 1) * 0.1;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export async function computeLoadDisaggregation(assetId: number, userId: number): Promise<DisaggregationResult> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  if (!asset) throw new Error('ASSET_NOT_FOUND');
  if (asset.userId !== userId) throw new Error('ASSET_NOT_OWNED');

  const samples = await db
    .select({ timestamp: telemetry.timestamp, power: telemetry.power })
    .from(telemetry)
    .where(eq(telemetry.assetId, assetId))
    .orderBy(asc(telemetry.timestamp))
    .limit(MAX_SAMPLES);

  const computedAt = new Date().toISOString();
  const powerSamples = samples.filter(s => s.power !== null) as Array<{ timestamp: Date; power: number }>;
  const first = powerSamples[0]?.timestamp ?? null;
  const last = powerSamples[powerSamples.length - 1]?.timestamp ?? null;
  const spanDays = first && last ? (new Date(last).getTime() - new Date(first).getTime()) / 86400000 : 0;

  const base: DisaggregationResult = {
    assetId: asset.id,
    assetName: asset.name,
    insufficientData: true,
    reason: null,
    windowStart: first ? new Date(first).toISOString() : null,
    windowEnd: last ? new Date(last).toISOString() : null,
    spanDays: first && last ? Math.round(spanDays * 10) / 10 : null,
    sampleCount: powerSamples.length,
    totalMeasuredWh: null,
    daysWithData: 0,
    estimates: [],
    persistedEstimateIds: [],
    computedAt,
  };

  if (powerSamples.length === 0) {
    return { ...base, reason: 'No power telemetry recorded for this asset.' };
  }
  if (spanDays < MIN_SPAN_DAYS || powerSamples.length < MIN_SAMPLES) {
    return {
      ...base,
      reason: spanDays < MIN_SPAN_DAYS
        ? `Telemetry spans ${spanDays.toFixed(1)} days; at least ${MIN_SPAN_DAYS} days of interval history are required for disaggregation.`
        : `Only ${powerSamples.length} power samples; at least ${MIN_SAMPLES} (avg ${12}/day over ${MIN_SPAN_DAYS} days) are required.`,
    };
  }

  // Per-day base power from that day's own 10th percentile.
  const byDay = new Map<string, Array<{ timestamp: Date; power: number }>>();
  for (const s of powerSamples) {
    const key = new Date(s.timestamp).toISOString().slice(0, 10);
    const arr = byDay.get(key) ?? [];
    arr.push(s);
    byDay.set(key, arr);
  }
  const baseByDay = new Map<string, number>();
  for (const [day, arr] of byDay) {
    if (arr.length < MIN_SAMPLES_PER_DAY) continue;
    baseByDay.set(day, percentile10(arr.map(s => s.power).sort((a, b) => a - b)));
  }
  const daysWithData = baseByDay.size;

  // Integrate measured energy, split above-base energy by hour-of-day.
  let totalMeasuredWh = 0;
  let eveningAboveBaseWh = 0;
  let daytimeAboveBaseWh = 0;
  const dailyTotals: number[] = [];

  for (const [day, arr] of byDay) {
    const baseP = baseByDay.get(day);
    if (baseP === undefined) continue;
    let dayWh = 0;
    for (let i = 1; i < arr.length; i++) {
      const a = arr[i - 1];
      const b = arr[i];
      const dtMs = new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      if (dtMs <= 0 || dtMs > GAP_CAP_MS) continue;
      const wh = (a.power * dtMs) / 3600000;
      dayWh += wh;
      const hour = new Date(a.timestamp).getUTCHours();
      const aboveBase = Math.max(0, (a.power - baseP) * dtMs / 3600000);
      if (hour >= EVENING_START_HOUR && hour < EVENING_END_HOUR) eveningAboveBaseWh += aboveBase;
      else daytimeAboveBaseWh += aboveBase;
    }
    dailyTotals.push(dayWh);
    totalMeasuredWh += dayWh;
  }

  const baseWh = [...baseByDay.values()].reduce((s, p) => s + p * 24, 0);

  // Cap the base estimate so classes never exceed measured energy (long gaps
  // mean the base wasn't truly held for the whole day).
  const cappedBaseWh = Math.min(baseWh, Math.max(0, totalMeasuredWh - eveningAboveBaseWh - daytimeAboveBaseWh));

  // Confidence: coverage (days with usable data / span) * stability
  // (1 - coefficient of variation of daily totals).
  const coverage = Math.min(1, daysWithData / spanDays);
  let stability = 1;
  if (dailyTotals.length >= 2) {
    const mean = dailyTotals.reduce((s, v) => s + v, 0) / dailyTotals.length;
    if (mean > 0) {
      const variance = dailyTotals.reduce((s, v) => s + (v - mean) ** 2, 0) / dailyTotals.length;
      const cv = Math.sqrt(variance) / mean;
      stability = Math.max(0, 1 - cv);
    }
  }
  const confidenceMilli = Math.round(coverage * stability * 1000);

  const mk = (applianceClass: ApplianceClass, wh: number): ApplianceEstimateResult => ({
    applianceClass,
    estimatedWh: Math.round(wh),
    shareMilliPct: totalMeasuredWh > 0 ? Math.round((wh / totalMeasuredWh) * 100000) : 0,
    confidenceMilli,
    method: METHOD,
  });

  const estimates = [
    mk('always_on_base', cappedBaseWh),
    mk('evening_peak_block', eveningAboveBaseWh),
    mk('daytime_variable_above_base', daytimeAboveBaseWh),
  ];

  // Persist one row per class for this computation window.
  const persistedEstimateIds: number[] = [];
  for (const e of estimates) {
    const insert = await db.insert(applianceEstimates).values({
      userId,
      assetId,
      windowStart: new Date(first!),
      windowEnd: new Date(last!),
      spanDays10: Math.round(spanDays * 10),
      applianceClass: e.applianceClass,
      estimatedWh: e.estimatedWh,
      shareMilliPct: e.shareMilliPct,
      confidenceMilli: e.confidenceMilli,
      method: e.method,
      sampleCount: powerSamples.length,
    }).returning({ id: applianceEstimates.id });
    const id = Number(insert[0].id ?? 0);
    if (id) persistedEstimateIds.push(id);
  }

  return {
    ...base,
    insufficientData: false,
    reason: null,
    totalMeasuredWh: Math.round(totalMeasuredWh),
    daysWithData,
    estimates,
    persistedEstimateIds,
  };
}

export async function listApplianceEstimates(assetId: number, userId: number, limit: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  return db
    .select()
    .from(applianceEstimates)
    .where(and(eq(applianceEstimates.assetId, assetId), eq(applianceEstimates.userId, userId)))
    .orderBy(desc(applianceEstimates.createdAt))
    .limit(limit);
}
