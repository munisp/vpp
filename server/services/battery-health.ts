/**
 * Battery Health Analytics Service
 *
 * Computes per-asset battery health strictly from real telemetry:
 *  - Full-cycle equivalents from cumulative |dSoC| (SoC stored as percent*100,
 *    so one full cycle = 20_000 raw units of traversal: FCE = sum|dSoC|/20000).
 *  - Round-trip efficiency from energy moved while SoC rises (charging) vs
 *    falls (discharging), integrating real power samples over real intervals.
 *    This avoids assuming a power sign convention.
 *  - Estimated SoH relative to the battery's OWN best observed weekly
 *    efficiency (self-referential baseline — no nameplate fabrication).
 *  - Degradation trend = least-squares slope of weekly efficiencies.
 *  - Warranty-risk flag against the industry-standard 80% SoH threshold,
 *    including a 52-week projection from the measured slope.
 *
 * Thin telemetry (< 7 days of span or < 2 SoC samples) returns null fields
 * with insufficientData: true. Nothing is invented.
 */

import { and, asc, desc, eq } from 'drizzle-orm';
import { getDb } from '../db';
import { assets, telemetry } from '../../drizzle/schema';
import { batteryHealthSnapshots } from '../../drizzle/innovations-schema';

const MIN_SPAN_DAYS = 7;
const GAP_CAP_MS = 60 * 60 * 1000; // don't integrate power across gaps > 1h
const MIN_WEEKLY_ENERGY_WH = 100; // weekly RTE requires >=100 Wh each way to be meaningful
const WARRANTY_SOH_THRESHOLD_PCT = 80; // standard battery warranty SoH floor
const MAX_SAMPLES = 200000;

export interface BatteryHealthResult {
  assetId: number;
  assetName: string;
  capacityWh: number;
  insufficientData: boolean;
  reason: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  spanDays: number | null;
  sampleCount: number;
  socSampleCount: number;
  fullCycleEquivalents: number | null;
  chargeEnergyWh: number | null;
  dischargeEnergyWh: number | null;
  roundTripEfficiencyPct: number | null;
  estimatedSohPct: number | null;
  weeklyDegradationSlopePctPerWeek: number | null;
  weeklyEfficiencies: Array<{ weekStart: string; efficiencyPct: number; chargeWh: number; dischargeWh: number }>;
  warrantyRisk: boolean;
  warrantyRiskReasons: string[];
  snapshotId: number | null;
  computedAt: string;
}

interface Sample {
  timestamp: Date;
  power: number | null;
  stateOfCharge: number | null;
}

function startOfWeek(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = x.getUTCDay(); // 0=Sun
  x.setUTCDate(x.getUTCDate() - day);
  return x;
}

export async function computeBatteryHealth(assetId: number, userId: number): Promise<BatteryHealthResult> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  if (!asset) throw new Error('ASSET_NOT_FOUND');
  if (asset.userId !== userId) throw new Error('ASSET_NOT_OWNED');
  if (asset.assetType !== 'battery') throw new Error('ASSET_NOT_BATTERY');

  const samples: Sample[] = await db
    .select({ timestamp: telemetry.timestamp, power: telemetry.power, stateOfCharge: telemetry.stateOfCharge })
    .from(telemetry)
    .where(eq(telemetry.assetId, assetId))
    .orderBy(asc(telemetry.timestamp))
    .limit(MAX_SAMPLES);

  const computedAt = new Date().toISOString();
  const base: Omit<BatteryHealthResult, 'insufficientData' | 'reason'> = {
    assetId: asset.id,
    assetName: asset.name,
    capacityWh: asset.capacity,
    windowStart: null,
    windowEnd: null,
    spanDays: null,
    sampleCount: samples.length,
    socSampleCount: 0,
    fullCycleEquivalents: null,
    chargeEnergyWh: null,
    dischargeEnergyWh: null,
    roundTripEfficiencyPct: null,
    estimatedSohPct: null,
    weeklyDegradationSlopePctPerWeek: null,
    weeklyEfficiencies: [],
    warrantyRisk: false,
    warrantyRiskReasons: [],
    snapshotId: null,
    computedAt,
  };

  const socSamples = samples.filter(s => s.stateOfCharge !== null);
  const first = samples[0]?.timestamp ?? null;
  const last = samples[samples.length - 1]?.timestamp ?? null;
  const spanDays = first && last ? (new Date(last).getTime() - new Date(first).getTime()) / 86400000 : 0;

  const finish = async (partial: BatteryHealthResult): Promise<BatteryHealthResult> => {
    // Persist a snapshot of exactly what was computed (nulls included).
    try {
      const insert = await db.insert(batteryHealthSnapshots).values({
        assetId: asset.id,
        userId,
        windowStart: partial.windowStart ? new Date(partial.windowStart) : null,
        windowEnd: partial.windowEnd ? new Date(partial.windowEnd) : null,
        sampleCount: partial.sampleCount,
        fullCycleEquivalentsMilli: partial.fullCycleEquivalents !== null ? Math.round(partial.fullCycleEquivalents * 1000) : null,
        roundTripEfficiencyPct100: partial.roundTripEfficiencyPct !== null ? Math.round(partial.roundTripEfficiencyPct * 100) : null,
        estimatedSohPct100: partial.estimatedSohPct !== null ? Math.round(partial.estimatedSohPct * 100) : null,
        weeklyDegradationSlopePct100: partial.weeklyDegradationSlopePctPerWeek !== null ? Math.round(partial.weeklyDegradationSlopePctPerWeek * 100) : null,
        chargeEnergyWh: partial.chargeEnergyWh,
        dischargeEnergyWh: partial.dischargeEnergyWh,
        warrantyRisk: partial.warrantyRisk,
        warrantyRiskReasons: partial.warrantyRiskReasons,
        insufficientData: partial.insufficientData,
      });
      partial.snapshotId = Number((insert as any)[0]?.insertId ?? (insert as any).insertId ?? 0) || null;
    } catch (error) {
      console.error('[BatteryHealth] Failed to persist snapshot:', error);
    }
    return partial;
  };

  if (samples.length === 0) {
    return finish({ ...base, insufficientData: true, reason: 'No telemetry recorded for this asset.' });
  }
  if (socSamples.length < 2 || spanDays < MIN_SPAN_DAYS) {
    return finish({
      ...base,
      insufficientData: true,
      reason: socSamples.length < 2
        ? `Only ${socSamples.length} state-of-charge sample(s) available; at least 2 spanning ${MIN_SPAN_DAYS} days are required.`
        : `Telemetry spans ${spanDays.toFixed(1)} days; at least ${MIN_SPAN_DAYS} days are required.`,
      windowStart: first ? new Date(first).toISOString() : null,
      windowEnd: last ? new Date(last).toISOString() : null,
      spanDays: Math.round(spanDays * 10) / 10,
      socSampleCount: socSamples.length,
    });
  }

  // --- Full-cycle equivalents from cumulative |dSoC| ---------------------
  // stateOfCharge is percent*100; a full cycle traverses 200% (100% up +
  // 100% down) = 20_000 raw units.
  let socTraversal = 0;
  for (let i = 0; i < socSamples.length - 1; i++) {
    socTraversal += Math.abs(socSamples[i + 1].stateOfCharge! - socSamples[i].stateOfCharge!);
  }
  const fullCycleEquivalents = Math.round((socTraversal / 20000) * 1000) / 1000;

  // --- Charge / discharge energy via SoC direction + power integration ---
  // Energy moved while SoC rises counts as charge input; while SoC falls, as
  // discharge output. Uses real sample intervals; gaps > 1h are excluded.
  let chargeEnergyWh = 0;
  let dischargeEnergyWh = 0;
  const weekly = new Map<string, { chargeWh: number; dischargeWh: number }>();

  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    if (a.power === null || a.stateOfCharge === null || b.stateOfCharge === null) continue;
    const dtMs = new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    if (dtMs <= 0 || dtMs > GAP_CAP_MS) continue;
    const dSoc = b.stateOfCharge - a.stateOfCharge;
    if (dSoc === 0) continue;
    const wh = Math.abs((a.power * dtMs) / 3600000);
    const weekKey = startOfWeek(new Date(a.timestamp)).toISOString();
    const bucket = weekly.get(weekKey) ?? { chargeWh: 0, dischargeWh: 0 };
    if (dSoc > 0) {
      chargeEnergyWh += wh;
      bucket.chargeWh += wh;
    } else {
      dischargeEnergyWh += wh;
      bucket.dischargeWh += wh;
    }
    weekly.set(weekKey, bucket);
  }

  chargeEnergyWh = Math.round(chargeEnergyWh);
  dischargeEnergyWh = Math.round(dischargeEnergyWh);

  const roundTripEfficiencyPct =
    chargeEnergyWh > 0 && dischargeEnergyWh > 0
      ? Math.round((dischargeEnergyWh / chargeEnergyWh) * 10000) / 100
      : null;

  // --- Weekly efficiencies, SoH estimate, degradation slope --------------
  const weeklyEfficiencies = [...weekly.entries()]
    .filter(([, w]) => w.chargeWh >= MIN_WEEKLY_ENERGY_WH && w.dischargeWh >= MIN_WEEKLY_ENERGY_WH)
    .map(([weekStart, w]) => ({
      weekStart,
      efficiencyPct: Math.round((w.dischargeWh / w.chargeWh) * 10000) / 100,
      chargeWh: Math.round(w.chargeWh),
      dischargeWh: Math.round(w.dischargeWh),
    }))
    .sort((x, y) => x.weekStart.localeCompare(y.weekStart));

  let estimatedSohPct: number | null = null;
  let weeklySlope: number | null = null;
  const warrantyRiskReasons: string[] = [];

  if (weeklyEfficiencies.length >= 2) {
    const best = Math.max(...weeklyEfficiencies.map(w => w.efficiencyPct));
    const recent = weeklyEfficiencies[weeklyEfficiencies.length - 1].efficiencyPct;
    if (best > 0) {
      estimatedSohPct = Math.min(100, Math.round((recent / best) * 10000) / 100);
    }

    // Least-squares linear fit of weekly efficiency vs week index.
    const n = weeklyEfficiencies.length;
    const xs = weeklyEfficiencies.map((_, i) => i);
    const ys = weeklyEfficiencies.map(w => w.efficiencyPct);
    const xMean = xs.reduce((s, v) => s + v, 0) / n;
    const yMean = ys.reduce((s, v) => s + v, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - xMean) * (ys[i] - yMean);
      den += (xs[i] - xMean) ** 2;
    }
    weeklySlope = den > 0 ? Math.round((num / den) * 100) / 100 : null;
  }

  // --- Warranty-risk flag -------------------------------------------------
  let warrantyRisk = false;
  if (estimatedSohPct !== null && estimatedSohPct < WARRANTY_SOH_THRESHOLD_PCT) {
    warrantyRisk = true;
    warrantyRiskReasons.push(
      `Estimated SoH ${estimatedSohPct}% is below the ${WARRANTY_SOH_THRESHOLD_PCT}% warranty threshold (relative to this battery's best observed weekly efficiency).`
    );
  }
  if (estimatedSohPct !== null && weeklySlope !== null && weeklySlope < 0) {
    const projected = estimatedSohPct + weeklySlope * 52;
    if (projected < WARRANTY_SOH_THRESHOLD_PCT) {
      warrantyRisk = true;
      warrantyRiskReasons.push(
        `At the measured degradation rate of ${weeklySlope}% per week, projected SoH in 52 weeks is ${Math.round(projected * 100) / 100}% — below the ${WARRANTY_SOH_THRESHOLD_PCT}% warranty threshold.`
      );
    }
  }
  if (fullCycleEquivalents !== null && spanDays >= MIN_SPAN_DAYS && fullCycleEquivalents / (spanDays / 7) > 7) {
    // More than one full-cycle equivalent per day on average — real usage signal.
    warrantyRiskReasons.push(
      `High cycling intensity: ${fullCycleEquivalents} full-cycle equivalents over ${Math.round(spanDays)} days (>1 cycle/day average accelerates wear).`
    );
  }

  return finish({
    ...base,
    insufficientData: false,
    reason: null,
    windowStart: new Date(first!).toISOString(),
    windowEnd: new Date(last!).toISOString(),
    spanDays: Math.round(spanDays * 10) / 10,
    socSampleCount: socSamples.length,
    fullCycleEquivalents,
    chargeEnergyWh,
    dischargeEnergyWh,
    roundTripEfficiencyPct,
    estimatedSohPct,
    weeklyDegradationSlopePctPerWeek: weeklySlope,
    weeklyEfficiencies,
    warrantyRisk,
    warrantyRiskReasons,
  });
}

export async function listSnapshots(assetId: number, userId: number, limit: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  return db
    .select()
    .from(batteryHealthSnapshots)
    .where(and(eq(batteryHealthSnapshots.assetId, assetId), eq(batteryHealthSnapshots.userId, userId)))
    .orderBy(desc(batteryHealthSnapshots.computedAt))
    .limit(limit);
}
