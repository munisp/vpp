/**
 * Scoring forecasts against what actually happened.
 *
 * The platform can already produce probabilistic forecasts, but until now
 * nothing checked them: `forecast_runs.mae_value` and friends were written null
 * and the confidence a forecast advertised came from the model's own residuals,
 * which is a statement about how well it fit history rather than how well it
 * predicted. A grid operator asked to dispatch on that number has no reason to
 * believe it, and that is the documented reason utilities derate VPP capacity.
 *
 * This module closes the loop. Once a run's horizon has elapsed, its P50 is
 * compared point-by-point against the same actuals series the model was trained
 * on, and the result is stored with its sample count and the source of the
 * actuals. Two numbers matter beyond error:
 *
 *   - `biasValue` — signed mean error. A forecast that is wrong symmetrically is
 *     a precision problem; one that is consistently high is a capacity claim
 *     that will not be delivered.
 *   - `coverageBp` — how often the actual fell inside the advertised P10-P90
 *     band. A calibrated 80% band sits near 8000 basis points. Well below means
 *     the stated uncertainty is fiction; well above (with a wide
 *     `intervalWidthValue`) means the band is padded to be trivially right.
 *
 * Nothing here fabricates a score. A run whose actuals never arrived is stored
 * as `insufficient_actuals` with the sample count that was available, because a
 * MAPE computed over two points reads as accuracy while measuring nothing.
 */

import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { getDb } from '../db';
import { forecastAccuracy } from '../../drizzle/forecast-accuracy-schema';
import type { SqlRow } from '../sql-row';

/**
 * Minimum paired points before a run is scored. Four covers an hour of 15-minute
 * intervals; below that the metrics are dominated by a single point.
 */
export const MIN_SCORING_SAMPLES = 4;

/** A calibrated P10-P90 band should contain this share of actuals. */
export const TARGET_COVERAGE_BP = 8000;

export type ForecastActualSource =
  | 'telemetry'
  | 'grid_monitoring'
  | 'market_prices'
  | 'emissions_factors';

export interface ScoredPair {
  timestamp: Date;
  actual: number;
  p10: number;
  p50: number;
  p90: number;
}

export interface ForecastScore {
  runId: string;
  status: 'scored' | 'insufficient_actuals';
  sampleCount: number;
  /** Null on `insufficient_actuals`: an unmeasured run reports no metrics. */
  mae: number | null;
  rmse: number | null;
  mapeBp: number | null;
  bias: number | null;
  coverageBp: number | null;
  intervalWidth: number | null;
  scoredThrough: Date;
  actualSource: ForecastActualSource;
}

export class ForecastScoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForecastScoringError';
  }
}

interface ForecastRunRow {
  run_id: string;
  surrogate_id: number;
  forecast_type: string;
  scope_type: string;
  scope_id: number | null;
  region: string | null;
  model_version: string;
  interval_minutes: number;
}

interface ForecastValueRow {
  forecast_time: string | Date;
  p10_value: number;
  p50_value: number;
  p90_value: number;
}

interface ActualRow {
  timestamp: string | Date;
  value: number | string | null;
}

/** Forecast values are persisted as their unit * 100. */
const VALUE_SCALE = 100;

/**
 * Which series a forecast type is answerable to. A load forecast scored against
 * market prices would produce a number, which is exactly why the mapping is
 * explicit rather than inferred at the call site.
 */
export function actualSourceFor(
  forecastType: string,
  scopeType: string
): ForecastActualSource {
  switch (forecastType) {
    case 'load':
    case 'solar_generation':
    case 'wind_generation':
    case 'net_load':
      return scopeType === 'region' ? 'grid_monitoring' : 'telemetry';
    case 'price':
      return 'market_prices';
    case 'emissions':
      return 'emissions_factors';
    default:
      throw new ForecastScoringError(
        `No actuals series is defined for forecast type '${forecastType}', so it cannot be scored`
      );
  }
}

/**
 * Pair forecast points with actuals, matching each forecast time to the nearest
 * actual within half an interval. Anything further away is a different period,
 * and silently pairing it would score the model against the wrong hour.
 */
export function pairWithActuals(
  values: Array<{ timestamp: Date; p10: number; p50: number; p90: number }>,
  actuals: Array<{ timestamp: Date; value: number }>,
  intervalMinutes: number
): ScoredPair[] {
  if (actuals.length === 0) return [];

  const toleranceMs = (intervalMinutes * 60 * 1000) / 2;
  const sorted = [...actuals].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const pairs: ScoredPair[] = [];

  for (const point of values) {
    const target = point.timestamp.getTime();
    let best: { timestamp: Date; value: number } | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const actual of sorted) {
      const distance = Math.abs(actual.timestamp.getTime() - target);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = actual;
      } else if (actual.timestamp.getTime() > target) {
        // Sorted ascending: distance only grows from here.
        break;
      }
    }

    if (best && bestDistance <= toleranceMs) {
      pairs.push({
        timestamp: point.timestamp,
        actual: best.value,
        p10: point.p10,
        p50: point.p50,
        p90: point.p90,
      });
    }
  }

  return pairs;
}

/**
 * Error, bias and calibration of a paired series.
 *
 * MAPE skips pairs whose actual is zero rather than dividing by it: a night-time
 * solar interval is not a 100% error, and including it would make every solar
 * forecast look broken. `mapeBp` is null when no pair had a non-zero actual.
 */
export function computeMetrics(pairs: ScoredPair[]): {
  mae: number;
  rmse: number;
  mapeBp: number | null;
  bias: number;
  coverageBp: number;
  intervalWidth: number;
} {
  const n = pairs.length;
  if (n === 0) {
    throw new ForecastScoringError('Cannot compute metrics over zero pairs');
  }

  let absError = 0;
  let squaredError = 0;
  let signedError = 0;
  let percentSum = 0;
  let percentCount = 0;
  let covered = 0;
  let widthSum = 0;

  for (const pair of pairs) {
    const error = pair.p50 - pair.actual;
    absError += Math.abs(error);
    squaredError += error * error;
    signedError += error;
    if (pair.actual !== 0) {
      percentSum += Math.abs(error / pair.actual);
      percentCount += 1;
    }
    if (pair.actual >= pair.p10 && pair.actual <= pair.p90) covered += 1;
    widthSum += pair.p90 - pair.p10;
  }

  return {
    mae: absError / n,
    rmse: Math.sqrt(squaredError / n),
    mapeBp: percentCount === 0 ? null : Math.round((percentSum / percentCount) * 10000),
    bias: signedError / n,
    coverageBp: Math.round((covered / n) * 10000),
    intervalWidth: widthSum / n,
  };
}

async function loadRun(runId: string): Promise<ForecastRunRow> {
  const db = await getDb();
  if (!db) throw new ForecastScoringError('Database not available');

  const result = await db.execute<SqlRow>(sql`
    SELECT run_id, id AS surrogate_id, forecast_type, scope_type, scope_id,
           region, model_version, interval_minutes
    FROM forecast_runs WHERE run_id = ${runId}
  `);
  const row = result.rows?.[0];
  if (!row) throw new ForecastScoringError(`Forecast run ${runId} not found`);
  return row as unknown as ForecastRunRow;
}

async function loadValues(
  surrogateId: number
): Promise<Array<{ timestamp: Date; p10: number; p50: number; p90: number }>> {
  const db = await getDb();
  if (!db) throw new ForecastScoringError('Database not available');

  const result = await db.execute<SqlRow>(sql`
    SELECT forecast_time, p10_value, p50_value, p90_value
    FROM forecast_values WHERE run_id = ${surrogateId}
    ORDER BY forecast_time ASC
  `);

  return (result.rows as unknown as ForecastValueRow[]).map((row) => ({
    timestamp: new Date(row.forecast_time),
    p10: Number(row.p10_value) / VALUE_SCALE,
    p50: Number(row.p50_value) / VALUE_SCALE,
    p90: Number(row.p90_value) / VALUE_SCALE,
  }));
}

/**
 * Read the actuals a run is answerable to over the forecast window. The queries
 * mirror the historical series the forecast was trained on, so a score compares
 * like with like.
 */
async function loadActuals(
  run: ForecastRunRow,
  source: ForecastActualSource,
  from: Date,
  to: Date
): Promise<Array<{ timestamp: Date; value: number }>> {
  const db = await getDb();
  if (!db) throw new ForecastScoringError('Database not available');

  let query;
  switch (source) {
    case 'telemetry':
      if (run.scope_type === 'asset' && run.scope_id != null) {
        query = sql`
          SELECT timestamp, power AS value FROM telemetry
          WHERE "assetId" = ${run.scope_id} AND timestamp >= ${from} AND timestamp <= ${to}
          ORDER BY timestamp ASC
        `;
      } else if (run.scope_type === 'user' && run.scope_id != null) {
        query = sql`
          SELECT t.timestamp, SUM(t.power) AS value FROM telemetry t
          JOIN assets a ON a.id = t."assetId"
          WHERE a."userId" = ${run.scope_id} AND t.timestamp >= ${from} AND t.timestamp <= ${to}
          GROUP BY t.timestamp
          ORDER BY t.timestamp ASC
        `;
      } else {
        throw new ForecastScoringError(
          `Scope ${run.scope_type}=${run.scope_id} has no telemetry series to score against`
        );
      }
      break;
    case 'grid_monitoring':
      query = sql`
        SELECT timestamp, total_load AS value FROM grid_monitoring
        WHERE timestamp >= ${from} AND timestamp <= ${to}
        ORDER BY timestamp ASC
      `;
      break;
    case 'market_prices': {
      if (!run.region) {
        throw new ForecastScoringError('A price forecast without a region cannot be scored');
      }
      const country = run.region.startsWith('NG') ? 'nigeria' : 'tanzania';
      query = sql`
        SELECT timestamp, price AS value FROM "marketPrices"
        WHERE country = ${country} AND timestamp >= ${from} AND timestamp <= ${to}
        ORDER BY timestamp ASC
      `;
      break;
    }
    case 'emissions_factors':
      if (!run.region) {
        throw new ForecastScoringError('An emissions forecast without a region cannot be scored');
      }
      query = sql`
        SELECT timestamp, marginal_emissions AS value FROM emissions_factors
        WHERE region = ${run.region} AND timestamp >= ${from} AND timestamp <= ${to}
        ORDER BY timestamp ASC
      `;
      break;
  }

  const result = await db.execute<SqlRow>(query);
  return (result.rows as unknown as ActualRow[])
    .filter((row) => row.value != null)
    .map((row) => ({
      timestamp: new Date(row.timestamp),
      value: Number(row.value),
    }));
}

/**
 * Score one forecast run against actuals and persist the result.
 *
 * Idempotent per run: re-scoring overwrites the row, so a run scored while its
 * actuals were still arriving improves rather than duplicating.
 */
export async function scoreForecastRun(runId: string): Promise<ForecastScore> {
  const db = await getDb();
  if (!db) throw new ForecastScoringError('Database not available');

  const run = await loadRun(runId);
  const values = await loadValues(run.surrogate_id);
  if (values.length === 0) {
    throw new ForecastScoringError(`Forecast run ${runId} stored no values, so there is nothing to score`);
  }

  const source = actualSourceFor(run.forecast_type, run.scope_type);
  const intervalMinutes = Number(run.interval_minutes) || 15;
  const scoredThrough = values[values.length - 1].timestamp;
  // Widen the actuals window by the pairing tolerance at both ends. Telemetry
  // rarely lands exactly on an interval boundary, and a window that stops at the
  // last forecast time leaves the final point of every run permanently unpaired.
  const toleranceMs = (intervalMinutes * 60 * 1000) / 2;
  const actuals = await loadActuals(
    run,
    source,
    new Date(values[0].timestamp.getTime() - toleranceMs),
    new Date(scoredThrough.getTime() + toleranceMs)
  );
  const pairs = pairWithActuals(values, actuals, intervalMinutes);

  const scored = pairs.length >= MIN_SCORING_SAMPLES;
  const metrics = scored ? computeMetrics(pairs) : null;

  const score: ForecastScore = {
    runId,
    status: scored ? 'scored' : 'insufficient_actuals',
    sampleCount: pairs.length,
    mae: metrics?.mae ?? null,
    rmse: metrics?.rmse ?? null,
    mapeBp: metrics?.mapeBp ?? null,
    bias: metrics?.bias ?? null,
    coverageBp: metrics?.coverageBp ?? null,
    intervalWidth: metrics?.intervalWidth ?? null,
    scoredThrough,
    actualSource: source,
  };

  const scaled = (value: number | null) =>
    value === null ? null : Math.round(value * VALUE_SCALE);

  await db
    .insert(forecastAccuracy)
    .values({
      runId,
      forecastType: run.forecast_type,
      scopeType: run.scope_type,
      scopeId: run.scope_id,
      region: run.region,
      modelVersion: run.model_version,
      actualSource: source,
      status: score.status,
      sampleCount: score.sampleCount,
      maeValue: scaled(score.mae),
      rmseValue: scaled(score.rmse),
      mapeBp: score.mapeBp,
      biasValue: scaled(score.bias),
      coverageBp: score.coverageBp,
      intervalWidthValue: scaled(score.intervalWidth),
      scoredThrough,
    })
    .onConflictDoUpdate({
      target: forecastAccuracy.runId,
      set: {
        status: score.status,
        sampleCount: score.sampleCount,
        maeValue: scaled(score.mae),
        rmseValue: scaled(score.rmse),
        mapeBp: score.mapeBp,
        biasValue: scaled(score.bias),
        coverageBp: score.coverageBp,
        intervalWidthValue: scaled(score.intervalWidth),
        scoredThrough,
        scoredAt: new Date(),
      },
    });

  // Keep the run's own metric columns consistent with the score so existing
  // readers of `forecast_runs` see measured values instead of nulls.
  if (metrics) {
    await db.execute(sql`
      UPDATE forecast_runs
      SET mae_value = ${scaled(metrics.mae)},
          rmse_value = ${scaled(metrics.rmse)},
          mape_value = ${metrics.mapeBp === null ? null : Math.round(metrics.mapeBp / 100)}
      WHERE run_id = ${runId}
    `);
  }

  return score;
}

/**
 * Score every run whose horizon has fully elapsed and that has not been scored
 * since. Intended for a periodic worker; returns what it scored so a caller can
 * see whether actuals are arriving at all.
 */
export async function scoreDueForecastRuns(limit = 25): Promise<ForecastScore[]> {
  const db = await getDb();
  if (!db) throw new ForecastScoringError('Database not available');

  const due = await db.execute<SqlRow>(sql`
    SELECT r.run_id
    FROM forecast_runs r
    LEFT JOIN forecast_accuracy a ON a.run_id = r.run_id
    WHERE r.status = 'completed'
      AND r.created_at + (r.forecast_horizon_hours * INTERVAL '1 hour') < NOW()
      AND (a.id IS NULL OR a.status = 'insufficient_actuals')
    ORDER BY r.created_at ASC
    LIMIT ${limit}
  `);

  const scores: ForecastScore[] = [];
  for (const row of due.rows as unknown as Array<{ run_id: string }>) {
    try {
      scores.push(await scoreForecastRun(row.run_id));
    } catch (error) {
      // A run whose type has no actuals series must not stop the sweep, but it
      // is never recorded as scored either.
      console.error(
        `[ForecastAccuracy] Could not score ${row.run_id}:`,
        error instanceof Error ? error.message : error
      );
    }
  }
  return scores;
}

export interface AccuracySummaryRow {
  forecastType: string;
  scopeType: string;
  scopeId: number | null;
  modelVersion: string;
  scoredRuns: number;
  sampleCount: number;
  /** Sample-weighted, so a run scored on four points cannot outvote one scored on ninety-six. */
  mae: number | null;
  rmse: number | null;
  mapeBp: number | null;
  bias: number | null;
  coverageBp: number | null;
  intervalWidth: number | null;
  /** Runs whose actuals never arrived. High counts mean the score is thin, not good. */
  unmeasuredRuns: number;
  lastScoredAt: Date | null;
}

/**
 * Rolling accuracy per forecast type and model version.
 *
 * `unmeasuredRuns` is reported alongside the metrics on purpose: a type with
 * excellent numbers over two scored runs and forty unmeasured ones is not a
 * type anyone should dispatch on.
 */
export async function getAccuracySummary(options: {
  sinceDays?: number;
  scopeType?: string;
  scopeId?: number;
} = {}): Promise<AccuracySummaryRow[]> {
  const db = await getDb();
  if (!db) throw new ForecastScoringError('Database not available');

  const since = new Date(Date.now() - (options.sinceDays ?? 30) * 24 * 60 * 60 * 1000);
  const conditions = [gte(forecastAccuracy.scoredAt, since)];
  if (options.scopeType) conditions.push(eq(forecastAccuracy.scopeType, options.scopeType));
  if (options.scopeId != null) conditions.push(eq(forecastAccuracy.scopeId, options.scopeId));

  const rows = await db
    .select()
    .from(forecastAccuracy)
    .where(and(...conditions))
    .orderBy(desc(forecastAccuracy.scoredAt));

  const groups = new Map<string, AccuracySummaryRow & { weight: number; mapeWeight: number }>();

  for (const row of rows) {
    const key = `${row.forecastType}|${row.scopeType}|${row.scopeId ?? ''}|${row.modelVersion}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        forecastType: row.forecastType,
        scopeType: row.scopeType,
        scopeId: row.scopeId,
        modelVersion: row.modelVersion,
        scoredRuns: 0,
        sampleCount: 0,
        mae: null,
        rmse: null,
        mapeBp: null,
        bias: null,
        coverageBp: null,
        intervalWidth: null,
        unmeasuredRuns: 0,
        lastScoredAt: null,
        weight: 0,
        mapeWeight: 0,
      };
      groups.set(key, group);
    }

    if (!group.lastScoredAt || row.scoredAt > group.lastScoredAt) {
      group.lastScoredAt = row.scoredAt;
    }

    if (row.status !== 'scored') {
      group.unmeasuredRuns += 1;
      continue;
    }

    const weight = row.sampleCount;
    group.scoredRuns += 1;
    group.sampleCount += weight;
    group.weight += weight;
    group.mae = (group.mae ?? 0) + (row.maeValue ?? 0) * weight;
    group.rmse = (group.rmse ?? 0) + (row.rmseValue ?? 0) * weight;
    group.bias = (group.bias ?? 0) + (row.biasValue ?? 0) * weight;
    group.coverageBp = (group.coverageBp ?? 0) + (row.coverageBp ?? 0) * weight;
    group.intervalWidth = (group.intervalWidth ?? 0) + (row.intervalWidthValue ?? 0) * weight;
    if (row.mapeBp != null) {
      // MAPE carries its own weight: a run whose actuals were all zero has no MAPE,
      // and dividing by the full sample weight would report a smaller percentage
      // error than any run actually measured.
      group.mapeBp = (group.mapeBp ?? 0) + row.mapeBp * weight;
      group.mapeWeight += weight;
    }
  }

  return [...groups.values()].map((group) => {
    const { weight, mapeWeight, ...summary } = group;
    if (weight === 0) return summary;
    const divide = (total: number | null, scale: number, by: number = weight) =>
      total === null || by === 0 ? null : total / by / scale;
    return {
      ...summary,
      mae: divide(summary.mae, VALUE_SCALE),
      rmse: divide(summary.rmse, VALUE_SCALE),
      bias: divide(summary.bias, VALUE_SCALE),
      intervalWidth: divide(summary.intervalWidth, VALUE_SCALE),
      mapeBp: divide(summary.mapeBp, 1, mapeWeight),
      coverageBp: divide(summary.coverageBp, 1),
    };
  });
}

/** Scores for specific runs, for a per-forecast detail view. */
export async function getScoresForRuns(runIds: string[]) {
  const db = await getDb();
  if (!db) throw new ForecastScoringError('Database not available');
  if (runIds.length === 0) return [];

  return db
    .select()
    .from(forecastAccuracy)
    .where(inArray(forecastAccuracy.runId, runIds));
}
