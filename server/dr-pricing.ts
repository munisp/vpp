/**
 * Dynamic DR Pricing Engine
 * 
 * Calculates optimal compensation rates based on:
 * - Grid stress levels
 * - Participant availability
 * - Market conditions
 * - Historical performance
 * - Time of day
 */

import { getDb } from './db';
import { gridMonitoring, drParticipants, drResponses, marketPrices } from '../drizzle/schema';
import { desc, gte, sql, eq } from 'drizzle-orm';

interface PricingFactors {
  gridStress: number; // 0-100
  participantAvailability: number; // 0-100
  marketPrice: number; // cents per kWh
  timeOfDay: 'peak' | 'off-peak' | 'shoulder';
  urgency: 'low' | 'medium' | 'high' | 'critical';
  historicalPerformance: number; // 0-100
}

interface PricingResult {
  baseRate: number; // cents per kWh
  adjustedRate: number; // cents per kWh
  multiplier: number;
  factors: {
    gridStressMultiplier: number;
    availabilityMultiplier: number;
    marketMultiplier: number;
    timeMultiplier: number;
    urgencyMultiplier: number;
    performanceBonus: number;
  };
  explanation: string;
}

/**
 * Base compensation rates by event type
 */
const BASE_RATES = {
  peak_shaving: 500, // 5 TZS per kWh
  load_shifting: 400, // 4 TZS per kWh
  emergency: 1000, // 10 TZS per kWh
  economic: 300, // 3 TZS per kWh
};

/**
 * Calculate dynamic compensation rate
 */
export async function calculateDynamicPrice(
  eventType: 'peak_shaving' | 'load_shifting' | 'emergency' | 'economic',
  targetReduction: number,
  startTime: Date
): Promise<PricingResult> {
  const factors = await collectPricingFactors(startTime);
  const baseRate = BASE_RATES[eventType];

  // Calculate multipliers
  const gridStressMultiplier = calculateGridStressMultiplier(factors.gridStress);
  const availabilityMultiplier = calculateAvailabilityMultiplier(factors.participantAvailability);
  const marketMultiplier = calculateMarketMultiplier(factors.marketPrice);
  const timeMultiplier = calculateTimeMultiplier(factors.timeOfDay);
  const urgencyMultiplier = calculateUrgencyMultiplier(factors.urgency);
  const performanceBonus = calculatePerformanceBonus(factors.historicalPerformance);

  // Calculate total multiplier
  const multiplier =
    gridStressMultiplier *
    availabilityMultiplier *
    marketMultiplier *
    timeMultiplier *
    urgencyMultiplier +
    performanceBonus;

  const adjustedRate = Math.round(baseRate * multiplier);

  // Generate explanation
  const explanation = generatePricingExplanation(
    baseRate,
    adjustedRate,
    {
      gridStressMultiplier,
      availabilityMultiplier,
      marketMultiplier,
      timeMultiplier,
      urgencyMultiplier,
      performanceBonus,
    }
  );

  return {
    baseRate,
    adjustedRate,
    multiplier,
    factors: {
      gridStressMultiplier,
      availabilityMultiplier,
      marketMultiplier,
      timeMultiplier,
      urgencyMultiplier,
      performanceBonus,
    },
    explanation,
  };
}

/**
 * Collect pricing factors from various sources
 */
async function collectPricingFactors(startTime: Date): Promise<PricingFactors> {
  const db = await getDb();
  if (!db) {
    // Return default factors if DB unavailable
    return {
      gridStress: 50,
      participantAvailability: 70,
      marketPrice: 500,
      timeOfDay: 'shoulder',
      urgency: 'medium',
      historicalPerformance: 80,
    };
  }

  // Get latest grid status
  const latestGrid = await db
    .select()
    .from(gridMonitoring)
    .orderBy(desc(gridMonitoring.timestamp))
    .limit(1);

  const gridData = latestGrid[0];
  const gridStress = gridData ? calculateGridStress(gridData) : 50;

  // Get participant availability
  const participantAvailability = await calculateParticipantAvailability();

  // Get market price
  const marketPrice = await getMarketPrice(startTime);

  // Determine time of day
  const timeOfDay = getTimeOfDay(startTime);

  // Calculate urgency based on grid status
  const urgency = calculateUrgency(gridData);

  // Get historical performance
  const historicalPerformance = await getHistoricalPerformance();

  return {
    gridStress,
    participantAvailability,
    marketPrice,
    timeOfDay,
    urgency,
    historicalPerformance,
  };
}

/**
 * Calculate grid stress level (0-100)
 */
function calculateGridStress(gridData: any): number {
  if (!gridData) return 50;

  const loadPercentage = (gridData.totalLoad / 10000) * 100; // Assuming 10MW capacity
  const frequencyDeviation = Math.abs(gridData.frequency - 5000) / 50; // Deviation from 50Hz

  // Combine factors
  const stress = (loadPercentage * 0.7 + frequencyDeviation * 0.3);
  return Math.min(100, Math.max(0, stress));
}

/**
 * Calculate participant availability (0-100)
 */
async function calculateParticipantAvailability(): Promise<number> {
  const db = await getDb();
  if (!db) return 70;

  const result = await db
    .select({
      total: sql<number>`COUNT(*)`,
      active: sql<number>`SUM(CASE WHEN ${drParticipants.status} = 'active' THEN 1 ELSE 0 END)`,
    })
    .from(drParticipants);

  const { total, active } = result[0] || { total: 0, active: 0 };
  
  if (total === 0) return 0;
  return Math.round((active / total) * 100);
}

/**
 * Get current market price
 */
async function getMarketPrice(time: Date): Promise<number> {
  const db = await getDb();
  if (!db) return 500; // Default 5 TZS per kWh

  const result = await db
    .select()
    .from(marketPrices)
    .where(gte(marketPrices.timestamp, time))
    .orderBy(marketPrices.timestamp)
    .limit(1);

  return result[0]?.price || 500;
}

/**
 * Determine time of day category
 */
function getTimeOfDay(time: Date): 'peak' | 'off-peak' | 'shoulder' {
  const hour = time.getHours();

  if ((hour >= 6 && hour < 10) || (hour >= 18 && hour < 22)) {
    return 'peak';
  } else if (hour >= 22 || hour < 6) {
    return 'off-peak';
  } else {
    return 'shoulder';
  }
}

/**
 * Calculate urgency level
 */
function calculateUrgency(gridData: any): 'low' | 'medium' | 'high' | 'critical' {
  if (!gridData) return 'medium';

  if (gridData.gridStatus === 'emergency') return 'critical';
  if (gridData.gridStatus === 'critical') return 'high';
  if (gridData.gridStatus === 'stressed') return 'medium';
  return 'low';
}

/**
 * Get historical performance score
 */
async function getHistoricalPerformance(): Promise<number> {
  const db = await getDb();
  if (!db) return 80;

  // Calculate average performance from past DR events
  const result = await db
    .select({
      avgPerformance: sql<number>`AVG(
        CASE 
          WHEN ${drResponses.actualReduction} >= ${drResponses.targetReduction} THEN 100
          WHEN ${drResponses.actualReduction} IS NULL THEN 0
          ELSE (${drResponses.actualReduction} * 100.0 / ${drResponses.targetReduction})
        END
      )`,
    })
    .from(drResponses)
    .where(gte(drResponses.responseTime, sql`(NOW() - INTERVAL '30 day')`));

  return Math.round(result[0]?.avgPerformance || 80);
}

/**
 * Calculate grid stress multiplier (0.8 - 2.0)
 */
function calculateGridStressMultiplier(gridStress: number): number {
  // Higher stress = higher multiplier
  return 0.8 + (gridStress / 100) * 1.2;
}

/**
 * Calculate availability multiplier (0.9 - 1.3)
 */
function calculateAvailabilityMultiplier(availability: number): number {
  // Lower availability = higher multiplier (scarcity premium)
  return 1.3 - (availability / 100) * 0.4;
}

/**
 * Calculate market multiplier (0.8 - 1.5)
 */
function calculateMarketMultiplier(marketPrice: number): number {
  // Higher market price = higher DR compensation
  const basePrice = 500; // 5 TZS per kWh
  return 0.8 + ((marketPrice - basePrice) / basePrice) * 0.7;
}

/**
 * Calculate time of day multiplier
 */
function calculateTimeMultiplier(timeOfDay: 'peak' | 'off-peak' | 'shoulder'): number {
  switch (timeOfDay) {
    case 'peak':
      return 1.3;
    case 'shoulder':
      return 1.0;
    case 'off-peak':
      return 0.8;
  }
}

/**
 * Calculate urgency multiplier
 */
function calculateUrgencyMultiplier(urgency: 'low' | 'medium' | 'high' | 'critical'): number {
  switch (urgency) {
    case 'critical':
      return 2.0;
    case 'high':
      return 1.5;
    case 'medium':
      return 1.0;
    case 'low':
      return 0.9;
  }
}

/**
 * Calculate performance bonus (0 - 0.2)
 */
function calculatePerformanceBonus(performance: number): number {
  // Reward high performers with up to 20% bonus
  return (performance / 100) * 0.2;
}

/**
 * Generate human-readable pricing explanation
 */
function generatePricingExplanation(
  baseRate: number,
  adjustedRate: number,
  factors: any
): string {
  const parts: string[] = [];
  
  parts.push(`Base rate: ${(baseRate / 100).toFixed(2)} TZS/kWh`);
  
  if (factors.gridStressMultiplier > 1.1) {
    parts.push(`+${((factors.gridStressMultiplier - 1) * 100).toFixed(0)}% grid stress`);
  }
  
  if (factors.availabilityMultiplier > 1.1) {
    parts.push(`+${((factors.availabilityMultiplier - 1) * 100).toFixed(0)}% low availability`);
  }
  
  if (factors.marketMultiplier > 1.1) {
    parts.push(`+${((factors.marketMultiplier - 1) * 100).toFixed(0)}% high market price`);
  }
  
  if (factors.timeMultiplier > 1.0) {
    parts.push(`+${((factors.timeMultiplier - 1) * 100).toFixed(0)}% peak time`);
  }
  
  if (factors.urgencyMultiplier > 1.2) {
    parts.push(`+${((factors.urgencyMultiplier - 1) * 100).toFixed(0)}% urgency`);
  }
  
  if (factors.performanceBonus > 0.05) {
    parts.push(`+${(factors.performanceBonus * 100).toFixed(0)}% performance bonus`);
  }
  
  parts.push(`= ${(adjustedRate / 100).toFixed(2)} TZS/kWh`);
  
  return parts.join(' ');
}

/**
 * Get pricing recommendation for event
 */
export async function getPricingRecommendation(
  eventType: 'peak_shaving' | 'load_shifting' | 'emergency' | 'economic',
  targetReduction: number,
  startTime: Date
): Promise<{
  recommended: PricingResult;
  minimum: number;
  maximum: number;
  optimal: number;
}> {
  const recommended = await calculateDynamicPrice(eventType, targetReduction, startTime);
  
  // Calculate range
  const minimum = Math.round(recommended.baseRate * 0.8);
  const maximum = Math.round(recommended.baseRate * 2.5);
  const optimal = recommended.adjustedRate;
  
  return {
    recommended,
    minimum,
    maximum,
    optimal,
  };
}
