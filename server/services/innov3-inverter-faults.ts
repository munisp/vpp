/**
 * Solar Inverter Fault Detector (innovation 13)
 *
 * Three rules over real data, each of which stays silent when its evidence
 * is too thin:
 *
 *  - zero_output_daylight: the asset's own clear-sky expectation for the
 *    day (computed by server/services/solar-yield.ts from solar geometry and
 *    the asset's real capacity) was positive, the cumulative telemetry
 *    counter did not advance at all, AND the asset was actually reporting
 *    during daylight hours (enough samples in the 09:00-15:00 UTC window).
 *    A day with sparse telemetry is not a fault — it is unknown, and no
 *    fault is raised.
 *  - error_code_reported: an inverter-type device attached to the asset
 *    logged real error entries in device_logs within the lookback window.
 *    The evidence is the actual log ids and messages.
 *  - sustained_underperformance: solar-yield's learned performance-ratio
 *    analysis (median PR over the recent window below the asset's own
 *    median-minus-2*MAD threshold) flags the asset, and only when the
 *    history is sufficient (>= 7 days with positive PR) — with insufficient
 *    history this rule cannot fire.
 *
 * Dedup: at most one open fault per (asset, type) exists; re-detection
 * while one is open is a no-op and reported as such.
 */

import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { getDb } from '../db';
import { assets, deviceLogs, devices, telemetry } from '../../drizzle/schema';
import {
  inverterFaults,
  type InverterFault,
} from '../../drizzle/innov3-market-schema';
import { getPerformanceRatio } from './solar-yield';

/** How many recent completed UTC days the zero-output rule examines. */
const ZERO_OUTPUT_WINDOW_DAYS = 3;
/** Minimum telemetry samples in a day before that day can be evidence. */
const MIN_DAY_SAMPLES = 12;
/** Minimum samples inside the 09:00-15:00 UTC daylight window. */
const MIN_DAYLIGHT_SAMPLES = 3;
/** How far back the error-code rule looks. */
const ERROR_LOOKBACK_HOURS = 24;
const MAX_EVIDENCE_LOGS = 20;

function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  return db;
}

async function hasOpenFault(assetId: number, faultType: 'zero_output_daylight' | 'error_code_reported' | 'sustained_underperformance'): Promise<boolean> {
  const db = await requireDb();
  const [row] = await db
    .select({ id: inverterFaults.id })
    .from(inverterFaults)
    .where(and(eq(inverterFaults.assetId, assetId), eq(inverterFaults.faultType, faultType), eq(inverterFaults.status, 'open')))
    .limit(1);
  return !!row;
}

export interface DetectionOutcome {
  assetId: number;
  userId: number;
  raised: InverterFault[];
  skipped: Array<{ faultType: string; reason: string }>;
}

/**
 * Run all three rules against one solar asset and insert any new faults.
 * Throws ASSET_NOT_FOUND / ASSET_NOT_SOLAR.
 */
export async function detectFaultsForAsset(assetId: number, now: Date = new Date()): Promise<DetectionOutcome> {
  const db = await requireDb();

  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  if (!asset) throw new Error('ASSET_NOT_FOUND');
  if (asset.assetType !== 'solar') throw new Error('ASSET_NOT_SOLAR');

  const raised: InverterFault[] = [];
  const skipped: DetectionOutcome['skipped'] = [];

  // ---- Rule: error_code_reported --------------------------------------
  if (await hasOpenFault(assetId, 'error_code_reported')) {
    skipped.push({ faultType: 'error_code_reported', reason: 'open fault already exists' });
  } else {
    const attachedDevices = await db
      .select({ id: devices.id, deviceId: devices.deviceId, deviceType: devices.deviceType })
      .from(devices)
      .where(and(eq(devices.assetId, assetId), eq(devices.deviceType, 'inverter')));

    if (attachedDevices.length === 0) {
      skipped.push({ faultType: 'error_code_reported', reason: 'no inverter device attached to this asset' });
    } else {
      const since = new Date(now.getTime() - ERROR_LOOKBACK_HOURS * 3600 * 1000);
      const logs = await db
        .select({ id: deviceLogs.id, deviceId: deviceLogs.deviceId, message: deviceLogs.message, createdAt: deviceLogs.createdAt })
        .from(deviceLogs)
        .where(and(inArray(deviceLogs.deviceId, attachedDevices.map((d) => d.id)), eq(deviceLogs.eventType, 'error'), gte(deviceLogs.createdAt, since)))
        .orderBy(desc(deviceLogs.createdAt))
        .limit(100);

      if (logs.length === 0) {
        skipped.push({ faultType: 'error_code_reported', reason: 'no error logs in lookback window' });
      } else {
        const [fault] = await db
          .insert(inverterFaults)
          .values({
            assetId,
            userId: asset.userId,
            faultType: 'error_code_reported',
            detectedAt: now,
            evidence: {
              lookbackHours: ERROR_LOOKBACK_HOURS,
              devices: attachedDevices.map((d) => ({ id: d.id, deviceId: d.deviceId })),
              errorCount: logs.length,
              logIds: logs.slice(0, MAX_EVIDENCE_LOGS).map((l) => l.id),
              recentMessages: logs.slice(0, 5).map((l) => l.message),
              firstErrorAt: logs[logs.length - 1].createdAt.toISOString(),
              lastErrorAt: logs[0].createdAt.toISOString(),
            },
          })
          .returning();
        raised.push(fault);
      }
    }
  }

  // ---- Rules over performance-ratio analysis ---------------------------
  let pr: Awaited<ReturnType<typeof getPerformanceRatio>> | null = null;
  try {
    pr = await getPerformanceRatio(assetId);
  } catch (error) {
    skipped.push({
      faultType: 'zero_output_daylight',
      reason: `performance-ratio analysis unavailable: ${error instanceof Error ? error.message : 'unknown error'}`,
    });
    skipped.push({ faultType: 'sustained_underperformance', reason: 'performance-ratio analysis unavailable' });
  }

  if (pr) {
    // ---- Rule: zero_output_daylight ------------------------------------
    if (await hasOpenFault(assetId, 'zero_output_daylight')) {
      skipped.push({ faultType: 'zero_output_daylight', reason: 'open fault already exists' });
    } else {
      const todayKey = utcDayKey(now);
      const cutoffKey = utcDayKey(new Date(now.getTime() - ZERO_OUTPUT_WINDOW_DAYS * 86400000));
      // Completed days only: today's partial reading is not evidence.
      const candidateDays = pr.daily.filter((d) => d.date >= cutoffKey && d.date < todayKey && d.clearSkyWh > 0 && d.actualWh === 0);

      const evidencedDays: Array<Record<string, unknown>> = [];
      for (const day of candidateDays) {
        const dayStart = new Date(`${day.date}T00:00:00Z`);
        const dayEnd = new Date(dayStart.getTime() + 86400000);
        const [counts] = await db
          .select({
            sampleCount: sql<number>`COUNT(*)`,
            daylightSampleCount: sql<number>`COUNT(*) FILTER (WHERE EXTRACT(HOUR FROM ${telemetry.timestamp} AT TIME ZONE 'UTC') BETWEEN 9 AND 14)`,
          })
          .from(telemetry)
          .where(and(eq(telemetry.assetId, assetId), gte(telemetry.timestamp, dayStart), sql`${telemetry.timestamp} < ${dayEnd}`));

        const sampleCount = Number(counts?.sampleCount ?? 0);
        const daylightSampleCount = Number(counts?.daylightSampleCount ?? 0);
        // Low evidence: the meter barely reported — we do not know whether
        // the inverter produced nothing or simply was not heard from.
        if (sampleCount < MIN_DAY_SAMPLES || daylightSampleCount < MIN_DAYLIGHT_SAMPLES) continue;

        evidencedDays.push({
          date: day.date,
          actualWh: day.actualWh,
          expectedClearSkyWh: day.clearSkyWh,
          sampleCount,
          daylightSampleCount,
        });
      }

      if (evidencedDays.length === 0) {
        skipped.push({
          faultType: 'zero_output_daylight',
          reason: 'no completed day with positive clear-sky expectation, zero generation and sufficient telemetry coverage',
        });
      } else {
        const [fault] = await db
          .insert(inverterFaults)
          .values({
            assetId,
            userId: asset.userId,
            faultType: 'zero_output_daylight',
            detectedAt: now,
            evidence: {
              windowDays: ZERO_OUTPUT_WINDOW_DAYS,
              minDaySamples: MIN_DAY_SAMPLES,
              minDaylightSamples: MIN_DAYLIGHT_SAMPLES,
              locationSource: pr.locationSource,
              days: evidencedDays,
            },
          })
          .returning();
        raised.push(fault);
      }
    }

    // ---- Rule: sustained_underperformance -------------------------------
    if (await hasOpenFault(assetId, 'sustained_underperformance')) {
      skipped.push({ faultType: 'sustained_underperformance', reason: 'open fault already exists' });
    } else if (pr.insufficientHistory) {
      // Low evidence by definition: fewer than 7 days of positive PR.
      skipped.push({ faultType: 'sustained_underperformance', reason: 'insufficient history to learn a threshold' });
    } else if (!pr.underperforming) {
      skipped.push({ faultType: 'sustained_underperformance', reason: 'recent performance ratio within learned bounds' });
    } else {
      const [fault] = await db
        .insert(inverterFaults)
        .values({
          assetId,
          userId: asset.userId,
          faultType: 'sustained_underperformance',
          detectedAt: now,
          evidence: {
            historyDays: pr.historyDays,
            daysWithData: pr.daysWithData,
            learnedDerate: pr.learnedDerate,
            learnedThreshold: pr.learnedThreshold,
            recentPerformanceRatio: pr.recentPerformanceRatio,
            locationSource: pr.locationSource,
          },
        })
        .returning();
      raised.push(fault);
    }
  }

  return { assetId, userId: asset.userId, raised, skipped };
}

/** Run detection over every solar asset the caller owns. */
export async function detectFaultsForUser(userId: number): Promise<DetectionOutcome[]> {
  const db = await requireDb();
  const solarAssets = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.userId, userId), eq(assets.assetType, 'solar')));
  const outcomes: DetectionOutcome[] = [];
  for (const a of solarAssets) {
    outcomes.push(await detectFaultsForAsset(a.id));
  }
  return outcomes;
}

export async function listFaults(
  userId: number,
  opts: { limit: number; status?: 'open' | 'acknowledged' | 'resolved' }
): Promise<InverterFault[]> {
  const db = await requireDb();
  const where = opts.status
    ? and(eq(inverterFaults.userId, userId), eq(inverterFaults.status, opts.status))
    : eq(inverterFaults.userId, userId);
  return db.select().from(inverterFaults).where(where).orderBy(desc(inverterFaults.detectedAt)).limit(opts.limit);
}

/**
 * open -> acknowledged. Conditional update enforces ownership and the
 * transition; anything else throws FAULT_NOT_OPEN.
 */
export async function acknowledgeFault(userId: number, faultId: number): Promise<InverterFault> {
  const db = await requireDb();
  const updated = await db
    .update(inverterFaults)
    .set({ status: 'acknowledged', acknowledgedAt: new Date() })
    .where(and(eq(inverterFaults.id, faultId), eq(inverterFaults.userId, userId), eq(inverterFaults.status, 'open')))
    .returning();
  if (updated.length === 0) throw new Error('FAULT_NOT_OPEN');
  return updated[0];
}

/**
 * open|acknowledged -> resolved, with an optional note. Conditional update
 * enforces ownership and a non-terminal starting state.
 */
export async function resolveFault(userId: number, faultId: number, note?: string): Promise<InverterFault> {
  const db = await requireDb();
  const updated = await db
    .update(inverterFaults)
    .set({ status: 'resolved', resolvedAt: new Date(), resolutionNote: note ?? null })
    .where(and(eq(inverterFaults.id, faultId), eq(inverterFaults.userId, userId), inArray(inverterFaults.status, ['open', 'acknowledged'])))
    .returning();
  if (updated.length === 0) throw new Error('FAULT_NOT_OPEN');
  return updated[0];
}
