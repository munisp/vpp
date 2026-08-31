/**
 * DR Forecasting Engine
 * 
 * Analyzes historical data and predicts DR potential
 */

import { getDb } from './db';
import { assets, drForecasts, gridMonitoring, telemetry, drResponses, demandResponseEvents } from '../drizzle/schema';
import { desc, gte, lte, and, eq, sql } from 'drizzle-orm';

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

interface ForecastInput {
  targetDate: Date;
  targetHour: number;
  temperature?: number;
  weatherCondition?: string;
}

interface ForecastResult {
  forecastAvailable: boolean; // false when there is no real history to forecast from
  reason?: 'insufficient_history' | 'grid_capacity_unavailable';
  capacityAvailable: boolean; // false when no real registered asset capacity exists
  predictedLoad: number | null;
  predictedPeak: number | null;
  drPotential: number | null;
  confidence: number | null;
  gridStatus: 'normal' | 'stressed' | 'critical' | null;
  recommendedAction: 'none' | 'monitor' | 'prepare_event' | 'trigger_event' | null;
  recommendedReduction?: number;
}

/**
 * Sum real registered asset capacity, converted to kW. Returns null when
 * no capacity is registered — grid-capacity-derived fields are then
 * unavailable rather than computed against an assumed capacity.
 */
async function getRegisteredCapacityKw(db: Db): Promise<number | null> {
  const result = await db
    .select({
      totalCapacityWatts: sql<number>`SUM(${assets.capacity})`,
    })
    .from(assets)
    .where(eq(assets.status, 'active'));

  const totalWatts = result[0]?.totalCapacityWatts;
  if (totalWatts == null || !Number.isFinite(Number(totalWatts)) || Number(totalWatts) <= 0) {
    return null;
  }
  return Number(totalWatts) / 1000; // watts -> kW
}

/**
 * Generate load forecast using historical data
 */
export async function generateLoadForecast(input: ForecastInput): Promise<ForecastResult> {
  const db = await getDb();
  if (!db) {
    throw new Error('Database not available');
  }

  // Get historical data for same hour and day of week
  const dayOfWeek = input.targetDate.getDay();
  const hour = input.targetHour;

  // Get grid monitoring data from past 4 weeks for same hour/day
  const fourWeeksAgo = new Date(input.targetDate);
  fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);

  const historicalData = await db
    .select()
    .from(gridMonitoring)
    .where(
      and(
        gte(gridMonitoring.timestamp, fourWeeksAgo),
        lte(gridMonitoring.timestamp, new Date())
      )
    )
    .orderBy(desc(gridMonitoring.timestamp))
    .limit(100);

  // Filter for same hour and day of week
  const relevantData = historicalData.filter(d => {
    const date = new Date(d.timestamp);
    return date.getDay() === dayOfWeek && date.getHours() === hour;
  });

  if (relevantData.length === 0) {
    // No historical data — NEVER fabricate a plausible forecast. Refuse loudly.
    console.warn(
      `[DR Forecasting] Forecast unavailable for ${input.targetDate.toISOString()} hour ${hour}: insufficient_history (no grid monitoring data for this hour/day)`
    );
    return {
      forecastAvailable: false,
      reason: 'insufficient_history',
      capacityAvailable: false,
      predictedLoad: null,
      predictedPeak: null,
      drPotential: null,
      confidence: null,
      gridStatus: null,
      recommendedAction: null,
    };
  }

  // Calculate average load
  const avgLoad = relevantData.reduce((sum, d) => sum + d.totalLoad, 0) / relevantData.length;
  const maxLoad = Math.max(...relevantData.map(d => d.peakLoad));
  const minLoad = Math.min(...relevantData.map(d => d.totalLoad));

  // Adjust for temperature if provided
  let predictedLoad = avgLoad;
  if (input.temperature) {
    // Simple temperature adjustment: +2% per degree above 30°C
    const tempAdjustment = Math.max(0, (input.temperature / 10 - 30) * 0.02);
    predictedLoad *= (1 + tempAdjustment);
  }

  // Calculate DR potential based on historical participation
  const drPotential = await calculateDRPotential();

  // Determine grid status based on predicted load vs REAL registered capacity.
  // Never assume a capacity — when none is registered, capacity-derived
  // fields (gridStatus / recommendedAction) are explicitly unavailable.
  const registeredCapacityKw = await getRegisteredCapacityKw(db);

  let gridStatus: 'normal' | 'stressed' | 'critical' | null = null;
  let recommendedAction: 'none' | 'monitor' | 'prepare_event' | 'trigger_event' | null = null;
  let recommendedReduction: number | undefined;
  let reason: ForecastResult['reason'];

  if (registeredCapacityKw === null) {
    reason = 'grid_capacity_unavailable';
    console.warn(
      '[DR Forecasting] Grid status unavailable: no registered asset capacity; refusing to assume one'
    );
  } else {
    const loadPercentage = (predictedLoad / registeredCapacityKw) * 100;

    if (loadPercentage > 90) {
      gridStatus = 'critical';
      recommendedAction = 'trigger_event';
      recommendedReduction = Math.ceil((predictedLoad - registeredCapacityKw * 0.85) / 100) * 100;
    } else if (loadPercentage > 80) {
      gridStatus = 'stressed';
      recommendedAction = 'prepare_event';
      recommendedReduction = Math.ceil((predictedLoad - registeredCapacityKw * 0.75) / 100) * 100;
    } else if (loadPercentage > 70) {
      gridStatus = 'normal';
      recommendedAction = 'monitor';
    } else {
      gridStatus = 'normal';
      recommendedAction = 'none';
    }
  }

  // Calculate confidence based on data availability
  const confidence = Math.min(95, 50 + (relevantData.length * 5));

  return {
    forecastAvailable: true,
    reason,
    capacityAvailable: registeredCapacityKw !== null,
    predictedLoad: Math.round(predictedLoad),
    predictedPeak: Math.round(maxLoad * 1.1), // 10% above historical max
    drPotential: Math.round(drPotential),
    confidence,
    gridStatus,
    recommendedAction,
    recommendedReduction,
  };
}

/**
 * Calculate available DR potential based on enrolled participants
 */
async function calculateDRPotential(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  // Get total power from recent telemetry
  const result = await db
    .select({
      totalPower: sql<number>`SUM(${telemetry.power})`,
    })
    .from(telemetry)
    .where(gte(telemetry.timestamp, sql`(NOW() - INTERVAL '1 hour')`));

  const totalPower = result[0]?.totalPower || 0;

  // Assume 20% of total power is available for DR (in kW)
  return Math.round((totalPower / 1000) * 0.2);
}

/**
 * Save forecast to database
 */
export async function saveForecast(
  input: ForecastInput,
  result: ForecastResult
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  // NEVER persist a fabricated or partial forecast as if it were real.
  // The dr_forecasts schema requires non-null predictions and its
  // grid_status enum has no 'unavailable' value, so an unavailable
  // forecast simply cannot be represented honestly — skip it loudly.
  if (
    !result.forecastAvailable ||
    result.predictedLoad === null ||
    result.predictedPeak === null ||
    result.drPotential === null ||
    result.confidence === null ||
    result.gridStatus === null ||
    result.recommendedAction === null
  ) {
    console.warn(
      `[DR Forecasting] NOT persisting forecast for ${input.targetDate.toISOString()} hour ${input.targetHour}: ` +
      `forecast unavailable (reason: ${result.reason ?? 'missing_fields'}) — refusing to store a fabricated forecast row`
    );
    return;
  }

  await db.insert(drForecasts).values({
    forecastDate: input.targetDate,
    forecastHour: input.targetHour,
    predictedLoad: result.predictedLoad,
    predictedPeak: result.predictedPeak,
    drPotential: result.drPotential,
    confidence: result.confidence,
    gridStatus: result.gridStatus,
    temperature: input.temperature,
    weatherCondition: input.weatherCondition,
    recommendedAction: result.recommendedAction,
    recommendedReduction: result.recommendedReduction,
  });
}

/**
 * Generate forecasts for next 24 hours
 */
export async function generateDailyForecasts(): Promise<void> {
  const now = new Date();
  const forecasts: Array<{ input: ForecastInput; result: ForecastResult }> = [];

  for (let hour = 0; hour < 24; hour++) {
    const targetDate = new Date(now);
    targetDate.setDate(targetDate.getDate() + 1);
    targetDate.setHours(hour, 0, 0, 0);

    const input: ForecastInput = {
      targetDate,
      targetHour: hour,
    };

    const result = await generateLoadForecast(input);
    forecasts.push({ input, result });

    // Save to database (saveForecast refuses to persist unavailable forecasts)
    await saveForecast(input, result);
  }

  const availableCount = forecasts.filter(f => f.result.forecastAvailable).length;
  console.log(
    `Generated ${availableCount} real forecasts for next 24 hours; ` +
    `${forecasts.length - availableCount} hours unavailable (insufficient history) and NOT persisted`
  );
}

/**
 * Get latest forecast for a specific hour
 */
export async function getLatestForecast(targetDate: Date, targetHour: number) {
  const db = await getDb();
  if (!db) return null;

  const result = await db
    .select()
    .from(drForecasts)
    .where(
      and(
        gte(drForecasts.forecastDate, targetDate),
        lte(drForecasts.forecastDate, new Date(targetDate.getTime() + 24 * 60 * 60 * 1000)),
        sql`${drForecasts.forecastHour} = ${targetHour}`
      )
    )
    .orderBy(desc(drForecasts.createdAt))
    .limit(1);

  return result[0] || null;
}

/**
 * Get forecasts for next N hours
 */
export async function getUpcomingForecasts(hours: number = 24) {
  const db = await getDb();
  if (!db) return [];

  const now = new Date();
  const endTime = new Date(now.getTime() + hours * 60 * 60 * 1000);

  const result = await db
    .select()
    .from(drForecasts)
    .where(
      and(
        gte(drForecasts.forecastDate, now),
        lte(drForecasts.forecastDate, endTime)
      )
    )
    .orderBy(drForecasts.forecastDate, drForecasts.forecastHour);

  return result;
}
