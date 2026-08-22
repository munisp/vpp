/**
 * DR Forecasting Engine
 * 
 * Analyzes historical data and predicts DR potential
 */

import { getDb } from './db';
import { drForecasts, gridMonitoring, telemetry, drResponses, demandResponseEvents } from '../drizzle/schema';
import { desc, gte, lte, and, sql } from 'drizzle-orm';

interface ForecastInput {
  targetDate: Date;
  targetHour: number;
  temperature?: number;
  weatherCondition?: string;
}

interface ForecastResult {
  predictedLoad: number;
  predictedPeak: number;
  drPotential: number;
  confidence: number;
  gridStatus: 'normal' | 'stressed' | 'critical';
  recommendedAction: 'none' | 'monitor' | 'prepare_event' | 'trigger_event';
  recommendedReduction?: number;
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
    // No historical data, use conservative estimates
    return {
      predictedLoad: 5000, // 5 MW default
      predictedPeak: 6000,
      drPotential: 500, // 500 kW
      confidence: 30,
      gridStatus: 'normal',
      recommendedAction: 'none',
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

  // Determine grid status based on predicted load vs capacity
  const GRID_CAPACITY = 10000; // 10 MW assumed capacity
  const loadPercentage = (predictedLoad / GRID_CAPACITY) * 100;

  let gridStatus: 'normal' | 'stressed' | 'critical';
  let recommendedAction: 'none' | 'monitor' | 'prepare_event' | 'trigger_event';
  let recommendedReduction: number | undefined;

  if (loadPercentage > 90) {
    gridStatus = 'critical';
    recommendedAction = 'trigger_event';
    recommendedReduction = Math.ceil((predictedLoad - GRID_CAPACITY * 0.85) / 100) * 100;
  } else if (loadPercentage > 80) {
    gridStatus = 'stressed';
    recommendedAction = 'prepare_event';
    recommendedReduction = Math.ceil((predictedLoad - GRID_CAPACITY * 0.75) / 100) * 100;
  } else if (loadPercentage > 70) {
    gridStatus = 'normal';
    recommendedAction = 'monitor';
  } else {
    gridStatus = 'normal';
    recommendedAction = 'none';
  }

  // Calculate confidence based on data availability
  const confidence = Math.min(95, 50 + (relevantData.length * 5));

  return {
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

    // Save to database
    await saveForecast(input, result);
  }

  console.log(`Generated ${forecasts.length} forecasts for next 24 hours`);
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
