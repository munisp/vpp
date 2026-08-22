/**
 * MLOps Pipeline Service
 * 
 * Manages ML model lifecycle including versioning, deployment,
 * drift detection, and automated retraining triggers.
 */

import { getDb } from '../db';
import { sql } from 'drizzle-orm';
import { createHash } from 'crypto';
import { kafkaPublisher } from '../integration/kafka-publisher';
import { redisCache } from './redis-cache';
import type { SqlRow } from '../sql-row';

// Types for MLOps
export interface ModelVersion {
  id: number;
  modelName: string;
  version: string;
  modelType: 'forecasting' | 'classification' | 'regression' | 'anomaly_detection' | 'optimization';
  framework: string | null;
  inputSchema: Record<string, any>;
  outputSchema: Record<string, any>;
  hyperparameters: Record<string, any>;
  trainingDataStart: Date | null;
  trainingDataEnd: Date | null;
  trainingSamples: number | null;
  validationMetrics: Record<string, number>;
  artifactPath: string | null;
  artifactHash: string | null;
  status: 'training' | 'validating' | 'staging' | 'production' | 'deprecated' | 'failed';
  deployedAt: Date | null;
  deprecatedAt: Date | null;
  createdAt: Date;
}

export interface DriftEvent {
  id: number;
  modelId: number;
  driftType: 'data_drift' | 'concept_drift' | 'prediction_drift' | 'performance_degradation';
  severity: 'low' | 'medium' | 'high' | 'critical';
  detectedAt: Date;
  metricName: string;
  baselineValue: number;
  currentValue: number;
  threshold: number;
  windowStart: Date;
  windowEnd: Date;
  affectedFeatures: string[];
  recommendedAction: string;
  actionTaken: string | null;
  resolvedAt: Date | null;
}

export interface RetrainingJob {
  id: number;
  modelId: number;
  jobId: string;
  triggerType: 'scheduled' | 'drift_detected' | 'manual' | 'performance_threshold';
  triggeredBy: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  trainingConfig: Record<string, any>;
  startedAt: Date | null;
  completedAt: Date | null;
  newModelVersion: string | null;
  metrics: Record<string, number> | null;
  errorMessage: string | null;
}

export interface ModelPerformanceMetrics {
  modelId: number;
  modelName: string;
  version: string;
  period: string;
  predictionCount: number;
  mae: number | null;
  rmse: number | null;
  mape: number | null;
  accuracy: number | null;
  precision: number | null;
  recall: number | null;
  f1Score: number | null;
  latencyP50Ms: number;
  latencyP99Ms: number;
  errorRate: number;
  driftScore: number;
}

// Drift detection thresholds
const DRIFT_THRESHOLDS = {
  mae_increase: 0.2, // 20% increase in MAE
  rmse_increase: 0.25,
  mape_increase: 0.15,
  accuracy_decrease: 0.1,
  prediction_shift: 0.15, // 15% shift in prediction distribution
};

export class MLOpsPipelineService {
  
  /**
   * Register a new model version
   */
  async registerModel(
    model: {
      modelName: string;
      version: string;
      modelType: ModelVersion['modelType'];
      framework?: string;
      inputSchema: Record<string, any>;
      outputSchema: Record<string, any>;
      hyperparameters?: Record<string, any>;
      trainingDataStart?: Date;
      trainingDataEnd?: Date;
      trainingSamples?: number;
      validationMetrics: Record<string, number>;
      artifactPath?: string;
    }
  ): Promise<ModelVersion> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Generate artifact hash if path provided
    const artifactHash = model.artifactPath 
      ? createHash('sha256').update(`${model.artifactPath}-${Date.now()}`).digest('hex')
      : null;

    const result = await db.execute<SqlRow>(sql`
      INSERT INTO model_registry (
        model_name, model_version, model_type, framework,
        input_schema, output_schema, hyperparameters,
        training_data_start, training_data_end, training_samples,
        validation_metrics, artifact_path, artifact_hash,
        status, created_at, updated_at
      ) VALUES (
        ${model.modelName}, ${model.version}, ${model.modelType},
        ${model.framework || null},
        ${JSON.stringify(model.inputSchema)}, ${JSON.stringify(model.outputSchema)},
        ${JSON.stringify(model.hyperparameters || {})},
        ${model.trainingDataStart || null}, ${model.trainingDataEnd || null},
        ${model.trainingSamples || null},
        ${JSON.stringify(model.validationMetrics)},
        ${model.artifactPath || null}, ${artifactHash},
        'staging', NOW(), NOW()
      )
      RETURNING id
    `);

    console.log(`[MLOps] Registered model ${model.modelName} v${model.version}`);

    // Publish to Kafka for lakehouse analytics
    try {
      await kafkaPublisher.publishMLOpsTrainingRun({
        runId: `run-${Date.now()}`,
        modelId: (Number(result.rows[0].id)).toString(),
        modelName: model.modelName,
        modelVersion: model.version,
        metricsJson: JSON.stringify(model.validationMetrics),
        timestamp: new Date(),
      });
    } catch (error) {
      console.error('[MLOps] Error publishing to Kafka:', error);
    }

    return this.getModel(Number(result.rows[0].id)) as Promise<ModelVersion>;
  }

  /**
   * Get model by ID
   */
  async getModel(modelId: number): Promise<ModelVersion | null> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const result = await db.execute<SqlRow>(sql`
      SELECT * FROM model_registry WHERE id = ${modelId}
    `);

    const row = result.rows[0];
    return row ? this.mapRowToModel(row) : null;
  }

  /**
   * Get deployed model by name
   */
  async getDeployedModel(modelName: string): Promise<ModelVersion | null> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const result = await db.execute<SqlRow>(sql`
      SELECT * FROM model_registry
      WHERE model_name = ${modelName} AND status = 'production'
      ORDER BY deployed_at DESC
      LIMIT 1
    `);

    const row = result.rows[0];
    return row ? this.mapRowToModel(row) : null;
  }

  /**
   * Deploy a model version
   */
  async deployModel(modelId: number): Promise<ModelVersion> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const model = await this.getModel(modelId);
    if (!model) throw new Error('Model not found');

    // Deprecate currently deployed version
    await db.execute<SqlRow>(sql`
      UPDATE model_registry SET
        status = 'deprecated',
        deprecated_at = NOW(),
        updated_at = NOW()
      WHERE model_name = ${model.modelName} AND status = 'production'
    `);

    // Deploy new version
    await db.execute<SqlRow>(sql`
      UPDATE model_registry SET
        status = 'production',
        deployed_at = NOW(),
        updated_at = NOW()
      WHERE id = ${modelId}
    `);

    console.log(`[MLOps] Deployed model ${model.modelName} v${model.version}`);

    // Capture a real feature baseline for drift detection at deploy time.
    // If no predictions exist yet, the baseline is established on the first
    // drift check and reported with baselineEstablished: 'just_now'.
    try {
      const captured = await this.captureFeatureBaseline(modelId);
      console.log(captured
        ? `[MLOps] Feature baseline captured for model ${modelId} at deploy time`
        : `[MLOps] No prediction data yet for model ${modelId}; baseline will be established on first drift check`);
    } catch (error) {
      console.error('[MLOps] Failed to capture feature baseline at deploy:', error);
    }

    return this.getModel(modelId) as Promise<ModelVersion>;
  }

  /**
   * Record model prediction for monitoring
   */
  async recordPrediction(
    modelId: number,
    prediction: {
      inputHash: string;
      predictedValue: number;
      actualValue?: number;
      latencyMs: number;
      features?: Record<string, number>;
    }
  ): Promise<void> {
    const db = await getDb();
    if (!db) return;

    await db.execute<SqlRow>(sql`
      INSERT INTO model_predictions (
        model_id, input_hash, predicted_value, actual_value,
        latency_ms, features, created_at
      ) VALUES (
        ${modelId}, ${prediction.inputHash},
        ${prediction.predictedValue}, ${prediction.actualValue || null},
        ${prediction.latencyMs}, ${prediction.features ? JSON.stringify(prediction.features) : null},
        NOW()
      )
    `);
  }

  /**
   * Update prediction with actual value (for accuracy tracking)
   */
  async updatePredictionActual(inputHash: string, actualValue: number): Promise<void> {
    const db = await getDb();
    if (!db) return;

    await db.execute<SqlRow>(sql`
      UPDATE model_predictions SET actual_value = ${actualValue}
      WHERE input_hash = ${inputHash} AND actual_value IS NULL
    `);
  }

  /**
   * Detect drift for a model
   */
  async detectDrift(modelId: number, windowHours: number = 24): Promise<DriftEvent[]> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const model = await this.getModel(modelId);
    if (!model) throw new Error('Model not found');

    const driftEvents: DriftEvent[] = [];
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - windowHours * 3600000);

    // Get baseline metrics from validation
    const baselineMetrics = model.validationMetrics;

    // Calculate current metrics
    const currentMetrics = await this.calculateCurrentMetrics(modelId, windowStart, windowEnd);

    // Check for performance degradation
    if (baselineMetrics.mae && currentMetrics.mae) {
      const maeIncrease = (currentMetrics.mae - baselineMetrics.mae) / baselineMetrics.mae;
      if (maeIncrease > DRIFT_THRESHOLDS.mae_increase) {
        const event = await this.recordDriftEvent(modelId, {
          driftType: 'performance_degradation',
          severity: maeIncrease > 0.5 ? 'critical' : maeIncrease > 0.3 ? 'high' : 'medium',
          metricName: 'mae',
          baselineValue: baselineMetrics.mae,
          currentValue: currentMetrics.mae,
          threshold: DRIFT_THRESHOLDS.mae_increase,
          windowStart,
          windowEnd,
          affectedFeatures: [],
          recommendedAction: 'Consider retraining model with recent data',
        });
        driftEvents.push(event);
      }
    }

    // Check for prediction drift
    const predictionStats = await this.getPredictionDistribution(modelId, windowStart, windowEnd);
    const baselineMean = baselineMetrics.prediction_mean || 0;
    if (baselineMean > 0 && predictionStats.mean) {
      const predictionShift = Math.abs(predictionStats.mean - baselineMean) / baselineMean;
      if (predictionShift > DRIFT_THRESHOLDS.prediction_shift) {
        const event = await this.recordDriftEvent(modelId, {
          driftType: 'prediction_drift',
          severity: predictionShift > 0.3 ? 'high' : 'medium',
          metricName: 'prediction_mean',
          baselineValue: baselineMean,
          currentValue: predictionStats.mean,
          threshold: DRIFT_THRESHOLDS.prediction_shift,
          windowStart,
          windowEnd,
          affectedFeatures: [],
          recommendedAction: 'Investigate input data distribution changes',
        });
        driftEvents.push(event);
      }
    }

    // Check for data drift (feature distribution changes vs persisted baseline)
    const featureDrift = await this.detectFeatureDrift(modelId, windowStart, windowEnd);
    if (featureDrift.baselineEstablished === 'just_now') {
      console.log(`[MLOps] Model ${modelId}: feature baseline just established; driftScore 0 for this window`);
    }
    for (const fd of featureDrift.results) {
      const event = await this.recordDriftEvent(modelId, {
        driftType: 'data_drift',
        severity: fd.driftScore > 0.5 ? 'high' : 'medium',
        metricName: `feature_${fd.featureName}`,
        baselineValue: fd.baselineMean,
        currentValue: fd.currentMean,
        threshold: 0.2,
        windowStart,
        windowEnd,
        affectedFeatures: [fd.featureName],
        recommendedAction: `Feature ${fd.featureName} distribution has shifted significantly`,
      });
      driftEvents.push(event);
    }

    if (driftEvents.length > 0) {
      console.log(`[MLOps] Detected ${driftEvents.length} drift events for model ${modelId}`);
    }

    return driftEvents;
  }

  /**
   * Record a drift event
   */
  private async recordDriftEvent(
    modelId: number,
    event: Omit<DriftEvent, 'id' | 'modelId' | 'detectedAt' | 'actionTaken' | 'resolvedAt'>
  ): Promise<DriftEvent> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const result = await db.execute<SqlRow>(sql`
      INSERT INTO model_drift_events (
        model_id, drift_type, severity, detected_at,
        metric_name, baseline_value, current_value, threshold,
        window_start, window_end, affected_features, recommended_action,
        created_at
      ) VALUES (
        ${modelId}, ${event.driftType}, ${event.severity}, NOW(),
        ${event.metricName}, ${event.baselineValue}, ${event.currentValue}, ${event.threshold},
        ${event.windowStart}, ${event.windowEnd},
        ${JSON.stringify(event.affectedFeatures)}, ${event.recommendedAction},
        NOW()
      )
      RETURNING id
    `);

    return {
      id: Number(result.rows[0].id),
      modelId,
      detectedAt: new Date(),
      actionTaken: null,
      resolvedAt: null,
      ...event,
    };
  }

  /**
   * Calculate current metrics from predictions
   */
  private async calculateCurrentMetrics(
    modelId: number,
    windowStart: Date,
    windowEnd: Date
  ): Promise<Record<string, number>> {
    const db = await getDb();
    if (!db) return {};

    const result = await db.execute<SqlRow>(sql`
      SELECT
        AVG(ABS(predicted_value - actual_value)) as mae,
        SQRT(AVG(POWER(predicted_value - actual_value, 2))) as rmse,
        AVG(ABS(predicted_value - actual_value) / NULLIF(actual_value, 0)) * 100 as mape,
        COUNT(*) as count
      FROM model_predictions
      WHERE model_id = ${modelId}
        AND created_at >= ${windowStart}
        AND created_at <= ${windowEnd}
        AND actual_value IS NOT NULL
    `);

    const row = result.rows[0];
    return {
      mae: row?.mae || 0,
      rmse: row?.rmse || 0,
      mape: row?.mape || 0,
      count: row?.count || 0,
    };
  }

  /**
   * Get prediction distribution statistics
   */
  private async getPredictionDistribution(
    modelId: number,
    windowStart: Date,
    windowEnd: Date
  ): Promise<{ mean: number; std: number; min: number; max: number }> {
    const db = await getDb();
    if (!db) return { mean: 0, std: 0, min: 0, max: 0 };

    const result = await db.execute<SqlRow>(sql`
      SELECT
        AVG(predicted_value) as mean,
        STDDEV(predicted_value) as std,
        MIN(predicted_value) as min,
        MAX(predicted_value) as max
      FROM model_predictions
      WHERE model_id = ${modelId}
        AND created_at >= ${windowStart}
        AND created_at <= ${windowEnd}
    `);

    const row = result.rows[0];
    return {
      mean: row?.mean || 0,
      std: row?.std || 0,
      min: row?.min || 0,
      max: row?.max || 0,
    };
  }

  /**
   * Redis key for a model's persisted feature baseline distribution
   */
  private featureBaselineKey(modelId: number): string {
    return `mlops:feature-baseline:${modelId}`;
  }

  /**
   * Aggregate real feature statistics (mean/std/count) from prediction rows
   */
  private aggregateFeatureStats(predictions: any[]): Map<string, { mean: number; std: number; count: number }> {
    const sums: Map<string, { sum: number; sumSq: number; count: number }> = new Map();

    for (const p of predictions) {
      const features = p.features ? JSON.parse(p.features) : {};
      for (const [name, value] of Object.entries(features)) {
        if (typeof value === 'number') {
          const stats = sums.get(name) || { sum: 0, sumSq: 0, count: 0 };
          stats.sum += value;
          stats.sumSq += value * value;
          stats.count++;
          sums.set(name, stats);
        }
      }
    }

    const result: Map<string, { mean: number; std: number; count: number }> = new Map();
    for (const [name, s] of Array.from(sums.entries())) {
      const mean = s.sum / s.count;
      const variance = Math.max(0, s.sumSq / s.count - mean * mean);
      result.set(name, { mean, std: Math.sqrt(variance), count: s.count });
    }
    return result;
  }

  /**
   * Fetch recent prediction feature rows for a model within a window
   */
  private async getPredictionFeatureRows(modelId: number, windowStart: Date, windowEnd: Date): Promise<any[]> {
    const db = await getDb();
    if (!db) return [];

    const result = await db.execute<SqlRow>(sql`
      SELECT features FROM model_predictions
      WHERE model_id = ${modelId}
        AND created_at >= ${windowStart}
        AND created_at <= ${windowEnd}
        AND features IS NOT NULL
      LIMIT 1000
    `);

    return result.rows || [];
  }

  /**
   * Capture and persist a real feature baseline distribution (mean/std per
   * feature) from recent predictions. Called at model deploy time.
   * Returns false when there is no prediction data to baseline from.
   */
  private async captureFeatureBaseline(modelId: number): Promise<boolean> {
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - 30 * 24 * 3600000);
    const rows = await this.getPredictionFeatureRows(modelId, windowStart, windowEnd);
    if (rows.length === 0) return false;

    const stats = this.aggregateFeatureStats(rows);
    if (stats.size === 0) return false;

    await redisCache.set(this.featureBaselineKey(modelId), {
      features: Object.fromEntries(stats),
      establishedAt: new Date().toISOString(),
      sampleCount: rows.length,
    });
    return true;
  }

  /**
   * Detect feature drift against the persisted baseline distribution.
   *
   * If no baseline has been stored yet, the current distribution is stored as
   * the baseline and driftScore is reported as 0 with
   * baselineEstablished: 'just_now' — drift is never computed against a
   * fabricated baseline.
   */
  private async detectFeatureDrift(
    modelId: number,
    windowStart: Date,
    windowEnd: Date
  ): Promise<{
    results: Array<{ featureName: string; baselineMean: number; currentMean: number; driftScore: number }>;
    baselineEstablished: 'existing' | 'just_now' | 'no_data';
  }> {
    const rows = await this.getPredictionFeatureRows(modelId, windowStart, windowEnd);
    if (rows.length === 0) return { results: [], baselineEstablished: 'no_data' };

    const currentStats = this.aggregateFeatureStats(rows);
    if (currentStats.size === 0) return { results: [], baselineEstablished: 'no_data' };

    // Load the real persisted baseline; if none exists, establish it now
    const baseline = await redisCache.get<{
      features: Record<string, { mean: number; std: number; count: number }>;
      establishedAt: string;
    }>(this.featureBaselineKey(modelId));

    if (!baseline || !baseline.features) {
      await redisCache.set(this.featureBaselineKey(modelId), {
        features: Object.fromEntries(currentStats),
        establishedAt: new Date().toISOString(),
        sampleCount: rows.length,
      });
      console.log(`[MLOps] No stored baseline for model ${modelId}; stored current distribution as baseline (baselineEstablished: just_now, driftScore: 0)`);
      return { results: [], baselineEstablished: 'just_now' };
    }

    // Compare current distribution against the real stored baseline
    const driftResults: Array<{ featureName: string; baselineMean: number; currentMean: number; driftScore: number }> = [];

    for (const [name, current] of Array.from(currentStats.entries())) {
      const base = baseline.features[name];
      if (!base) continue; // New feature with no baseline — skip rather than fabricate

      const currentMean = current.mean;
      const baselineMean = base.mean;
      // Normalized shift relative to the baseline scale (mean magnitude or std)
      const scale = Math.abs(baselineMean) || base.std || 1;
      const driftScore = Math.abs(currentMean - baselineMean) / scale;

      if (driftScore > 0.2) {
        driftResults.push({ featureName: name, baselineMean, currentMean, driftScore });
      }
    }

    return { results: driftResults, baselineEstablished: 'existing' };
  }

  /**
   * Trigger model retraining
   */
  async triggerRetraining(
    modelId: number,
    options: {
      triggerType: RetrainingJob['triggerType'];
      triggeredBy?: string;
      trainingConfig?: Record<string, any>;
    }
  ): Promise<RetrainingJob> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const model = await this.getModel(modelId);
    if (!model) throw new Error('Model not found');

    const jobId = `retrain_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;

    const result = await db.execute<SqlRow>(sql`
      INSERT INTO retraining_jobs (
        model_id, job_id, trigger_type, triggered_by,
        status, training_config, created_at
      ) VALUES (
        ${modelId}, ${jobId}, ${options.triggerType},
        ${options.triggeredBy || null}, 'queued',
        ${JSON.stringify(options.trainingConfig || {})}, NOW()
      )
      RETURNING id
    `);

    console.log(`[MLOps] Triggered retraining job ${jobId} for model ${model.modelName}`);

    return {
      id: Number(result.rows[0].id),
      modelId,
      jobId,
      triggerType: options.triggerType,
      triggeredBy: options.triggeredBy || null,
      status: 'queued',
      trainingConfig: options.trainingConfig || {},
      startedAt: null,
      completedAt: null,
      newModelVersion: null,
      metrics: null,
      errorMessage: null,
    };
  }

  /**
   * Update retraining job status
   */
  async updateRetrainingJob(
    jobId: string,
    update: {
      status?: RetrainingJob['status'];
      newModelVersion?: string;
      metrics?: Record<string, number>;
      errorMessage?: string;
    }
  ): Promise<void> {
    const db = await getDb();
    if (!db) return;

    const setFields: string[] = [];
    
    if (update.status === 'running') {
      setFields.push('started_at = NOW()');
    }
    if (update.status === 'completed' || update.status === 'failed') {
      setFields.push('completed_at = NOW()');
    }

    await db.execute<SqlRow>(sql`
      UPDATE retraining_jobs SET
        status = COALESCE(${update.status || null}, status),
        new_model_version = COALESCE(${update.newModelVersion || null}, new_model_version),
        metrics = COALESCE(${update.metrics ? JSON.stringify(update.metrics) : null}, metrics),
        error_message = COALESCE(${update.errorMessage || null}, error_message),
        started_at = CASE WHEN ${update.status} = 'running' THEN NOW() ELSE started_at END,
        completed_at = CASE WHEN ${update.status} IN ('completed', 'failed') THEN NOW() ELSE completed_at END
      WHERE job_id = ${jobId}
    `);
  }

  /**
   * Get model performance metrics
   */
  async getModelPerformance(modelId: number, periodHours: number = 24): Promise<ModelPerformanceMetrics> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const model = await this.getModel(modelId);
    if (!model) throw new Error('Model not found');

    const periodStart = new Date(Date.now() - periodHours * 3600000);

    // Get prediction metrics
    const metricsResult = await db.execute<SqlRow>(sql`
      SELECT
        COUNT(*) as prediction_count,
        AVG(ABS(predicted_value - actual_value)) as mae,
        SQRT(AVG(POWER(predicted_value - actual_value, 2))) as rmse,
        AVG(ABS(predicted_value - actual_value) / NULLIF(actual_value, 0)) * 100 as mape,
        AVG(latency_ms) as latency_avg,
        MAX(latency_ms) as latency_max
      FROM model_predictions
      WHERE model_id = ${modelId}
        AND created_at >= ${periodStart}
        AND actual_value IS NOT NULL
    `);
    const metrics = metricsResult.rows[0] || {};

    // Get latency percentiles
    const latencyResult = await db.execute<SqlRow>(sql`
      SELECT latency_ms FROM model_predictions
      WHERE model_id = ${modelId}
        AND created_at >= ${periodStart}
      ORDER BY latency_ms
    `);
    const latencies = (latencyResult.rows || []).map((r: any) => r.latency_ms);
    const p50Index = Math.floor(latencies.length * 0.5);
    const p99Index = Math.floor(latencies.length * 0.99);

    // Get error rate
    const errorResult = await db.execute<SqlRow>(sql`
      SELECT
        COUNT(CASE WHEN actual_value IS NULL THEN 1 END) as errors,
        COUNT(*) as total
      FROM model_predictions
      WHERE model_id = ${modelId}
        AND created_at >= ${periodStart}
    `);
    const errorStats = errorResult.rows[0] || {};
    const errorRate = errorStats.total > 0 ? errorStats.errors / errorStats.total : 0;

    // Get drift score
    const driftResult = await db.execute<SqlRow>(sql`
      SELECT COUNT(*) as drift_count FROM model_drift_events
      WHERE model_id = ${modelId}
        AND detected_at >= ${periodStart}
        AND resolved_at IS NULL
    `);
    const driftCount = driftResult.rows[0]?.drift_count || 0;
    const driftScore = Math.min(1, driftCount * 0.2); // 0.2 per unresolved drift event

    return {
      modelId,
      modelName: model.modelName,
      version: model.version,
      period: `${periodHours}h`,
      predictionCount: metrics.prediction_count || 0,
      mae: metrics.mae,
      rmse: metrics.rmse,
      mape: metrics.mape,
      accuracy: null, // For classification models
      precision: null,
      recall: null,
      f1Score: null,
      latencyP50Ms: latencies[p50Index] || 0,
      latencyP99Ms: latencies[p99Index] || 0,
      errorRate,
      driftScore,
    };
  }

  /**
   * Get all models
   */
  async listModels(status?: ModelVersion['status']): Promise<ModelVersion[]> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    let query;
    if (status) {
      query = sql`SELECT * FROM model_registry WHERE status = ${status} ORDER BY created_at DESC`;
    } else {
      query = sql`SELECT * FROM model_registry ORDER BY created_at DESC`;
    }

    const result = await db.execute<SqlRow>(query);
    return (result.rows || []).map(this.mapRowToModel);
  }

  /**
   * Get recent drift events
   */
  async getRecentDriftEvents(modelId?: number, limit: number = 50): Promise<DriftEvent[]> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    let query;
    if (modelId) {
      query = sql`
        SELECT * FROM model_drift_events
        WHERE model_id = ${modelId}
        ORDER BY detected_at DESC
        LIMIT ${limit}
      `;
    } else {
      query = sql`
        SELECT * FROM model_drift_events
        ORDER BY detected_at DESC
        LIMIT ${limit}
      `;
    }

    const result = await db.execute<SqlRow>(query);
    return (result.rows || []).map(this.mapRowToDriftEvent);
  }

  private mapRowToModel(row: any): ModelVersion {
    return {
      id: row.id,
      modelName: row.model_name,
      version: row.model_version,
      modelType: row.model_type,
      framework: row.framework,
      inputSchema: row.input_schema ? JSON.parse(row.input_schema) : {},
      outputSchema: row.output_schema ? JSON.parse(row.output_schema) : {},
      hyperparameters: row.hyperparameters ? JSON.parse(row.hyperparameters) : {},
      trainingDataStart: row.training_data_start,
      trainingDataEnd: row.training_data_end,
      trainingSamples: row.training_samples,
      validationMetrics: row.validation_metrics ? JSON.parse(row.validation_metrics) : {},
      artifactPath: row.artifact_path,
      artifactHash: row.artifact_hash,
      status: row.status,
      deployedAt: row.deployed_at,
      deprecatedAt: row.deprecated_at,
      createdAt: row.created_at,
    };
  }

  private mapRowToDriftEvent(row: any): DriftEvent {
    return {
      id: row.id,
      modelId: row.model_id,
      driftType: row.drift_type,
      severity: row.severity,
      detectedAt: row.detected_at,
      metricName: row.metric_name,
      baselineValue: row.baseline_value,
      currentValue: row.current_value,
      threshold: row.threshold,
      windowStart: row.window_start,
      windowEnd: row.window_end,
      affectedFeatures: row.affected_features ? JSON.parse(row.affected_features) : [],
      recommendedAction: row.recommended_action,
      actionTaken: row.action_taken,
      resolvedAt: row.resolved_at,
    };
  }
}

// Singleton instance
export const mlopsPipeline = new MLOpsPipelineService();
