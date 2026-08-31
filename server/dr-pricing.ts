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
import { assets, gridMonitoring, drParticipants, drResponses, marketPrices } from '../drizzle/schema';
import { desc, gte, sql, eq } from 'drizzle-orm';

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

interface PricingFactors {
  gridStress: number | null; // 0-100, null when no real grid data/capacity
  gridStressAvailable: boolean;
  participantAvailability: number | null; // 0-100, null when unavailable
  availabilityAvailable: boolean;
  marketPrice: number | null; // cents per kWh, null when no real price row
  priceAvailable: boolean;
  timeOfDay: 'peak' | 'off-peak' | 'shoulder'; // derived from clock — always real
  urgency: 'low' | 'medium' | 'high' | 'critical' | null; // null without grid data
  urgencyAvailable: boolean;
  historicalPerformance: number | null; // 0-100, null without response history
  performanceAvailable: boolean;
}

interface PricingResult {
  pricingAvailable: boolean; // false when any input factor is unavailable — no fabricated price
  unavailableFactors: string[]; // named reasons for refusal
  baseRate: number; // cents per kWh (policy constant, always known)
  adjustedRate: number | null; // cents per kWh, null when pricingAvailable=false
  multiplier: number | null; // null when pricingAvailable=false
  factors: {
    gridStressMultiplier: number | null;
    availabilityMultiplier: number | null;
    marketMultiplier: number | null;
    timeMultiplier: number;
    urgencyMultiplier: number | null;
    performanceBonus: number | null;
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

  // Calculate multipliers only from factors backed by real data
  const gridStressMultiplier = factors.gridStressAvailable && factors.gridStress !== null
    ? calculateGridStressMultiplier(factors.gridStress)
    : null;
  const availabilityMultiplier = factors.availabilityAvailable && factors.participantAvailability !== null
    ? calculateAvailabilityMultiplier(factors.participantAvailability)
    : null;
  const marketMultiplier = factors.priceAvailable && factors.marketPrice !== null
    ? calculateMarketMultiplier(factors.marketPrice)
    : null;
  const timeMultiplier = calculateTimeMultiplier(factors.timeOfDay);
  const urgencyMultiplier = factors.urgencyAvailable && factors.urgency !== null
    ? calculateUrgencyMultiplier(factors.urgency)
    : null;
  const performanceBonus = factors.performanceAvailable && factors.historicalPerformance !== null
    ? calculatePerformanceBonus(factors.historicalPerformance)
    : null;

  // Never produce a plausible-looking price from missing inputs — refuse loudly.
  const unavailableFactors: string[] = [];
  if (gridStressMultiplier === null) unavailableFactors.push('grid_stress_unavailable');
  if (availabilityMultiplier === null) unavailableFactors.push('participant_availability_unavailable');
  if (marketMultiplier === null) unavailableFactors.push('no_market_price');
  if (urgencyMultiplier === null) unavailableFactors.push('grid_urgency_unavailable');
  if (performanceBonus === null) unavailableFactors.push('no_performance_history');

  const pricingAvailable = unavailableFactors.length === 0;

  if (!pricingAvailable) {
    return {
      pricingAvailable: false,
      unavailableFactors,
      baseRate,
      adjustedRate: null,
      multiplier: null,
      factors: {
        gridStressMultiplier,
        availabilityMultiplier,
        marketMultiplier,
        timeMultiplier,
        urgencyMultiplier,
        performanceBonus,
      },
      explanation:
        `Pricing UNAVAILABLE — refusing to fabricate a rate. Missing real inputs: ${unavailableFactors.join(', ')}.`,
    };
  }

  // Calculate total multiplier (all factors verified available above)
  const multiplier =
    gridStressMultiplier! *
    availabilityMultiplier! *
    marketMultiplier! *
    timeMultiplier *
    urgencyMultiplier! +
    performanceBonus!;

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
    pricingAvailable: true,
    unavailableFactors: [],
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
    // Never fabricate a plausible factor set when the DB is down — fail loudly.
    throw new Error('Database not available: cannot collect real pricing factors');
  }

  // Get latest grid status
  const latestGrid = await db
    .select()
    .from(gridMonitoring)
    .orderBy(desc(gridMonitoring.timestamp))
    .limit(1);

  const gridData = latestGrid[0];

  // Real registered capacity (kW) from the assets table — no assumed capacity
  const registeredCapacityKw = await getRegisteredCapacityKw(db);
  const gridStress = gridData && registeredCapacityKw !== null
    ? calculateGridStress(gridData, registeredCapacityKw)
    : null;

  // Get participant availability
  const participantAvailability = await calculateParticipantAvailability(db);

  // Get market price (null when no real price row exists)
  const marketPrice = await getMarketPrice(db, startTime);

  // Determine time of day
  const timeOfDay = getTimeOfDay(startTime);

  // Calculate urgency based on grid status
  const urgency = calculateUrgency(gridData);

  // Get historical performance
  const historicalPerformance = await getHistoricalPerformance(db);

  return {
    gridStress,
    gridStressAvailable: gridStress !== null,
    participantAvailability,
    availabilityAvailable: participantAvailability !== null,
    marketPrice,
    priceAvailable: marketPrice !== null,
    timeOfDay,
    urgency,
    urgencyAvailable: urgency !== null,
    historicalPerformance,
    performanceAvailable: historicalPerformance !== null,
  };
}

/**
 * Sum real registered asset capacity, converted to kW.
 * Returns null when no capacity is registered — capacity is then unavailable.
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
 * Calculate grid stress level (0-100) from real grid data and real
 * registered capacity. Returns null when either is unavailable.
 */
function calculateGridStress(gridData: any, registeredCapacityKw: number): number | null {
  if (!gridData || registeredCapacityKw <= 0) return null;

  const loadPercentage = (gridData.totalLoad / registeredCapacityKw) * 100;
  const frequencyDeviation = Math.abs(gridData.frequency - 5000) / 50; // Deviation from 50Hz

  // Combine factors
  const stress = (loadPercentage * 0.7 + frequencyDeviation * 0.3);
  return Math.min(100, Math.max(0, stress));
}

/**
 * Calculate participant availability (0-100) from real enrollment rows
 */
async function calculateParticipantAvailability(db: Db): Promise<number | null> {
  const result = await db
    .select({
      total: sql<number>`COUNT(*)`,
      active: sql<number>`SUM(CASE WHEN ${drParticipants.status} = 'active' THEN 1 ELSE 0 END)`,
    })
    .from(drParticipants);

  if (!result[0]) return null;

  const total = Number(result[0].total) || 0;
  const active = Number(result[0].active) || 0;

  if (total === 0) return 0; // Real fact: zero participants registered
  return Math.round((active / total) * 100);
}

/**
 * Get current market price. Returns null when no real price row exists —
 * we never fall back to an invented price.
 */
async function getMarketPrice(db: Db, time: Date): Promise<number | null> {
  const result = await db
    .select()
    .from(marketPrices)
    .where(gte(marketPrices.timestamp, time))
    .orderBy(marketPrices.timestamp)
    .limit(1);

  return result[0]?.price ?? null;
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
function calculateUrgency(gridData: any): 'low' | 'medium' | 'high' | 'critical' | null {
  if (!gridData) return null; // No real grid data → urgency unavailable

  if (gridData.gridStatus === 'emergency') return 'critical';
  if (gridData.gridStatus === 'critical') return 'high';
  if (gridData.gridStatus === 'stressed') return 'medium';
  return 'low';
}

/**
 * Get historical performance score
 */
async function getHistoricalPerformance(db: Db): Promise<number | null> {
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

  // AVG() returns null when there are no response rows — no real history
  // means performance is unavailable, not an invented 80.
  const avg = result[0]?.avgPerformance;
  if (avg == null || !Number.isFinite(Number(avg))) return null;
  return Math.round(Number(avg));
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
  pricingAvailable: boolean;
  unavailableFactors: string[];
  recommended: PricingResult;
  minimum: number | null;
  maximum: number | null;
  optimal: number | null;
}> {
  const recommended = await calculateDynamicPrice(eventType, targetReduction, startTime);

  // Never quote a price range when the recommended price is fabricated-free
  // refusal — propagate the unavailable state instead.
  if (!recommended.pricingAvailable || recommended.adjustedRate === null) {
    return {
      pricingAvailable: false,
      unavailableFactors: recommended.unavailableFactors,
      recommended,
      minimum: null,
      maximum: null,
      optimal: null,
    };
  }

  // Calculate range
  const minimum = Math.round(recommended.baseRate * 0.8);
  const maximum = Math.round(recommended.baseRate * 2.5);
  const optimal = recommended.adjustedRate;

  return {
    pricingAvailable: true,
    unavailableFactors: [],
    recommended,
    minimum,
    maximum,
    optimal,
  };
}
