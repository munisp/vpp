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
  createdAt: Date;
}

export interface HistoricalDataPoint {
  timestamp: Date;
  value: number;
  features?: Record<string, number>;
}

/**
 * Turn history rows into numeric points, dropping any row whose value or instant
 * is not a number.
 *
 * Postgres returns a `SUM()` over an integer column as a bigint, which arrives
 * as a string: added straight into a mean it concatenates instead of summing, so
 * a site's history reads as an enormous or NaN load while still looking like a
 * forecast. Rows the database could not measure are dropped rather than read as
 * zero, which would report a quiet site the meter never saw.
 */
function toHistoricalPoints(rows: SqlRow[]): HistoricalDataPoint[] {
  const points: HistoricalDataPoint[] = [];
  for (const row of rows) {
    const value = Number(row.value);
    const timestamp = new Date(row.timestamp as string | number | Date);
    if (!Number.isFinite(value) || Number.isNaN(timestamp.getTime())) continue;
    points.push({ timestamp, value });
  }
  return points;
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

    // With one point, or with every x identical, the slope is not determined:
    // dividing by the zero denominator would make slope, intercept and every
    // later prediction NaN, which reads downstream as a forecast rather than as
    // no forecast. The level is still known, so hold it flat.
    const denominator = n * sumX2 - sumX * sumX;
    this.slope = denominator === 0 ? 0 : (n * sumXY - sumX * sumY) / denominator;
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

// Seasonal decomposition for time series
class SeasonalModel {
  private hourlyAverages: Map<number, { mean: number; std: number }> = new Map();
  private dayOfWeekFactors: Map<number, number> = new Map();
  private trend: SimpleRegression = new SimpleRegression();

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
      // History that averages zero gives no day-of-week shape to scale by, and
      // dividing by it would carry NaN into every prediction.
      this.dayOfWeekFactors.set(dow, overallMean === 0 ? 1 : dowMean / overallMean);
    }

    // Fit trend
    const x = data.map((_, i) => i);
    const y = data.map(p => p.value);
    this.trend.fit(x, y);
  }

  predict(timestamp: Date, horizonIndex: number): ForecastQuantiles {
    const hour = timestamp.getHours();
    const dow = timestamp.getDay();

    const hourlyStats = this.hourlyAverages.get(hour) || { mean: 0, std: 0 };
    const dowFactor = this.dayOfWeekFactors.get(dow) || 1;

    // Combine seasonal pattern with trend
    const trendValue = this.trend.predict(horizonIndex);
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

    // If no historical data, use default patterns
    if (historicalData.length === 0) {
      return this.generateDefaultEmissionsForecast(runId, region, horizonHours, intervalMinutes);
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
    return toHistoricalPoints(result.rows || []);
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
    // Generation is always positive.
    return toHistoricalPoints(result.rows || []).map(point => ({
      ...point,
      value: Math.max(0, point.value),
    }));
  }

  /**
   * Get historical price data
   */
  private async getHistoricalPrices(region: string, days: number): Promise<HistoricalDataPoint[]> {
    const db = await getDb();
    if (!db) return [];

    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const country = region.startsWith('NG') ? 'nigeria' : 'tanzania';

    const result = await db.execute<SqlRow>(sql`
      SELECT timestamp, price as value FROM "marketPrices"
      WHERE country = ${country} AND timestamp >= ${startDate}
      ORDER BY timestamp ASC
    `);

    return toHistoricalPoints(result.rows || []);
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

    return toHistoricalPoints(result.rows || []);
  }

  /**
   * Generate default emissions forecast when no historical data
   */
  private generateDefaultEmissionsForecast(
    runId: string,
    region: string,
    horizonHours: number,
    intervalMinutes: number
  ): ForecastResult {
    const points: ForecastPoint[] = [];
    const now = new Date();
    const intervalsCount = (horizonHours * 60) / intervalMinutes;

    // Default emissions pattern (grams CO2 per kWh)
    // Higher during peak hours when less efficient plants are used
    const baseEmissions = region.startsWith('NG') ? 450 : 380; // Nigeria vs Tanzania

    for (let i = 0; i < intervalsCount; i++) {
      const timestamp = new Date(now.getTime() + i * intervalMinutes * 60 * 1000);
      const hour = timestamp.getHours();
      
      let emissionsFactor = 1.0;
      if (hour >= 18 && hour <= 22) {
        emissionsFactor = 1.3; // Peak evening
      } else if (hour >= 6 && hour <= 9) {
        emissionsFactor = 1.15; // Morning peak
      } else if (hour >= 11 && hour <= 15) {
        emissionsFactor = 0.85; // Solar peak (lower emissions)
      } else if (hour >= 0 && hour <= 5) {
        emissionsFactor = 0.9; // Night (baseload)
      }

      const value = baseEmissions * emissionsFactor;
      const uncertainty = value * 0.15; // 15% uncertainty

      points.push({
        timestamp,
        values: {
          p10: value - uncertainty,
          p50: value,
          p90: value + uncertainty,
          mean: value,
          confidence: 60, // Lower confidence for default forecast
        },
      });
    }

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
      metrics: { mae: null, rmse: null, mape: null, metricsEstimated: false },
      createdAt: now,
    };
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
   * Store forecast run and values
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
