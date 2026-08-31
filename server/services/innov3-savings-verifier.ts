/**
 * M&V Savings Verifier Service
 *
 * IPMVP Option C-style whole-asset comparison: a baseline period vs a
 * reporting period, both measured strictly from the asset's real telemetry.
 *
 * Method (label stored on every row: 'ipmvp_option_c_unadjusted_wh_per_day'):
 *  - Energy per period is integrated from real power samples over real
 *    intervals, capping gaps > 1h (same convention as battery-health.ts) so
 *    missing data is never silently integrated across.
 *  - Coverage is the fraction of hourly buckets in the period containing at
 *    least one real sample. Both periods must reach MIN_COVERAGE (80%) or
 *    the verification is REFUSED and persisted with verifiable:false and
 *    the reason — a refused verification is auditable, not invisible.
 *  - Because the periods may differ in length, comparison is normalised to
 *    Wh/day. savingsWh = baselineWhPerDay * reportingDays - reportingWh,
 *    i.e. what the reporting period would have consumed at the baseline
 *    rate minus what it actually did. There is no weather/occupancy
 *    adjustment — the method label says "unadjusted" because it is.
 */

import { and, asc, desc, eq, gte, lt } from 'drizzle-orm';
import { getDb } from '../db';
import { assets, telemetry } from '../../drizzle/schema';
import {
  savingsVerifications,
  SavingsVerification,
} from '../../drizzle/innov3-fieldops-schema';

const METHOD = 'ipmvp_option_c_unadjusted_wh_per_day';
const MIN_COVERAGE = 0.8; // fraction of hourly buckets that must contain real samples
const GAP_CAP_MS = 60 * 60 * 1000; // don't integrate power across gaps > 1h
const MAX_SAMPLES = 200000;

export interface VerifySavingsInput {
  assetId: number;
  baselineStart: Date;
  baselineEnd: Date;
  reportingStart: Date;
  reportingEnd: Date;
}

export interface SavingsVerificationResult {
  verification: SavingsVerification;
  verifiable: boolean;
  reason: string | null;
  method: string;
  baseline: PeriodStats;
  reporting: PeriodStats;
  savingsWh: number | null;
  savingsWhPerDay: number | null;
}

interface PeriodStats {
  start: string;
  end: string;
  durationHours: number;
  sampleCount: number;
  coveredHours: number;
  totalHours: number;
  coverageRatio: number;
  energyWh: number | null;
  whPerDay: number | null;
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error('DATABASE_UNAVAILABLE');
  return db;
}

/** Measure one period from real telemetry. */
async function measurePeriod(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  assetId: number,
  start: Date,
  end: Date
): Promise<PeriodStats> {
  const durationMs = end.getTime() - start.getTime();
  const totalHours = Math.max(1, Math.round(durationMs / 3600000));

  const samples = await db
    .select({ timestamp: telemetry.timestamp, power: telemetry.power })
    .from(telemetry)
    .where(and(eq(telemetry.assetId, assetId), gte(telemetry.timestamp, start), lt(telemetry.timestamp, end)))
    .orderBy(asc(telemetry.timestamp))
    .limit(MAX_SAMPLES);

  const coveredBuckets = new Set<number>();
  for (const s of samples) {
    coveredBuckets.add(Math.floor((new Date(s.timestamp).getTime() - start.getTime()) / 3600000));
  }
  const coveredHours = coveredBuckets.size;
  const coverageRatio = coveredHours / totalHours;

  // Integrate power over time, capping gaps so outages aren't smoothed over.
  let energyWh: number | null = null;
  const powerSamples = samples.filter(s => s.power !== null);
  if (powerSamples.length >= 2) {
    let ws = 0;
    for (let i = 1; i < powerSamples.length; i++) {
      const dtMs = new Date(powerSamples[i].timestamp).getTime() - new Date(powerSamples[i - 1].timestamp).getTime();
      if (dtMs <= 0 || dtMs > GAP_CAP_MS) continue; // skip gaps: unknown is unknown
      ws += ((powerSamples[i - 1].power! + powerSamples[i].power!) / 2) * (dtMs / 1000);
    }
    energyWh = Math.round(ws / 3600);
  }

  const durationDays = durationMs / 86400000;
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    durationHours: Math.round(durationMs / 360000) / 10,
    sampleCount: samples.length,
    coveredHours,
    totalHours,
    coverageRatio: Math.round(coverageRatio * 10000) / 10000,
    energyWh,
    whPerDay: energyWh !== null ? energyWh / durationDays : null,
  };
}

export async function verifySavings(userId: number, input: VerifySavingsInput): Promise<SavingsVerificationResult> {
  const db = await requireDb();
  const [asset] = await db.select().from(assets).where(eq(assets.id, input.assetId)).limit(1);
  if (!asset) throw new Error('ASSET_NOT_FOUND');
  if (asset.userId !== userId) throw new Error('ASSET_NOT_OWNED');

  if (!(input.baselineEnd > input.baselineStart) || !(input.reportingEnd > input.reportingStart)) {
    throw new Error('INVALID_PERIOD');
  }
  if (input.reportingStart < input.baselineEnd) {
    throw new Error('PERIODS_OVERLAP');
  }

  const baseline = await measurePeriod(db, input.assetId, input.baselineStart, input.baselineEnd);
  const reporting = await measurePeriod(db, input.assetId, input.reportingStart, input.reportingEnd);

  let verifiable = true;
  let reason: string | null = null;
  if (baseline.coverageRatio < MIN_COVERAGE) {
    verifiable = false;
    reason = `Baseline coverage ${(baseline.coverageRatio * 100).toFixed(1)}% (${baseline.coveredHours}/${baseline.totalHours} hours with samples) is below the required ${MIN_COVERAGE * 100}%.`;
  } else if (reporting.coverageRatio < MIN_COVERAGE) {
    verifiable = false;
    reason = `Reporting coverage ${(reporting.coverageRatio * 100).toFixed(1)}% (${reporting.coveredHours}/${reporting.totalHours} hours with samples) is below the required ${MIN_COVERAGE * 100}%.`;
  } else if (baseline.energyWh === null || reporting.energyWh === null) {
    verifiable = false;
    reason = 'Fewer than two power samples in a period; energy cannot be integrated.';
  }

  let savingsWh: number | null = null;
  let savingsWhPerDay: number | null = null;
  if (verifiable) {
    const reportingDays = (input.reportingEnd.getTime() - input.reportingStart.getTime()) / 86400000;
    savingsWh = Math.round(baseline.whPerDay! * reportingDays - reporting.energyWh!);
    savingsWhPerDay = Math.round((baseline.whPerDay! - reporting.whPerDay!) * 1000) / 1000;
  }

  const inserted = await db
    .insert(savingsVerifications)
    .values({
      assetId: input.assetId,
      userId,
      method: METHOD,
      baselineStart: input.baselineStart,
      baselineEnd: input.baselineEnd,
      reportingStart: input.reportingStart,
      reportingEnd: input.reportingEnd,
      baselineCoveragePct100: Math.round(baseline.coverageRatio * 10000),
      reportingCoveragePct100: Math.round(reporting.coverageRatio * 10000),
      baselineSampleCount: baseline.sampleCount,
      reportingSampleCount: reporting.sampleCount,
      baselineEnergyWh: baseline.energyWh,
      reportingEnergyWh: reporting.energyWh,
      baselineWhPerDayMilli: baseline.whPerDay !== null ? Math.round(baseline.whPerDay * 1000) : null,
      reportingWhPerDayMilli: reporting.whPerDay !== null ? Math.round(reporting.whPerDay * 1000) : null,
      savingsWh,
      savingsWhPerDayMilli: savingsWhPerDay !== null ? Math.round(savingsWhPerDay * 1000) : null,
      verifiable,
      reason,
    })
    .returning();

  return {
    verification: inserted[0],
    verifiable,
    reason,
    method: METHOD,
    baseline,
    reporting,
    savingsWh,
    savingsWhPerDay,
  };
}

export async function listVerifications(
  userId: number,
  assetId: number,
  limit = 20
): Promise<SavingsVerification[]> {
  const db = await requireDb();
  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  if (!asset) throw new Error('ASSET_NOT_FOUND');
  if (asset.userId !== userId) throw new Error('ASSET_NOT_OWNED');
  return db
    .select()
    .from(savingsVerifications)
    .where(eq(savingsVerifications.assetId, assetId))
    .orderBy(desc(savingsVerifications.createdAt))
    .limit(Math.min(limit, 100));
}
