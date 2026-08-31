/**
 * Demand-Charge Guardian (C&I)
 *
 * Watches an asset's rolling 15/30-minute demand, computed from real power
 * telemetry, against the user's contracted demand threshold, and writes an
 * alert row when the *projected* next window exceeds it.
 *
 * Projection method `rolling_window_linear_trend`: average power over each
 * of the trailing windows, then one-window linear extrapolation
 * (projected = last + (last - previous)). It is a deterministic
 * extrapolation of observed averages — not a probability — and the method is
 * labelled on every alert row.
 *
 * The contracted threshold is a user setting: it is supplied on the first
 * check for an asset and persisted on the alert rows; later checks may omit
 * it and reuse the most recent contracted value. With no threshold and no
 * telemetry, the check returns explicit unavailable states:
 *  - available:false, reason 'no_threshold'  (never configured)
 *  - available:false, reason 'no_telemetry'  (nothing to measure)
 */

import { and, asc, desc, eq, gte } from 'drizzle-orm';
import { getDb } from '../db';
import { assets, telemetry } from '../../drizzle/schema';
import { demandChargeAlerts } from '../../drizzle/innov3-planning-schema';

const PROJECTION_METHOD = 'rolling_window_linear_trend';
const MIN_SAMPLES_PER_WINDOW = 2;
const MAX_SAMPLES = 100000;

export type DemandGuardianUnavailableReason = 'no_threshold' | 'no_telemetry';

export interface DemandCheckResult {
  assetId: number;
  assetName: string;
  available: boolean;
  unavailableReason: DemandGuardianUnavailableReason | null;
  windowMinutes: number;
  thresholdKw10: number | null;
  windowStart: string | null;
  windowEnd: string | null;
  sampleCount: number;
  /** Observed average demand over the trailing window, kW * 10. */
  observedWindowAvgKw10: number | null;
  /** Projected next-window demand, kW * 10; null when <2 windows of data. */
  projectedPeakKw10: number | null;
  exceedsThreshold: boolean;
  alertId: number | null;
  projectionMethod: string;
  computedAt: string;
}

export async function checkDemand(
  userId: number,
  input: { assetId: number; windowMinutes: 15 | 30; thresholdKw10?: number },
): Promise<DemandCheckResult> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const [asset] = await db.select().from(assets).where(eq(assets.id, input.assetId)).limit(1);
  if (!asset) throw new Error('ASSET_NOT_FOUND');
  if (asset.userId !== userId) throw new Error('ASSET_NOT_OWNED');

  // Contracted threshold: explicit input wins; otherwise reuse the most
  // recent contracted value recorded for this asset.
  let thresholdKw10 = input.thresholdKw10 ?? null;
  if (thresholdKw10 === null) {
    const [last] = await db
      .select({ thresholdKw10: demandChargeAlerts.thresholdKw10 })
      .from(demandChargeAlerts)
      .where(eq(demandChargeAlerts.assetId, asset.id))
      .orderBy(desc(demandChargeAlerts.createdAt))
      .limit(1);
    thresholdKw10 = last?.thresholdKw10 ?? null;
  }

  const computedAt = new Date().toISOString();
  const base: DemandCheckResult = {
    assetId: asset.id,
    assetName: asset.name,
    available: false,
    unavailableReason: null,
    windowMinutes: input.windowMinutes,
    thresholdKw10,
    windowStart: null,
    windowEnd: null,
    sampleCount: 0,
    observedWindowAvgKw10: null,
    projectedPeakKw10: null,
    exceedsThreshold: false,
    alertId: null,
    projectionMethod: PROJECTION_METHOD,
    computedAt,
  };

  if (thresholdKw10 === null || thresholdKw10 <= 0) {
    return { ...base, unavailableReason: 'no_threshold' };
  }

  const windowMs = input.windowMinutes * 60000;
  const since = new Date(Date.now() - 3 * windowMs);
  const samples = await db
    .select({ timestamp: telemetry.timestamp, power: telemetry.power })
    .from(telemetry)
    .where(and(eq(telemetry.assetId, asset.id), gte(telemetry.timestamp, since)))
    .orderBy(asc(telemetry.timestamp))
    .limit(MAX_SAMPLES);

  const powerSamples = samples.filter(s => s.power !== null) as Array<{ timestamp: Date; power: number }>;
  if (powerSamples.length === 0) {
    return { ...base, unavailableReason: 'no_telemetry' };
  }

  // Window averages, anchored at the latest sample and stepping backwards.
  const endMs = new Date(powerSamples[powerSamples.length - 1].timestamp).getTime();
  const windowAvgsW: Array<{ start: Date; end: Date; avgW: number; n: number }> = [];
  for (let k = 0; k < 3; k++) {
    const wEnd = endMs - k * windowMs;
    const wStart = wEnd - windowMs;
    const inWindow = powerSamples.filter(s => {
      const t = new Date(s.timestamp).getTime();
      return t > wStart && t <= wEnd;
    });
    if (inWindow.length >= MIN_SAMPLES_PER_WINDOW) {
      windowAvgsW.unshift({
        start: new Date(wStart),
        end: new Date(wEnd),
        avgW: inWindow.reduce((s, x) => s + x.power, 0) / inWindow.length,
        n: inWindow.length,
      });
    }
  }

  if (windowAvgsW.length === 0) {
    return { ...base, unavailableReason: 'no_telemetry' };
  }

  const latest = windowAvgsW[windowAvgsW.length - 1];
  const observedKw10 = Math.round((latest.avgW / 1000) * 10);

  // One-window linear extrapolation; needs two windows of real data.
  let projectedKw10: number | null = null;
  if (windowAvgsW.length >= 2) {
    const prev = windowAvgsW[windowAvgsW.length - 2];
    const projectedW = latest.avgW + (latest.avgW - prev.avgW);
    projectedKw10 = Math.round((Math.max(0, projectedW) / 1000) * 10);
  }

  const exceeds = projectedKw10 !== null && projectedKw10 > thresholdKw10;

  let alertId: number | null = null;
  if (exceeds) {
    const insert = await db.insert(demandChargeAlerts).values({
      userId,
      assetId: asset.id,
      windowMinutes: input.windowMinutes,
      thresholdKw10,
      windowStart: latest.start,
      windowEnd: latest.end,
      sampleCount: latest.n,
      observedWindowAvgKw10: observedKw10,
      projectedPeakKw10: projectedKw10!,
      projectedExcessKw10: projectedKw10! - thresholdKw10,
      projectionMethod: PROJECTION_METHOD,
      status: 'alert',
    }).returning({ id: demandChargeAlerts.id });
    alertId = Number(insert[0].id ?? 0) || null;
  }

  return {
    ...base,
    available: true,
    windowStart: latest.start.toISOString(),
    windowEnd: latest.end.toISOString(),
    sampleCount: powerSamples.length,
    observedWindowAvgKw10: observedKw10,
    projectedPeakKw10: projectedKw10,
    exceedsThreshold: exceeds,
    alertId,
  };
}

export async function listDemandChargeAlerts(userId: number, assetId: number | undefined, limit: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const where = assetId !== undefined
    ? and(eq(demandChargeAlerts.userId, userId), eq(demandChargeAlerts.assetId, assetId))
    : eq(demandChargeAlerts.userId, userId);
  return db.select().from(demandChargeAlerts).where(where).orderBy(desc(demandChargeAlerts.createdAt)).limit(limit);
}

/** Fleet-wide alert view for operators. */
export async function listAllDemandChargeAlerts(limit: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  return db.select().from(demandChargeAlerts).orderBy(desc(demandChargeAlerts.createdAt)).limit(limit);
}
