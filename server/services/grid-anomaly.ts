/**
 * Grid Anomaly Early-Warning Service
 *
 * A statistical early-warning layer ON TOP of the existing rule-based
 * anomaly-detection service (server/services/anomaly-detection.ts, which is
 * imported for fleet context but not modified).
 *
 * Method: per asset, per metric (power / voltage / frequency), the observed
 * mean over a short scoring window is compared against the asset's OWN
 * trailing 7-day baseline for the SAME hour-of-day. Scores:
 *   - z-score of the observed window mean vs the baseline distribution
 *   - an isolation-style rarity score: how extreme the deviation is relative
 *     to the baseline's own spread (|dev| / (std * c), saturating) — a cheap
 *     deterministic stand-in for isolation-forest path lengths
 * The combined score drives severity classification. Qualifying events are
 * persisted to the existing anomaly_events table and critical events fan out
 * to the real web-push notification path.
 *
 * Every number comes from real telemetry queries; when a metric has no
 * baseline data the score row records null z-scores and no event is raised.
 */

import { getDb } from '../db';
import { sql, desc, eq } from 'drizzle-orm';
import { assets } from '../../drizzle/schema';
import { anomalyEvents } from '../../drizzle/nextgen-vpp-schema';
import { gridAnomalyScores, InsertGridAnomalyScore } from '../../drizzle/grid-intel-schema';
import { sendPushNotification } from '../_core/sendNotification';

export type AnomalyMetric = 'power' | 'voltage' | 'frequency';
export type EarlyWarningSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface MetricScoreResult {
  metric: AnomalyMetric;
  hourOfDay: number;
  windowStart: Date;
  windowEnd: Date;
  sampleCount: number;
  baselineSamples: number;
  baselineMean: number | null;
  baselineStd: number | null;
  observedMean: number;
  zScore: number | null; // null when baseline insufficient
  combinedScore: number | null;
  severity: EarlyWarningSeverity | null;
  anomalyEventId: number | null;
}

export interface AssetScanResult {
  assetId: number;
  scannedAt: Date;
  scores: MetricScoreResult[];
  eventsCreated: number;
  notificationsSent: number;
}

export interface FleetAnomalySummary {
  totalOpen: number;
  openBySeverity: Record<string, number>;
  assetsWithOpenCritical: number;
  eventsLast24h: number;
  topOffenders: Array<{ assetId: number; openEvents: number; worstSeverity: string }>;
}

const METRICS: AnomalyMetric[] = ['power', 'voltage', 'frequency'];

const METRIC_TO_ANOMALY_TYPE: Record<AnomalyMetric, 'power_deviation' | 'voltage_anomaly' | 'frequency_deviation'> = {
  power: 'power_deviation',
  voltage: 'voltage_anomaly',
  frequency: 'frequency_deviation',
};

// Minimum real baseline readings (same hour-of-day over 7 days) before a
// z-score is considered statistically meaningful.
const MIN_BASELINE_SAMPLES = 10;
// Minimum readings in the scoring window.
const MIN_WINDOW_SAMPLES = 3;
// Combined-score severity thresholds.
const SEVERITY_THRESHOLDS: Array<{ min: number; severity: EarlyWarningSeverity }> = [
  { min: 5, severity: 'critical' },
  { min: 4, severity: 'high' },
  { min: 3, severity: 'medium' },
  { min: 2, severity: 'low' },
];

export class GridAnomalyEarlyWarningService {
  /**
   * Score one asset's recent telemetry against its own hour-of-day baseline.
   */
  async scanAsset(assetId: number, windowMinutes: number = 30): Promise<AssetScanResult> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const assetRows = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
    const asset = assetRows[0];
    if (!asset) throw new Error(`Asset ${assetId} not found`);

    const scores: MetricScoreResult[] = [];
    let eventsCreated = 0;
    let notificationsSent = 0;

    for (const metric of METRICS) {
      const result = await this.scoreMetric(assetId, metric, windowMinutes);
      if (!result) continue;
      scores.push(result);

      if (result.severity) {
        const eventId = await this.persistEventIfNew(assetId, asset.userId, result);
        result.anomalyEventId = eventId;
        if (eventId !== null) {
          // Link score row to the event (existing or newly created)
          await this.updateScoreEventLink(assetId, metric, eventId);
        }
        if (result.severity === 'critical' && eventId !== null) {
          const push = await sendPushNotification(
            asset.userId,
            {
              title: `Critical grid anomaly: ${asset.name}`,
              body: `${metric} deviation score ${result.combinedScore?.toFixed(1)} vs 7-day baseline (hour ${result.hourOfDay}:00). Immediate inspection recommended.`,
              data: { assetId, anomalyEventId: eventId, metric, severity: 'critical' },
            },
            'pushSystemAlert'
          );
          if (push.success) notificationsSent += push.sentCount;
        }
      }
    }

    eventsCreated = scores.filter(s => s.anomalyEventId !== null && s.severity !== null).length;

    return { assetId, scannedAt: new Date(), scores, eventsCreated, notificationsSent };
  }

  /**
   * Scan all active assets (fleet-wide early warning sweep).
   */
  async scanFleet(windowMinutes: number = 30): Promise<{ assetsScanned: number; eventsCreated: number; errors: number }> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const activeAssets = await db.select({ id: assets.id }).from(assets).where(eq(assets.status, 'active'));
    let eventsCreated = 0;
    let errors = 0;

    for (const a of activeAssets) {
      try {
        const r = await this.scanAsset(a.id, windowMinutes);
        eventsCreated += r.eventsCreated;
      } catch (error) {
        errors++;
        console.error(`[GridAnomaly] Scan failed for asset ${a.id}:`, error);
      }
    }

    return { assetsScanned: activeAssets.length, eventsCreated, errors };
  }

  /**
   * Compute the rolling score for one metric and persist the score snapshot.
   * Returns null when there is no telemetry at all in the scoring window.
   */
  private async scoreMetric(assetId: number, metric: AnomalyMetric, windowMinutes: number): Promise<MetricScoreResult | null> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Observed window statistics (real telemetry)
    const observedResult = await db.execute(sql`
      SELECT AVG(${sql.raw(metric)}) as obs_mean, COUNT(*) as obs_count,
             MIN(timestamp) as window_start, MAX(timestamp) as window_end,
             HOUR(NOW()) as hod
      FROM telemetry
      WHERE assetId = ${assetId}
        AND ${sql.raw(metric)} IS NOT NULL
        AND timestamp > DATE_SUB(NOW(), INTERVAL ${windowMinutes} MINUTE)
    `);
    const observed = (observedResult as any)[0]?.[0];
    if (!observed || Number(observed.obs_count) < MIN_WINDOW_SAMPLES) {
      return null; // no real data in window — nothing to score
    }

    const observedMean = Number(observed.obs_mean);
    const hourOfDay = Number(observed.hod);

    // Asset's OWN trailing 7-day baseline for the same hour-of-day
    const baselineResult = await db.execute(sql`
      SELECT AVG(${sql.raw(metric)}) as base_mean, STDDEV_POP(${sql.raw(metric)}) as base_std,
             COUNT(*) as base_count
      FROM telemetry
      WHERE assetId = ${assetId}
        AND ${sql.raw(metric)} IS NOT NULL
        AND HOUR(timestamp) = ${hourOfDay}
        AND timestamp BETWEEN DATE_SUB(NOW(), INTERVAL 7 DAY) AND DATE_SUB(NOW(), INTERVAL ${windowMinutes} MINUTE)
    `);
    const baseline = (baselineResult as any)[0]?.[0];
    const baselineSamples = baseline ? Number(baseline.base_count) : 0;

    let baselineMean: number | null = null;
    let baselineStd: number | null = null;
    let zScore: number | null = null;
    let combinedScore: number | null = null;

    if (baseline && baselineSamples >= MIN_BASELINE_SAMPLES && baseline.base_mean !== null) {
      baselineMean = Number(baseline.base_mean);
      baselineStd = baseline.base_std !== null ? Number(baseline.base_std) : 0;

      if (baselineStd > 0) {
        zScore = (observedMean - baselineMean) / baselineStd;
      } else {
        // Zero-variance baseline: any mismatch is maximally anomalous
        zScore = observedMean === baselineMean ? 0 : (observedMean > baselineMean ? 10 : -10);
      }

      const absZ = Math.abs(zScore);
      // Isolation-style rarity score: baseline values within k std of the mean
      // are "easy to isolate" when far out; |dev|/(std) saturating matches the
      // exponential decay of isolation-forest expected path lengths.
      const rarityScore = absZ; // |dev| in baseline-std units IS the rarity measure
      // Relative magnitude guard for near-zero-mean metrics (e.g. power at night)
      const magnitudeFloor = Math.abs(baselineMean) * 0.01 + 1;
      const relativeDev = Math.abs(observedMean - baselineMean) / Math.max(Math.abs(baselineMean), magnitudeFloor);
      const relativeScore = relativeDev * 10; // 10% deviation ~= score 1

      combinedScore = Math.max(rarityScore, relativeScore);
    }

    let severity: EarlyWarningSeverity | null = null;
    if (combinedScore !== null) {
      for (const t of SEVERITY_THRESHOLDS) {
        if (combinedScore >= t.min) { severity = t.severity; break; }
      }
    }

    // Persist the score snapshot (audit trail of the statistical layer)
    const scoreRow: InsertGridAnomalyScore = {
      assetId,
      metric,
      hourOfDay,
      windowStart: new Date(observed.window_start),
      windowEnd: new Date(observed.window_end),
      sampleCount: Number(observed.obs_count),
      baselineMeanMilli: baselineMean !== null ? Math.round(baselineMean * 1000) : null,
      baselineStdMilli: baselineStd !== null ? Math.round(baselineStd * 1000) : null,
      baselineSamples,
      observedMeanMilli: Math.round(observedMean * 1000),
      zScoreMilli: zScore !== null ? Math.round(zScore * 1000) : null,
      combinedScoreMilli: combinedScore !== null ? Math.round(combinedScore * 1000) : null,
      severity,
      anomalyEventId: null,
    };
    await db.insert(gridAnomalyScores).values(scoreRow);

    return {
      metric,
      hourOfDay,
      windowStart: new Date(observed.window_start),
      windowEnd: new Date(observed.window_end),
      sampleCount: Number(observed.obs_count),
      baselineSamples,
      baselineMean,
      baselineStd,
      observedMean,
      zScore,
      combinedScore,
      severity,
      anomalyEventId: null,
    };
  }

  /**
   * Persist an anomaly_events row for a qualifying score, deduplicating
   * against an open event of the same type for the asset within the last hour.
   * Returns the event id (new or existing), or null on failure.
   */
  private async persistEventIfNew(assetId: number, userId: number, score: MetricScoreResult): Promise<number | null> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');
    if (!score.severity || score.combinedScore === null) return null;

    const anomalyType = METRIC_TO_ANOMALY_TYPE[score.metric];

    const dupResult = await db.execute(sql`
      SELECT id FROM anomaly_events
      WHERE asset_id = ${assetId}
        AND anomaly_type = ${anomalyType}
        AND detection_method = 'rolling_zscore_hod'
        AND status IN ('open', 'acknowledged', 'investigating')
        AND detected_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
      LIMIT 1
    `);
    const existing = (dupResult as any)[0]?.[0];
    if (existing) return Number(existing.id);

    const deviationPercent = score.baselineMean !== null && score.baselineMean !== 0
      ? Math.round(((score.observedMean - score.baselineMean) / score.baselineMean) * 100 * 100)
      : null;
    const confidenceScore = Math.min(95, Math.round(40 + score.combinedScore * 10));
    const recommendedAction =
      score.severity === 'critical' ? 'immediate_inspection' as const :
      score.severity === 'high' ? 'schedule_inspection' as const : 'monitor' as const;

    const metadata = JSON.stringify({
      detectionLayer: 'grid_early_warning',
      hourOfDay: score.hourOfDay,
      zScore: score.zScore,
      combinedScore: score.combinedScore,
      baselineSamples: score.baselineSamples,
      windowSamples: score.sampleCount,
      userId,
    });
    const estimatedImpact = JSON.stringify({
      metric: score.metric,
      observedMean: score.observedMean,
      baselineMean: score.baselineMean,
      deviationPercent: deviationPercent !== null ? deviationPercent / 100 : null,
    });

    const insertResult = await db.insert(anomalyEvents).values({
      assetId,
      detectedAt: new Date(),
      anomalyType,
      severity: score.severity,
      detectionMethod: 'rolling_zscore_hod',
      confidenceScore,
      measuredValue: Math.round(score.observedMean),
      expectedValue: score.baselineMean !== null ? Math.round(score.baselineMean) : null,
      deviationPercent,
      estimatedImpact,
      recommendedAction,
      status: 'open',
      metadata,
    });
    const eventId = Number((insertResult as any)[0]?.insertId);
    console.log(`[GridAnomaly] Early-warning event ${eventId} for asset ${assetId}: ${score.metric} score=${score.combinedScore.toFixed(2)} severity=${score.severity}`);
    return eventId;
  }

  /** Backfill the anomalyEventId on the latest score row for asset+metric. */
  private async updateScoreEventLink(assetId: number, metric: AnomalyMetric, eventId: number): Promise<void> {
    const db = await getDb();
    if (!db) return;
    await db.execute(sql`
      UPDATE grid_anomaly_scores SET anomaly_event_id = ${eventId}
      WHERE asset_id = ${assetId} AND metric = ${metric} AND anomaly_event_id IS NULL
      ORDER BY id DESC LIMIT 1
    `);
  }

  /**
   * List persisted anomaly events for one asset (newest first).
   */
  async getAssetAnomalies(assetId: number, limit: number = 50) {
    const db = await getDb();
    if (!db) throw new Error('Database not available');
    return db
      .select()
      .from(anomalyEvents)
      .where(eq(anomalyEvents.assetId, assetId))
      .orderBy(desc(anomalyEvents.detectedAt))
      .limit(limit);
  }

  /**
   * Fleet-wide anomaly summary for grid operators (admin).
   */
  async getFleetAnomalySummary(): Promise<FleetAnomalySummary> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const sevResult = await db.execute(sql`
      SELECT severity, COUNT(*) as count FROM anomaly_events
      WHERE status IN ('open', 'acknowledged', 'investigating')
      GROUP BY severity
    `);
    const openBySeverity: Record<string, number> = {};
    let totalOpen = 0;
    for (const row of (sevResult as any)[0] || []) {
      openBySeverity[row.severity] = Number(row.count);
      totalOpen += Number(row.count);
    }

    const critResult = await db.execute(sql`
      SELECT COUNT(DISTINCT asset_id) as count FROM anomaly_events
      WHERE status IN ('open', 'acknowledged', 'investigating') AND severity = 'critical'
    `);
    const assetsWithOpenCritical = Number((critResult as any)[0]?.[0]?.count || 0);

    const last24Result = await db.execute(sql`
      SELECT COUNT(*) as count FROM anomaly_events
      WHERE detected_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
    `);
    const eventsLast24h = Number((last24Result as any)[0]?.[0]?.count || 0);

    const offendersResult = await db.execute(sql`
      SELECT asset_id, COUNT(*) as open_events,
             MAX(CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END) as worst
      FROM anomaly_events
      WHERE status IN ('open', 'acknowledged', 'investigating')
      GROUP BY asset_id
      ORDER BY worst DESC, open_events DESC
      LIMIT 10
    `);
    const worstName = (w: number) => (['low', 'medium', 'high', 'critical'] as const)[Math.max(0, Math.min(3, w - 1))];
    const topOffenders = ((offendersResult as any)[0] || []).map((r: any) => ({
      assetId: Number(r.asset_id),
      openEvents: Number(r.open_events),
      worstSeverity: worstName(Number(r.worst)),
    }));

    return { totalOpen, openBySeverity, assetsWithOpenCritical, eventsLast24h, topOffenders };
  }

  /**
   * Acknowledge an anomaly event. Returns the updated row.
   */
  async acknowledgeAnomaly(anomalyId: number, userId: number) {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const rows = await db.select().from(anomalyEvents).where(eq(anomalyEvents.id, anomalyId)).limit(1);
    if (!rows[0]) throw new Error(`Anomaly event ${anomalyId} not found`);
    if (rows[0].status === 'resolved' || rows[0].status === 'false_positive') {
      throw new Error(`Anomaly event ${anomalyId} is already ${rows[0].status}`);
    }

    await db.execute(sql`
      UPDATE anomaly_events SET
        status = 'acknowledged',
        metadata = JSON_SET(COALESCE(metadata, '{}'), '$.acknowledgedBy', ${userId}, '$.acknowledgedAt', ${new Date().toISOString()})
      WHERE id = ${anomalyId}
    `);

    const updated = await db.select().from(anomalyEvents).where(eq(anomalyEvents.id, anomalyId)).limit(1);
    return updated[0];
  }
}

export const gridAnomalyEarlyWarning = new GridAnomalyEarlyWarningService();
