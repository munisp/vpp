/**
 * Non-Technical-Loss (theft/bypass) Detection (feature 13)
 *
 * Divergence analysis per asset:
 *  - Metered consumption (real telemetry energy deltas) is compared against
 *    billed consumption (billings.consumptionKwh) over each billing period.
 *  - The per-period billed/metered ratio is scored with a z-score against the
 *    asset owner's own history; a statistically significant drop
 *    (billed << metered, |z| >= Z_THRESHOLD) raises a divergence flag.
 *  - Corroboration: the bypass signature — sustained near-zero power with
 *    normal grid voltage (a meter bypass keeps voltage but kills current).
 *
 * Human-in-the-loop by design: flags are created as `suspected` and can only
 * move suspected -> under_review -> confirmed | cleared via investigateFlag.
 * The engine NEVER auto-confirms an accusation.
 */

import { eq, and, gte, lte, desc, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "../db";
import { assets, telemetry, billings } from "../../drizzle/schema";
import { ntlFlags, type NtlFlag } from "../../drizzle/trust-access-schema";

/** Minimum |z-score| of the billed/metered ratio to raise a divergence flag. */
const Z_THRESHOLD = 2;
/** Minimum billing periods required before statistics are meaningful. */
const MIN_PERIODS = 3;
/** Bypass-signature telemetry lookback. */
const BYPASS_LOOKBACK_DAYS = 7;
/** "Near-zero consumption" threshold (watts). */
const NEAR_ZERO_POWER_W = 5;
/** Normal grid voltage band (telemetry stores millivolts). */
const NORMAL_VOLTAGE_MIN_MV = 180_000;
const NORMAL_VOLTAGE_MAX_MV = 260_000;

export type NtlStatus = "suspected" | "under_review" | "confirmed" | "cleared";

interface PeriodComparison {
  periodStart: string;
  periodEnd: string;
  billedWh: number;
  meteredWh: number;
  ratio: number | null; // billed / metered (null when metered == 0)
}

export interface NtlAnalysisResult {
  assetId: number;
  userId: number;
  analyzedPeriods: number;
  insufficientHistory: boolean;
  latestRatio: number | null;
  zScore: number | null;
  divergenceDetected: boolean;
  bypassSignature: {
    evaluated: boolean;
    samples: number;
    nearZeroPowerPct: number | null;
    normalVoltagePct: number | null;
    detected: boolean;
  };
  riskScore: number; // 0-100
  flag: NtlFlag | null; // persisted flag when one was created/updated
  periods: PeriodComparison[];
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1));
}

/** Metered Wh within a window from cumulative telemetry energy deltas. */
async function getMeteredWh(assetId: number, start: Date, end: Date): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // First reading at/before window start and last reading at/before window end
  const startRows = await db
    .select({ energy: telemetry.energy })
    .from(telemetry)
    .where(and(eq(telemetry.assetId, assetId), lte(telemetry.timestamp, start), isNotNull(telemetry.energy)))
    .orderBy(desc(telemetry.timestamp))
    .limit(1);
  const endRows = await db
    .select({ energy: telemetry.energy })
    .from(telemetry)
    .where(and(eq(telemetry.assetId, assetId), lte(telemetry.timestamp, end), isNotNull(telemetry.energy)))
    .orderBy(desc(telemetry.timestamp))
    .limit(1);

  const startEnergy = startRows[0]?.energy;
  const endEnergy = endRows[0]?.energy;
  if (startEnergy == null || endEnergy == null || endEnergy < startEnergy) return 0;
  return endEnergy - startEnergy;
}

/** Bypass signature: near-zero power with normal voltage over the lookback. */
async function evaluateBypassSignature(assetId: number): Promise<NtlAnalysisResult["bypassSignature"]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const since = new Date(Date.now() - BYPASS_LOOKBACK_DAYS * 86400000);
  const rows = await db
    .select({ power: telemetry.power, voltage: telemetry.voltage })
    .from(telemetry)
    .where(and(
      eq(telemetry.assetId, assetId),
      gte(telemetry.timestamp, since),
      isNotNull(telemetry.power),
      isNotNull(telemetry.voltage)
    ))
    .orderBy(desc(telemetry.timestamp))
    .limit(5000);

  if (rows.length < 24) {
    return { evaluated: false, samples: rows.length, nearZeroPowerPct: null, normalVoltagePct: null, detected: false };
  }

  const nearZero = rows.filter((r) => (r.power ?? 0) <= NEAR_ZERO_POWER_W).length;
  const normalVoltage = rows.filter(
    (r) => (r.voltage ?? 0) >= NORMAL_VOLTAGE_MIN_MV && (r.voltage ?? 0) <= NORMAL_VOLTAGE_MAX_MV
  ).length;
  const nearZeroPowerPct = nearZero / rows.length;
  const normalVoltagePct = normalVoltage / rows.length;

  return {
    evaluated: true,
    samples: rows.length,
    nearZeroPowerPct,
    normalVoltagePct,
    detected: nearZeroPowerPct >= 0.85 && normalVoltagePct >= 0.9,
  };
}

/**
 * Run the full NTL analysis for one asset and persist/update its flag.
 */
export async function runNtlAnalysis(assetId: number): Promise<NtlAnalysisResult> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const assetRows = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  const asset = assetRows[0];
  if (!asset) throw new Error(`Asset ${assetId} not found`);

  // Billing is account-level: compare the user's billed consumption against
  // energy metered at this asset over each billing period.
  const userBillings = await db
    .select()
    .from(billings)
    .where(and(eq(billings.userId, asset.userId), inArray(billings.status, ["issued", "paid", "overdue"])))
    .orderBy(billings.periodStart);

  const periods: PeriodComparison[] = [];
  for (const b of userBillings) {
    const meteredWh = await getMeteredWh(assetId, new Date(b.periodStart), new Date(b.periodEnd));
    const billedWh = (b.consumptionKwh ?? 0) * 1000;
    periods.push({
      periodStart: new Date(b.periodStart).toISOString().slice(0, 10),
      periodEnd: new Date(b.periodEnd).toISOString().slice(0, 10),
      billedWh,
      meteredWh,
      ratio: meteredWh > 0 ? billedWh / meteredWh : null,
    });
  }

  const usable = periods.filter((p) => p.ratio != null);
  const insufficientHistory = usable.length < MIN_PERIODS;

  let zScore: number | null = null;
  let divergenceDetected = false;
  const latest = usable[usable.length - 1];

  if (!insufficientHistory && latest) {
    const history = usable.slice(0, -1).map((p) => p.ratio as number);
    const m = mean(history);
    const sd = stddev(history);
    if (sd > 0) {
      zScore = ((latest.ratio as number) - m) / sd;
      divergenceDetected = zScore <= -Z_THRESHOLD;
    } else {
      // Zero-variance history: any drop is anomalous but not quantifiable
      divergenceDetected = (latest.ratio as number) < m * 0.5;
    }
  }

  const bypass = await evaluateBypassSignature(assetId);

  // Composite risk score 0-100 from the two independent signals.
  let riskScore = 0;
  if (divergenceDetected) riskScore += 50 + Math.min(30, Math.round(Math.abs(zScore ?? Z_THRESHOLD) * 5));
  if (bypass.detected) riskScore += 20;
  riskScore = Math.min(100, riskScore);

  let flag: NtlFlag | null = null;

  if (divergenceDetected || bypass.detected) {
    const evidence = {
      accountLevelBilling: true,
      zThreshold: Z_THRESHOLD,
      zScore,
      latestRatio: latest?.ratio ?? null,
      divergenceDetected,
      bypassSignature: bypass,
      periods,
      computedAt: new Date().toISOString(),
    };
    const windowStart = usable.length > 0 ? new Date(usable[0].periodStart) : new Date();
    const windowEnd = latest ? new Date(latest.periodEnd) : new Date();
    const flagType = divergenceDetected && bypass.detected ? "combined"
      : bypass.detected ? "bypass_signature"
      : "divergence";

    // Upsert against any still-open flag for this asset (no duplicate pile-up)
    const openFlags = await db
      .select()
      .from(ntlFlags)
      .where(and(eq(ntlFlags.assetId, assetId), inArray(ntlFlags.status, ["suspected", "under_review"])))
      .orderBy(desc(ntlFlags.createdAt))
      .limit(1);

    if (openFlags.length > 0) {
      await db
        .update(ntlFlags)
        .set({ evidence: JSON.stringify(evidence), riskScore, flagType, windowEnd })
        .where(eq(ntlFlags.id, openFlags[0].id));
      const refreshed = await db.select().from(ntlFlags).where(eq(ntlFlags.id, openFlags[0].id)).limit(1);
      flag = refreshed[0] ?? null;
    } else {
      const insert = await db.insert(ntlFlags).values({
        assetId,
        userId: asset.userId,
        flagType,
        status: "suspected",
        riskScore,
        evidence: JSON.stringify(evidence),
        windowStart,
        windowEnd,
      });
      const created = await db.select().from(ntlFlags).where(eq(ntlFlags.id, Number(insert[0].insertId))).limit(1);
      flag = created[0] ?? null;
    }
  }

  return {
    assetId,
    userId: asset.userId,
    analyzedPeriods: usable.length,
    insufficientHistory,
    latestRatio: latest?.ratio ?? null,
    zScore,
    divergenceDetected,
    bypassSignature: bypass,
    riskScore,
    flag,
    periods,
  };
}

/** Run analysis across all meter/generator/solar assets (admin sweep). */
export async function runFleetNtlAnalysis(): Promise<{ analyzed: number; flagged: number; errors: Array<{ assetId: number; error: string }> }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const meteredAssets = await db
    .select({ id: assets.id })
    .from(assets)
    .where(inArray(assets.assetType, ["meter", "solar", "generator"]));

  let flagged = 0;
  const errors: Array<{ assetId: number; error: string }> = [];
  for (const a of meteredAssets) {
    try {
      const result = await runNtlAnalysis(a.id);
      if (result.flag) flagged++;
    } catch (error: any) {
      errors.push({ assetId: a.id, error: error?.message || String(error) });
    }
  }
  return { analyzed: meteredAssets.length, flagged, errors };
}

/** Admin: list flags with filters. */
export async function getNtlFlags(filters: {
  status?: NtlStatus;
  assetId?: number;
  userId?: number;
  limit: number;
}): Promise<NtlFlag[]> {
  const db = await getDb();
  if (!db) return [];

  const conditions = [];
  if (filters.status) conditions.push(eq(ntlFlags.status, filters.status));
  if (filters.assetId) conditions.push(eq(ntlFlags.assetId, filters.assetId));
  if (filters.userId) conditions.push(eq(ntlFlags.userId, filters.userId));

  return db
    .select()
    .from(ntlFlags)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(ntlFlags.createdAt))
    .limit(filters.limit);
}

const ALLOWED_TRANSITIONS: Record<NtlStatus, NtlStatus[]> = {
  suspected: ["under_review", "cleared"],
  under_review: ["confirmed", "cleared"],
  confirmed: [],
  cleared: [],
};

/**
 * Admin: transition a flag through the investigation workflow.
 * Terminal states (confirmed/cleared) cannot be left — no silent re-opening.
 */
export async function investigateFlag(params: {
  flagId: number;
  newStatus: NtlStatus;
  investigatorUserId: number;
  notes?: string;
}): Promise<NtlFlag> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = await db.select().from(ntlFlags).where(eq(ntlFlags.id, params.flagId)).limit(1);
  const flag = rows[0];
  if (!flag) throw new Error(`NTL flag ${params.flagId} not found`);

  const allowed = ALLOWED_TRANSITIONS[flag.status];
  if (!allowed.includes(params.newStatus)) {
    throw new Error(
      `Invalid NTL status transition: ${flag.status} -> ${params.newStatus}. Allowed: ${allowed.length > 0 ? allowed.join(", ") : "none (terminal state)"}`
    );
  }

  await db
    .update(ntlFlags)
    .set({
      status: params.newStatus,
      investigatedBy: params.investigatorUserId,
      investigatedAt: new Date(),
      resolutionNotes: params.notes ?? null,
    })
    .where(eq(ntlFlags.id, params.flagId));

  const updated = await db.select().from(ntlFlags).where(eq(ntlFlags.id, params.flagId)).limit(1);
  return updated[0];
}

/**
 * Current risk score for an asset: the score of its latest open flag if one
 * exists, otherwise a fresh read-only analysis (no flag is persisted for a
 * clean result).
 */
export async function getAssetRiskScore(assetId: number): Promise<{
  assetId: number;
  riskScore: number;
  source: "open_flag" | "fresh_analysis";
  openFlagId: number | null;
  insufficientHistory: boolean;
  analyzedPeriods: number;
  latestRatio: number | null;
  divergenceDetected: boolean;
  bypassSignature: NtlAnalysisResult["bypassSignature"];
}> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Signals default to "not evaluated" rather than to a benign-looking value,
  // so a caller can never read an unevaluated check as a clean result.
  const unevaluatedBypass: NtlAnalysisResult["bypassSignature"] = {
    evaluated: false,
    samples: 0,
    nearZeroPowerPct: null,
    normalVoltagePct: null,
    detected: false,
  };

  const open = await db
    .select()
    .from(ntlFlags)
    .where(and(eq(ntlFlags.assetId, assetId), inArray(ntlFlags.status, ["suspected", "under_review"])))
    .orderBy(desc(ntlFlags.createdAt))
    .limit(1);

  if (open.length > 0) {
    // Report the evidence recorded when the flag was raised; a missing or
    // unparseable evidence blob is surfaced as unevaluated, not as clean.
    let evidence: any = null;
    try {
      evidence = open[0].evidence ? JSON.parse(open[0].evidence) : null;
    } catch (error) {
      console.error(`[NtlDetection] Flag ${open[0].id} has unparseable evidence:`, error);
    }

    return {
      assetId,
      riskScore: open[0].riskScore,
      source: "open_flag",
      openFlagId: open[0].id,
      insufficientHistory: evidence?.periods == null,
      analyzedPeriods: Array.isArray(evidence?.periods) ? evidence.periods.length : 0,
      latestRatio: typeof evidence?.latestRatio === "number" ? evidence.latestRatio : null,
      divergenceDetected: evidence?.divergenceDetected === true,
      bypassSignature: evidence?.bypassSignature ?? unevaluatedBypass,
    };
  }

  const analysis = await runNtlAnalysis(assetId);
  return {
    assetId,
    riskScore: analysis.riskScore,
    source: "fresh_analysis",
    openFlagId: analysis.flag?.id ?? null,
    insufficientHistory: analysis.insufficientHistory,
    analyzedPeriods: analysis.analyzedPeriods,
    latestRatio: analysis.latestRatio,
    divergenceDetected: analysis.divergenceDetected,
    bypassSignature: analysis.bypassSignature,
  };
}

/** NTL summary for the regulator compliance report (feature 15). */
export async function getNtlSummaryForPeriod(periodStart: Date, periodEnd: Date): Promise<{
  totalFlags: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
}> {
  const db = await getDb();
  if (!db) return { totalFlags: 0, byStatus: {}, byType: {} };

  const rows = await db
    .select({ status: ntlFlags.status, flagType: ntlFlags.flagType, count: sql<number>`COUNT(*)` })
    .from(ntlFlags)
    .where(and(gte(ntlFlags.createdAt, periodStart), lte(ntlFlags.createdAt, periodEnd)))
    .groupBy(ntlFlags.status, ntlFlags.flagType);

  const byStatus: Record<string, number> = {};
  const byType: Record<string, number> = {};
  let totalFlags = 0;
  for (const r of rows) {
    const c = Number(r.count);
    totalFlags += c;
    byStatus[r.status] = (byStatus[r.status] ?? 0) + c;
    byType[r.flagType] = (byType[r.flagType] ?? 0) + c;
  }
  return { totalFlags, byStatus, byType };
}
