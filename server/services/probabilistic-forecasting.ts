/**
 * Probabilistic Forecasting Service
 * 
 * Provides uncertainty-aware forecasts for load, generation, price, and emissions.
 * Outputs quantile predictions (P10, P50, P90) for risk-aware decision making.
 */

import { getDb } from '../db';
import { sql } from 'drizzle-orm';
import { createHash } from 'crypto';
import { kafkaPublisher } from '../integration/kafka-publisher';
import type { SqlRow } from '../sql-row';

// Types for forecasting
export interface ForecastQuantiles {
  p10: number;  // 10th percentile (optimistic)
  p50: number;  // 50th percentile (median)
  p90: number;  // 90th percentile (conservative)
  mean: number;
  confidence: number; // 0-100
}

export interface ForecastPoint {
  timestamp: Date;
  values: ForecastQuantiles;
}

export interface ForecastResult {
  runId: string;
  forecastType: string;
  scopeType: string;
  scopeId: number | null;
  region: string | null;
  modelVersion: string;
  horizonHours: number;
  intervalMinutes: number;
  points: ForecastPoint[];
  metrics: {
    mae: number | null;
    rmse: number | null;
    mape: number | null;
    // true only when metrics come from a real backtest against actuals;
    // false means the null metrics are simply "not yet measured"
    metricsEstimated: boolean;
  };
  // false when history was insufficient to fit a model: points is empty and
  // nothing was persisted or published. Consumers must check this before
  // using points — an unavailable forecast is never fabricated.
  forecastAvailable: boolean;
  // why the forecast is unavailable (e.g. 'insufficient_history: ...');
  // null when forecastAvailable is true
  reason: string | null;
  createdAt: Date;
}

// Minimum history required to fit a seasonal model. Precedent:
// battery-health.ts (MIN_SPAN_DAYS = 7) refuses to derive analytics from
// thinner telemetry; forecasting follows the same floor.
const MIN_HISTORY_SPAN_DAYS = 7;

export interface HistoricalDataPoint {
  timestamp: Date;
  value: number;
  features?: Record<string, number>;
}

// Simple linear regression for baseline forecasting
class SimpleRegression {
  private slope: number = 0;
  private intercept: number = 0;
  private residuals: number[] = [];

  fit(x: number[], y: number[]): void {
    const n = x.length;
    if (n === 0) return;

    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((acc, xi, i) => acc + xi * y[i], 0);
    const sumX2 = x.reduce((acc, xi) => acc + xi * xi, 0);

    this.slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    this.intercept = (sumY - this.slope * sumX) / n;

    // Calculate residuals for uncertainty estimation
    this.residuals = y.map((yi, i) => yi - this.predict(x[i]));
  }

  predict(x: number): number {
    return this.slope * x + this.intercept;
  }

  getQuantiles(x: number): ForecastQuantiles {
    const prediction = this.predict(x);
    
    // Calculate standard deviation of residuals
    const n = this.residuals.length;
    if (n === 0) {
      return { p10: prediction, p50: prediction, p90: prediction, mean: prediction, confidence: 50 };
    }

    const mean = this.residuals.reduce((a, b) => a + b, 0) / n;
    const variance = this.residuals.reduce((acc, r) => acc + (r - mean) ** 2, 0) / n;
    const stdDev = Math.sqrt(variance);

    // Z-scores for quantiles
    const z10 = -1.28; // 10th percentile
    const z90 = 1.28;  // 90th percentile

    return {
      p10: Math.max(0, prediction + z10 * stdDev),
      p50: Math.max(0, prediction),
      p90: Math.max(0, prediction + z90 * stdDev),
      mean: Math.max(0, prediction),
      confidence: Math.max(30, 100 - (stdDev / Math.abs(prediction || 1)) * 100),
    };
  }
}

/**
 * Region code -> marketPrices country. Only regions the platform actually
 * operates in are mapped; anything else fails loudly, because silently
 * defaulting an unknown region to one country's prices would produce a
 * forecast from the wrong market without telling anyone.
 */
const REGION_TO_COUNTRY: Record<string, string> = {
  NG: 'nigeria',
  NIGERIA: 'nigeria',
  TZ: 'tanzania',
  TANZANIA: 'tanzania',
};

export function countryForRegion(region: string): string {
  const key = region.trim().toUpperCase();
  const country = REGION_TO_COUNTRY[key] ?? REGION_TO_COUNTRY[key.split('-')[0]];
  if (!country) {
    throw new Error(
      `unsupported_region: '${region}' has no market price data mapping; supported regions: ${Object.keys(REGION_TO_COUNTRY).join(', ')}`
    );
  }
  return country;
}

// Seasonal decomposition for time series
export class SeasonalModel {
  private hourlyAverages: Map<number, { mean: number; std: number }> = new Map();
  private dayOfWeekFactors: Map<number, number> = new Map();
  private trend: SimpleRegression = new SimpleRegression();
  /** Number of history points the trend was fitted on (indices 0..n-1). */
  private historyLength = 0;

  fit(data: HistoricalDataPoint[]): void {
    if (data.length === 0) return;

    // Calculate hourly averages
    const hourlyData: Map<number, number[]> = new Map();
    const dowData: Map<number, number[]> = new Map();

    for (const point of data) {
      const hour = point.timestamp.getHours();
      const dow = point.timestamp.getDay();

      if (!hourlyData.has(hour)) hourlyData.set(hour, []);
      hourlyData.get(hour)!.push(point.value);

      if (!dowData.has(dow)) dowData.set(dow, []);
      dowData.get(dow)!.push(point.value);
    }

    // Calculate hourly statistics
    for (const [hour, values] of Array.from(hourlyData.entries())) {
      const mean = values.reduce((a: number, b: number) => a + b, 0) / values.length;
      const variance = values.reduce((acc: number, v: number) => acc + (v - mean) ** 2, 0) / values.length;
      this.hourlyAverages.set(hour, { mean, std: Math.sqrt(variance) });
    }

    // Calculate day-of-week factors
    const overallMean = data.reduce((acc, p) => acc + p.value, 0) / data.length;
    for (const [dow, values] of Array.from(dowData.entries())) {
      const dowMean = values.reduce((a: number, b: number) => a + b, 0) / values.length;
      this.dayOfWeekFactors.set(dow, dowMean / overallMean);
    }

    // Fit trend on the history indices 0..n-1
    const x = data.map((_, i) => i);
    const y = data.map(p => p.value);
    this.trend.fit(x, y);
    this.historyLength = data.length;
  }

  predict(timestamp: Date, horizonIndex: number): ForecastQuantiles {
    const hour = timestamp.getHours();
    const dow = timestamp.getDay();

    const hourlyStats = this.hourlyAverages.get(hour) || { mean: 0, std: 0 };
    const dowFactor = this.dayOfWeekFactors.get(dow) || 1;

    // Combine seasonal pattern with trend. The trend was fitted on the history
    // indices 0..n-1, so the first forecast step is index n — evaluating the
    // trend at horizonIndex would extrapolate BACKWARD into the already-seen
    // history and report the past as the future.
    const trendValue = this.trend.predict(this.historyLength + horizonIndex);
    const seasonalValue = hourlyStats.mean * dowFactor;
    
    // Weight: more seasonal for near-term, more trend for long-term
    const trendWeight = Math.min(0.5, horizonIndex / 100);
    const prediction = seasonalValue * (1 - trendWeight) + trendValue * trendWeight;

    // Uncertainty increases with horizon
    const horizonUncertainty = 1 + (horizonIndex * 0.02); // 2% per interval
    const adjustedStd = hourlyStats.std * horizonUncertainty;

    const z10 = -1.28;
    const z90 = 1.28;

    return {
      p10: Math.max(0, prediction + z10 * adjustedStd),
      p50: Math.max(0, prediction),
      p90: Math.max(0, prediction + z90 * adjustedStd),
      mean: Math.max(0, prediction),
      confidence: Math.max(30, 100 - (horizonIndex * 0.5) - (adjustedStd / Math.abs(prediction || 1)) * 50),
    };
  }
}

export class ProbabilisticForecastingService {
  private modelVersion = '1.0.0';

  /**
   * Returns a reason string when the history is too thin or degenerate to fit
   * a model (null when sufficient). An unfitted model would emit all-zero
   * quantiles that look like real forecasts, so we refuse instead.
   */
  private insufficientHistoryReason(data: HistoricalDataPoint[]): string | null {
    if (data.length === 0) {
      return 'insufficient_history: no historical data available';
    }
    const spanDays =
      (data[data.length - 1].timestamp.getTime() - data[0].timestamp.getTime()) / 86400000;
    if (spanDays < MIN_HISTORY_SPAN_DAYS) {
      return `insufficient_history: ${spanDays.toFixed(1)} days of history; at least ${MIN_HISTORY_SPAN_DAYS} days are required`;
    }
    if (data.every(p => p.value === 0)) {
      return 'insufficient_history: all historical values are zero';
    }
    return null;
  }

  /**
   * Honest unavailable result: empty series, null metrics, nothing persisted
   * to forecast_runs and nothing published to Kafka. Never presented as a
   * completed run.
   */
  private unavailableForecast(
    runId: string,
    forecastType: string,
    scopeType: string,
    scopeId: number | null,
    region: string | null,
    horizonHours: number,
    intervalMinutes: number,
    reason: string
  ): ForecastResult {
    return {
      runId,
      forecastType,
      scopeType,
      scopeId,
      region,
      modelVersion: this.modelVersion,
      horizonHours,
      intervalMinutes,
      points: [],
      metrics: { mae: null, rmse: null, mape: null, metricsEstimated: false },
      forecastAvailable: false,
      reason,
      createdAt: new Date(),
    };
  }

  /**
   * Generate load forecast for an asset, user, community, or region
   */
  async forecastLoad(
    scope: { assetId?: number; userId?: number; communityId?: number; region?: string },
    horizonHours: number = 24,
    intervalMinutes: number = 15
  ): Promise<ForecastResult> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const runId = this.generateRunId();
    const scopeType = scope.assetId ? 'asset' : scope.userId ? 'user' : scope.communityId ? 'community' : 'region';
    const scopeId = scope.assetId || scope.userId || scope.communityId || null;

    // Get historical data
    const historicalData = await this.getHistoricalLoad(scope, 30); // 30 days

    // Refuse to fit/persist/publish a degenerate model as a completed run
    const insufficient = this.insufficientHistoryReason(historicalData);
    if (insufficient) {
      console.warn(`[Forecasting] Load forecast unavailable for ${scopeType}=${scopeId || scope.region}: ${insufficient}`);
      return this.unavailableForecast(runId, 'load', scopeType, scopeId, scope.region || null, horizonHours, intervalMinutes, insufficient);
    }

    // Train model
    const model = new SeasonalModel();
    model.fit(historicalData);

    // Generate forecast points
    const points: ForecastPoint[] = [];
    const now = new Date();
    const intervalsCount = (horizonHours * 60) / intervalMinutes;

    for (let i = 0; i < intervalsCount; i++) {
      const timestamp = new Date(now.getTime() + i * intervalMinutes * 60 * 1000);
      const values = model.predict(timestamp, i);
      points.push({ timestamp, values });
    }

    // Calculate metrics against recent actuals
    const metrics = await this.calculateMetrics(scope, points.slice(0, 4)); // First hour

    // Store forecast run
    await this.storeForecastRun(runId, 'load', scopeType, scopeId, scope.region || null, horizonHours, intervalMinutes, points, metrics);

    // Publish to Kafka for lakehouse analytics
    await this.publishForecastToKafka(runId, 'load', horizonHours, points[0]?.values, scopeId?.toString(), null);

    console.log(`[Forecasting] Generated load forecast ${runId.substring(0, 8)}... for ${scopeType}=${scopeId || scope.region}`);

    return {
      runId,
      forecastType: 'load',
      scopeType,
      scopeId,
      region: scope.region || null,
      modelVersion: this.modelVersion,
      horizonHours,
      intervalMinutes,
      points,
      metrics,
      forecastAvailable: true,
      reason: null,
      createdAt: now,
    };
  }

  /**
   * Generate solar generation forecast
   */
  async forecastSolarGeneration(
    scope: { assetId?: number; userId?: number; region?: string },
    horizonHours: number = 24,
    intervalMinutes: number = 15
  ): Promise<ForecastResult> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const runId = this.generateRunId();
    const scopeType = scope.assetId ? 'asset' : scope.userId ? 'user' : 'region';
    const scopeId = scope.assetId || scope.userId || null;

    // Get historical generation data
    const historicalData = await this.getHistoricalGeneration(scope, 30, 'solar');

    // Refuse to persist a degenerate (e.g. all-zero) model as a completed run
    const insufficient = this.insufficientHistoryReason(historicalData);
    if (insufficient) {
      console.warn(`[Forecasting] Solar forecast unavailable for ${scopeType}=${scopeId || scope.region}: ${insufficient}`);
      return this.unavailableForecast(runId, 'solar_generation', scopeType, scopeId, scope.region || null, horizonHours, intervalMinutes, insufficient);
    }

    // Train model with solar-specific patterns
    const model = new SeasonalModel();
    model.fit(historicalData);

    // Generate forecast points with solar constraints (no generation at night)
    const points: ForecastPoint[] = [];
    const now = new Date();
    const intervalsCount = (horizonHours * 60) / intervalMinutes;

    for (let i = 0; i < intervalsCount; i++) {
      const timestamp = new Date(now.getTime() + i * intervalMinutes * 60 * 1000);
      const hour = timestamp.getHours();
      
      // Solar generation only during daylight hours (6 AM - 7 PM)
      if (hour >= 6 && hour <= 19) {
        const values = model.predict(timestamp, i);
        // Apply solar curve (peak at noon)
        const solarFactor = Math.sin(((hour - 6) / 13) * Math.PI);
        points.push({
          timestamp,
          values: {
            p10: values.p10 * solarFactor,
            p50: values.p50 * solarFactor,
            p90: values.p90 * solarFactor,
            mean: values.mean * solarFactor,
            confidence: values.confidence,
          },
        });
      } else {
        points.push({
          timestamp,
          values: { p10: 0, p50: 0, p90: 0, mean: 0, confidence: 100 },
        });
      }
    }

    const metrics = await this.calculateMetrics(scope, points.slice(0, 4));
    await this.storeForecastRun(runId, 'solar_generation', scopeType, scopeId, scope.region || null, horizonHours, intervalMinutes, points, metrics);

    console.log(`[Forecasting] Generated solar forecast ${runId.substring(0, 8)}...`);

    return {
      runId,
      forecastType: 'solar_generation',
      scopeType,
      scopeId,
      region: scope.region || null,
      modelVersion: this.modelVersion,
      horizonHours,
      intervalMinutes,
      points,
      metrics,
      forecastAvailable: true,
      reason: null,
      createdAt: now,
    };
  }

  /**
   * Generate price forecast
   */
  async forecastPrice(
    region: string,
    horizonHours: number = 24,
    intervalMinutes: number = 60
  ): Promise<ForecastResult> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const runId = this.generateRunId();

    // Get historical price data
    const historicalData = await this.getHistoricalPrices(region, 30);

    // Refuse to persist a degenerate (e.g. all-zero) model as a completed run
    const insufficient = this.insufficientHistoryReason(historicalData);
    if (insufficient) {
      console.warn(`[Forecasting] Price forecast unavailable for ${region}: ${insufficient}`);
      return this.unavailableForecast(runId, 'price', 'region', null, region, horizonHours, intervalMinutes, insufficient);
    }

    // Train model
    const model = new SeasonalModel();
    model.fit(historicalData);

    // Generate forecast points
    const points: ForecastPoint[] = [];
    const now = new Date();
    const intervalsCount = (horizonHours * 60) / intervalMinutes;

    for (let i = 0; i < intervalsCount; i++) {
      const timestamp = new Date(now.getTime() + i * intervalMinutes * 60 * 1000);
      const values = model.predict(timestamp, i);
      
      // Price-specific adjustments (higher uncertainty for peak hours)
      const hour = timestamp.getHours();
      const isPeak = (hour >= 18 && hour <= 22) || (hour >= 6 && hour <= 9);
      if (isPeak) {
        const peakMultiplier = 1.2;
        values.p10 *= peakMultiplier;
        values.p50 *= peakMultiplier;
        values.p90 *= peakMultiplier * 1.1; // Even higher upper bound during peak
        values.mean *= peakMultiplier;
        values.confidence *= 0.9; // Lower confidence during peak
      }
      
      points.push({ timestamp, values });
    }

    const metrics = { mae: null, rmse: null, mape: null, metricsEstimated: false }; // Price metrics calculated separately
    await this.storeForecastRun(runId, 'price', 'region', null, region, horizonHours, intervalMinutes, points, metrics);

    console.log(`[Forecasting] Generated price forecast ${runId.substring(0, 8)}... for ${region}`);

    return {
      runId,
      forecastType: 'price',
      scopeType: 'region',
      scopeId: null,
      region,
      modelVersion: this.modelVersion,
      horizonHours,
      intervalMinutes,
      points,
      metrics,
      forecastAvailable: true,
      reason: null,
      createdAt: now,
    };
  }

  /**
   * Generate emissions forecast
   */
  async forecastEmissions(
    region: string,
    horizonHours: number = 24,
    intervalMinutes: number = 60
  ): Promise<ForecastResult> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const runId = this.generateRunId();

    // Get historical emissions data
    const historicalData = await this.getHistoricalEmissions(region, 30);

    // No fabricated default curve: with insufficient history the forecast is
    // explicitly unavailable (empty series, not persisted, not published)
    // rather than an invented 380/450 gCO2/kWh pattern stored as a completed run.
    const insufficient = this.insufficientHistoryReason(historicalData);
    if (insufficient) {
      console.warn(`[Forecasting] Emissions forecast unavailable for ${region}: ${insufficient}`);
      return this.unavailableForecast(runId, 'emissions', 'region', null, region, horizonHours, intervalMinutes, insufficient);
    }

    // Train model
    const model = new SeasonalModel();
    model.fit(historicalData);

    // Generate forecast points
    const points: ForecastPoint[] = [];
    const now = new Date();
    const intervalsCount = (horizonHours * 60) / intervalMinutes;

    for (let i = 0; i < intervalsCount; i++) {
      const timestamp = new Date(now.getTime() + i * intervalMinutes * 60 * 1000);
      const values = model.predict(timestamp, i);
      points.push({ timestamp, values });
    }

    const metrics = { mae: null, rmse: null, mape: null, metricsEstimated: false };
    await this.storeForecastRun(runId, 'emissions', 'region', null, region, horizonHours, intervalMinutes, points, metrics);

    console.log(`[Forecasting] Generated emissions forecast ${runId.substring(0, 8)}... for ${region}`);

    return {
      runId,
      forecastType: 'emissions',
      scopeType: 'region',
      scopeId: null,
      region,
      modelVersion: this.modelVersion,
      horizonHours,
      intervalMinutes,
      points,
      metrics,
      forecastAvailable: true,
      reason: null,
      createdAt: now,
    };
  }

  /**
   * Get forecast by run ID
   */
  async getForecast(runId: string): Promise<ForecastResult | null> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const runResult = await db.execute<SqlRow>(sql`
      SELECT * FROM forecast_runs WHERE run_id = ${runId}
    `);
    const run = runResult.rows[0];
    if (!run) return null;

    const valuesResult = await db.execute<SqlRow>(sql`
      SELECT * FROM forecast_values WHERE run_id = ${run.id} ORDER BY forecast_time ASC
    `);
    const values = valuesResult.rows || [];

    const points: ForecastPoint[] = values.map((v: any) => ({
      timestamp: v.forecast_time,
      values: {
        p10: v.p10_value / 100,
        p50: v.p50_value / 100,
        p90: v.p90_value / 100,
        mean: v.mean_value ? v.mean_value / 100 : v.p50_value / 100,
        confidence: v.confidence_score || 70,
      },
    }));

    return {
      runId: run.run_id,
      forecastType: run.forecast_type,
      scopeType: run.scope_type,
      scopeId: run.scope_id,
      region: run.region,
      modelVersion: run.model_version,
      horizonHours: run.forecast_horizon_hours,
      intervalMinutes: run.interval_minutes,
      points,
      metrics: {
        mae: run.mae_value ? run.mae_value / 100 : null,
        rmse: run.rmse_value ? run.rmse_value / 100 : null,
        mape: run.mape_value ? run.mape_value / 100 : null,
        // Persisted values only exist after a real backtest wrote them
        metricsEstimated: run.mae_value != null || run.rmse_value != null || run.mape_value != null,
      },
      // Only completed, data-derived runs are ever persisted (insufficient-data
      // forecasts are not stored), so a retrievable run is always available.
      forecastAvailable: true,
      reason: null,
      createdAt: run.created_at,
    };
  }

  /**
   * Get historical load data
   */
  private async getHistoricalLoad(
    scope: { assetId?: number; userId?: number; communityId?: number; region?: string },
    days: number
  ): Promise<HistoricalDataPoint[]> {
    const db = await getDb();
    if (!db) return [];

    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    let query;

    if (scope.assetId) {
      query = sql`
        SELECT timestamp, power as value FROM telemetry
        WHERE "assetId" = ${scope.assetId} AND timestamp >= ${startDate}
        ORDER BY timestamp ASC
      `;
    } else if (scope.userId) {
      query = sql`
        SELECT t.timestamp, SUM(t.power) as value FROM telemetry t
        JOIN assets a ON a.id = t."assetId"
        WHERE a."userId" = ${scope.userId} AND t.timestamp >= ${startDate}
        GROUP BY t.timestamp
        ORDER BY t.timestamp ASC
      `;
    } else if (scope.region) {
      query = sql`
        SELECT timestamp, total_load as value FROM grid_monitoring
        WHERE timestamp >= ${startDate}
        ORDER BY timestamp ASC
      `;
    } else {
      return [];
    }

    const result = await db.execute<SqlRow>(query);
    return (result.rows || []).map((row: any) => ({
      timestamp: new Date(row.timestamp),
      value: row.value || 0,
    }));
  }

  /**
   * Get historical generation data
   */
  private async getHistoricalGeneration(
    scope: { assetId?: number; userId?: number; region?: string },
    days: number,
    assetType: string
  ): Promise<HistoricalDataPoint[]> {
    const db = await getDb();
    if (!db) return [];

    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    let query;

    if (scope.assetId) {
      query = sql`
        SELECT timestamp, power as value FROM telemetry
        WHERE "assetId" = ${scope.assetId} AND timestamp >= ${startDate}
        ORDER BY timestamp ASC
      `;
    } else if (scope.userId) {
      query = sql`
        SELECT t.timestamp, SUM(t.power) as value FROM telemetry t
        JOIN assets a ON a.id = t."assetId"
        WHERE a."userId" = ${scope.userId} AND a."assetType" = ${assetType} AND t.timestamp >= ${startDate}
        GROUP BY t.timestamp
        ORDER BY t.timestamp ASC
      `;
    } else {
      return [];
    }

    const result = await db.execute<SqlRow>(query);
    return (result.rows || []).map((row: any) => ({
      timestamp: new Date(row.timestamp),
      value: Math.max(0, row.value || 0), // Generation is always positive
    }));
  }

  /**
   * Get historical price data
   */
  private async getHistoricalPrices(region: string, days: number): Promise<HistoricalDataPoint[]> {
    const db = await getDb();
    if (!db) return [];

    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const country = countryForRegion(region);

    const result = await db.execute<SqlRow>(sql`
      SELECT timestamp, price as value FROM "marketPrices"
      WHERE country = ${country} AND timestamp >= ${startDate}
      ORDER BY timestamp ASC
    `);

    return (result.rows || []).map((row: any) => ({
      timestamp: new Date(row.timestamp),
      value: row.value || 0,
    }));
  }

  /**
   * Get historical emissions data
   */
  private async getHistoricalEmissions(region: string, days: number): Promise<HistoricalDataPoint[]> {
    const db = await getDb();
    if (!db) return [];

    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const result = await db.execute<SqlRow>(sql`
      SELECT timestamp, marginal_emissions as value FROM emissions_factors
      WHERE region = ${region} AND timestamp >= ${startDate}
      ORDER BY timestamp ASC
    `);

    return (result.rows || []).map((row: any) => ({
      timestamp: new Date(row.timestamp),
      value: row.value || 0,
    }));
  }

  /**
   * Calculate forecast accuracy metrics
   */
  private async calculateMetrics(
    scope: { assetId?: number; userId?: number; communityId?: number; region?: string },
    recentPoints: ForecastPoint[]
  ): Promise<{ mae: number | null; rmse: number | null; mape: number | null; metricsEstimated: boolean }> {
    // No real backtest against actuals exists yet. Deriving MAE/RMSE/MAPE
    // algebraically from the model's own confidence would be circular and
    // fabricated, so return null metrics flagged as not estimated until a
    // genuine backtest is implemented.
    return {
      mae: null,
      rmse: null,
      mape: null,
      metricsEstimated: false,
    };
  }

  /**
   * Store forecast run and values.
   *
   * Only data-derived runs are persisted, always as status='completed'.
   * Insufficient-data forecasts are NOT stored: the forecast_runs_status enum
   * ('running' | 'completed' | 'failed') has no 'insufficient_data' value, and
   * persisting them under any existing status would make a fabricated/empty
   * run indistinguishable from a real one.
   */
  private async storeForecastRun(
    runId: string,
    forecastType: string,
    scopeType: string,
    scopeId: number | null,
    region: string | null,
    horizonHours: number,
    intervalMinutes: number,
    points: ForecastPoint[],
    metrics: { mae: number | null; rmse: number | null; mape: number | null; metricsEstimated: boolean }
  ): Promise<void> {
    const db = await getDb();
    if (!db) return;

    try {
      // Insert forecast run
      const runResult = await db.execute<SqlRow>(sql`
        INSERT INTO forecast_runs (
          run_id, forecast_type, scope_type, scope_id, region,
          model_version, model_type, forecast_horizon_hours, interval_minutes,
          mae_value, rmse_value, mape_value, status, created_at
        ) VALUES (
          ${runId}, ${forecastType}, ${scopeType}, ${scopeId}, ${region},
          ${this.modelVersion}, 'seasonal_decomposition', ${horizonHours}, ${intervalMinutes},
          ${metrics.mae ? Math.round(metrics.mae * 100) : null},
          ${metrics.rmse ? Math.round(metrics.rmse * 100) : null},
          ${metrics.mape ? Math.round(metrics.mape * 100) : null},
          'completed', NOW()
        )
        RETURNING id
      `);

      const forecastRunId = Number(runResult.rows[0].id);

      // Insert forecast values (batch insert for efficiency)
      for (const point of points) {
        await db.execute<SqlRow>(sql`
          INSERT INTO forecast_values (
            run_id, forecast_time, p10_value, p50_value, p90_value, mean_value, confidence_score, created_at
          ) VALUES (
            ${forecastRunId}, ${point.timestamp},
            ${Math.round(point.values.p10 * 100)},
            ${Math.round(point.values.p50 * 100)},
            ${Math.round(point.values.p90 * 100)},
            ${Math.round(point.values.mean * 100)},
            ${Math.round(point.values.confidence)},
            NOW()
          )
        `);
      }
    } catch (error) {
      console.error('[Forecasting] Error storing forecast:', error);
      // Don't throw - forecasting should work even if storage fails
    }
  }

  /**
   * Generate unique run ID
   */
  private generateRunId(): string {
    const timestamp = Date.now().toString();
    const random = Math.random().toString(36).substring(2, 10);
    return createHash('sha256').update(`${timestamp}-${random}`).digest('hex').substring(0, 16);
  }

  /**
   * Publish forecast to Kafka for lakehouse analytics
   */
  private async publishForecastToKafka(
    runId: string,
    targetType: string,
    horizonHours: number,
    values: ForecastQuantiles | undefined,
    assetId: string | undefined,
    userId: string | null
  ): Promise<void> {
    if (!values) return;
    
    try {
      await kafkaPublisher.publishForecastGenerated({
        forecastId: runId,
        targetType,
        horizonHours,
        p10: values.p10,
        p50: values.p50,
        p90: values.p90,
        modelVersion: this.modelVersion,
        confidenceScore: values.confidence,
        assetId,
        userId: userId || undefined,
        timestamp: new Date(),
      });
    } catch (error) {
      console.error('[Forecasting] Error publishing to Kafka:', error);
      // Don't throw - forecasting should work even if Kafka publish fails
    }
  }
}

// Singleton instance
export const probabilisticForecasting = new ProbabilisticForecastingService();
