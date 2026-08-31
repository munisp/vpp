/**
 * Outage Risk Forecast
 *
 * Scores an asset's near-term outage risk from three real, recorded signals:
 *
 *  1. anomaly     — the asset's own grid_anomaly_scores over the window:
 *                   component = min(100, mean combinedScore * 20), so the
 *                   platform's own 'critical' severity threshold (score 5)
 *                   maps to 100. Null when the asset has no scored windows.
 *  2. telemetryGap — a site that stops reporting is the strongest observed
 *                   outage precursor: component = min(100, gapRatio * 500),
 *                   i.e. 20% of the window dark maps to 100.
 *  3. gridQuality — fraction of voltage/frequency samples outside tolerance
 *                   of the asset's OWN observed nominal (median), so no
 *                   nameplate voltage or grid frequency is assumed:
 *                   component = violation rate in percent, capped at 100.
 *
 * The composite `scoreMilli` is the equal-weight mean of the available
 * components (* 1000). When there is not enough telemetry to say anything
 * (< MIN_SPAN_DAYS span or < MIN_SAMPLES samples) or no component has data,
 * the persisted row carries insufficientData:true, a null score and a reason.
 * No probability is ever invented.
 */

import { and, desc, eq, gte } from 'drizzle-orm';
import { getDb } from '../db';
import { assets, telemetry } from '../../drizzle/schema';
import { gridAnomalyScores } from '../../drizzle/grid-intel-schema';
import { outageRiskScores } from '../../drizzle/innov3-planning-schema';

const WINDOW_DAYS = 30;
const MIN_SPAN_DAYS = 7;
const MIN_SAMPLES = 50;
const GAP_THRESHOLD_MS = 2 * 60 * 60 * 1000; // >2h between samples = a gap
const VOLTAGE_TOLERANCE = 0.10; // ±10% of the asset's own median voltage
const FREQUENCY_TOLERANCE = 0.01; // ±1% of the asset's own median frequency
const MAX_SAMPLES = 200000;

export interface OutageRiskResult {
  scoreId: number | null;
  assetId: number;
  assetName: string;
  insufficientData: boolean;
  reason: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  spanDays: number | null;
  telemetrySampleCount: number;
  /** 0-100, null when insufficient. */
  score: number | null;
  components: {
    anomaly: number | null;
    telemetryGap: number | null;
    gridQuality: number | null;
  };
  evidence: {
    anomalyScoreCount: number;
    severeAnomalyCount: number;
    gapRatioMilli: number | null;
    voltageSampleCount: number;
    voltageViolationCount: number | null;
    frequencySampleCount: number;
    frequencyViolationCount: number | null;
  };
  method: string;
  computedAt: string;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

export async function computeOutageRisk(assetId: number, userId: number): Promise<OutageRiskResult> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  if (!asset) throw new Error('ASSET_NOT_FOUND');
  if (asset.userId !== userId) throw new Error('ASSET_NOT_OWNED');

  const now = new Date();
  const windowStart = new Date(now.getTime() - WINDOW_DAYS * 86400000);

  const samples = await db
    .select({ timestamp: telemetry.timestamp, voltage: telemetry.voltage, frequency: telemetry.frequency })
    .from(telemetry)
    .where(and(eq(telemetry.assetId, assetId), gte(telemetry.timestamp, windowStart)))
    .orderBy(telemetry.timestamp)
    .limit(MAX_SAMPLES);

  const anomalyRows = await db
    .select({ combinedScoreMilli: gridAnomalyScores.combinedScoreMilli, severity: gridAnomalyScores.severity })
    .from(gridAnomalyScores)
    .where(and(eq(gridAnomalyScores.assetId, assetId), gte(gridAnomalyScores.windowStart, windowStart)));

  const computedAt = now.toISOString();
  const first = samples[0]?.timestamp ?? null;
  const last = samples[samples.length - 1]?.timestamp ?? null;
  const spanDays = first && last ? (new Date(last).getTime() - new Date(first).getTime()) / 86400000 : 0;

  const severeAnomalyCount = anomalyRows.filter(r => r.severity === 'high' || r.severity === 'critical').length;

  const finish = async (r: OutageRiskResult): Promise<OutageRiskResult> => {
    const insert = await db.insert(outageRiskScores).values({
      assetId,
      userId,
      windowStart: r.windowStart ? new Date(r.windowStart) : windowStart,
      windowEnd: r.windowEnd ? new Date(r.windowEnd) : now,
      spanDays10: Math.round((r.spanDays ?? 0) * 10),
      telemetrySampleCount: r.telemetrySampleCount,
      anomalyComponentMilli: r.components.anomaly !== null ? Math.round(r.components.anomaly * 1000) : null,
      telemetryGapComponentMilli: r.components.telemetryGap !== null ? Math.round(r.components.telemetryGap * 1000) : null,
      gridQualityComponentMilli: r.components.gridQuality !== null ? Math.round(r.components.gridQuality * 1000) : null,
      scoreMilli: r.score !== null ? Math.round(r.score * 1000) : null,
      anomalyScoreCount: r.evidence.anomalyScoreCount,
      severeAnomalyCount: r.evidence.severeAnomalyCount,
      gapRatioMilli: r.evidence.gapRatioMilli,
      voltageSampleCount: r.evidence.voltageSampleCount,
      voltageViolationCount: r.evidence.voltageViolationCount,
      frequencySampleCount: r.evidence.frequencySampleCount,
      frequencyViolationCount: r.evidence.frequencyViolationCount,
      insufficientData: r.insufficientData,
      reason: r.reason,
    }).returning({ id: outageRiskScores.id });
    r.scoreId = Number(insert[0].id ?? 0) || null;
    return r;
  };

  const base: OutageRiskResult = {
    scoreId: null,
    assetId: asset.id,
    assetName: asset.name,
    insufficientData: true,
    reason: null,
    windowStart: first ? new Date(first).toISOString() : null,
    windowEnd: last ? new Date(last).toISOString() : null,
    spanDays: first && last ? Math.round(spanDays * 10) / 10 : null,
    telemetrySampleCount: samples.length,
    score: null,
    components: { anomaly: null, telemetryGap: null, gridQuality: null },
    evidence: {
      anomalyScoreCount: anomalyRows.length,
      severeAnomalyCount,
      gapRatioMilli: null,
      voltageSampleCount: 0,
      voltageViolationCount: null,
      frequencySampleCount: 0,
      frequencyViolationCount: null,
    },
    method: 'equal_weight_mean(anomaly:min(100,meanCombinedScore*20), gap:min(100,gapRatio*500), quality:violationRatePct)',
    computedAt,
  };

  if (samples.length === 0) {
    return finish({ ...base, reason: `No telemetry recorded for this asset in the last ${WINDOW_DAYS} days.` });
  }
  if (samples.length < MIN_SAMPLES || spanDays < MIN_SPAN_DAYS) {
    return finish({
      ...base,
      reason: samples.length < MIN_SAMPLES
        ? `Only ${samples.length} telemetry samples in the last ${WINDOW_DAYS} days; at least ${MIN_SAMPLES} are required.`
        : `Telemetry spans ${spanDays.toFixed(1)} days; at least ${MIN_SPAN_DAYS} days are required.`,
    });
  }

  // --- Component 1: anomaly history ---------------------------------------
  let anomalyComponent: number | null = null;
  const scoredRows = anomalyRows.filter(r => r.combinedScoreMilli !== null);
  if (scoredRows.length > 0) {
    const meanScore = scoredRows.reduce((s, r) => s + r.combinedScoreMilli!, 0) / scoredRows.length / 1000;
    anomalyComponent = Math.min(100, Math.round(meanScore * 20 * 10) / 10);
  }

  // --- Component 2: telemetry gaps -----------------------------------------
  let gapMs = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = new Date(samples[i].timestamp).getTime() - new Date(samples[i - 1].timestamp).getTime();
    if (dt > GAP_THRESHOLD_MS) gapMs += dt;
  }
  const observedMs = new Date(last!).getTime() - new Date(first!).getTime();
  const gapRatio = observedMs > 0 ? gapMs / observedMs : 0;
  const gapComponent = Math.min(100, Math.round(gapRatio * 500 * 10) / 10);

  // --- Component 3: grid quality vs the asset's own nominal ----------------
  const voltages = samples.map(s => s.voltage).filter((v): v is number => v !== null);
  const frequencies = samples.map(s => s.frequency).filter((v): v is number => v !== null);
  const nominalVoltage = median(voltages);
  const nominalFrequency = median(frequencies);
  const voltageViolations = nominalVoltage !== null && nominalVoltage > 0
    ? voltages.filter(v => Math.abs(v - nominalVoltage) / nominalVoltage > VOLTAGE_TOLERANCE).length
    : null;
  const frequencyViolations = nominalFrequency !== null && nominalFrequency > 0
    ? frequencies.filter(f => Math.abs(f - nominalFrequency) / nominalFrequency > FREQUENCY_TOLERANCE).length
    : null;

  let qualityComponent: number | null = null;
  const qualityRates: number[] = [];
  if (voltageViolations !== null && voltages.length > 0) qualityRates.push((voltageViolations / voltages.length) * 100);
  if (frequencyViolations !== null && frequencies.length > 0) qualityRates.push((frequencyViolations / frequencies.length) * 100);
  if (qualityRates.length > 0) {
    qualityComponent = Math.min(100, Math.round((qualityRates.reduce((s, v) => s + v, 0) / qualityRates.length) * 10) / 10);
  }

  // --- Composite: equal-weight mean of available components -----------------
  const available = [anomalyComponent, gapComponent, qualityComponent].filter((c): c is number => c !== null);
  if (available.length === 0) {
    return finish({ ...base, reason: 'No component signal had any data (no anomaly scores, no gap history, no voltage/frequency samples).' });
  }
  const score = Math.round((available.reduce((s, v) => s + v, 0) / available.length) * 10) / 10;

  return finish({
    ...base,
    insufficientData: false,
    reason: null,
    score,
    components: { anomaly: anomalyComponent, telemetryGap: gapComponent, gridQuality: qualityComponent },
    evidence: {
      anomalyScoreCount: anomalyRows.length,
      severeAnomalyCount,
      gapRatioMilli: Math.round(gapRatio * 1000),
      voltageSampleCount: voltages.length,
      voltageViolationCount: voltageViolations,
      frequencySampleCount: frequencies.length,
      frequencyViolationCount: frequencyViolations,
    },
  });
}

export async function listOutageRiskScores(assetId: number, userId: number, limit: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  return db
    .select()
    .from(outageRiskScores)
    .where(and(eq(outageRiskScores.assetId, assetId), eq(outageRiskScores.userId, userId)))
    .orderBy(desc(outageRiskScores.computedAt))
    .limit(limit);
}

/** Fleet-wide view for operators: most recent scores, highest first. */
export async function listFleetOutageRisk(limit: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  return db
    .select()
    .from(outageRiskScores)
    .orderBy(desc(outageRiskScores.scoreMilli))
    .limit(limit);
}
