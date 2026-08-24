/**
 * Grid Operator Integration
 * 
 * Provides APIs for grid operators to monitor VPP status and trigger DR events.
 * Uses real database queries for grid monitoring, asset data, and performance metrics.
 */

import { getDb } from '../db';
import { 
  gridMonitoring, 
  marketPrices, 
  assets, 
  telemetry, 
  demandResponseEvents,
  drResponses,
  trades 
} from '../../drizzle/schema';
import { eq, and, desc, gte, lte, sql, count, sum } from 'drizzle-orm';
import { createDREvent } from '../dr-db';

export interface GridStatus {
  timestamp: Date;
  frequency: number; // Hz
  voltage: number; // V
  load: number; // MW
  capacity: number; // MW
  utilization: number; // percentage
  status: 'normal' | 'warning' | 'critical';
  region: string;
}

export interface PricingSignal {
  timestamp: Date;
  price: number; // cents per kWh
  currency: string;
  validUntil: Date;
  priceType: 'realtime' | 'day_ahead' | 'hour_ahead';
  region: string;
}

export interface DREventTrigger {
  reason: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  targetReduction: number; // kW
  duration: number; // hours
  compensationRate: number; // cents per kWh
  region?: string;
  autoEnroll?: boolean;
}

export interface GridForecast {
  timestamp: Date;
  forecastTime: Date;
  predictedLoad: number; // MW
  predictedCapacity: number; // MW
  predictedUtilization: number; // percentage
  confidence: number; // percentage
  region: string;
}

class GridOperatorService {
  private apiKey: string;
  private operatorId: string;

  constructor() {
    this.apiKey = process.env.GRID_OPERATOR_API_KEY || '';
    this.operatorId = process.env.GRID_OPERATOR_ID || '';
  }

  /**
   * Authenticate grid operator request
   */
  authenticateRequest(apiKey: string): boolean {
    if (!this.apiKey) {
      console.warn('[Grid Operator] API key not configured');
      return false;
    }

    return apiKey === this.apiKey;
  }

  /**
   * Get current grid status from database
   */
  async getGridStatus(region?: string): Promise<GridStatus> {
    const db = await getDb();
    
    // Try to get latest grid monitoring data from database
    if (db) {
      try {
        const latestGrid = await db
          .select()
          .from(gridMonitoring)
          .orderBy(desc(gridMonitoring.timestamp))
          .limit(1);
        
        if (latestGrid.length > 0) {
          const grid = latestGrid[0];
          // Calculate capacity from total generation (assume capacity is 1.2x current generation)
          const estimatedCapacity = Math.max(grid.totalGeneration * 1.2, grid.totalLoad * 1.1);
          const utilization = (grid.totalLoad / estimatedCapacity) * 100;
          
          // Frequency is stored as Hz * 100, convert back
          const frequencyHz = grid.frequency / 100;
          
          let status: 'normal' | 'warning' | 'critical' = 'normal';
          if (utilization > 90 || frequencyHz < 49.5 || frequencyHz > 50.5) {
            status = 'critical';
          } else if (utilization > 80 || frequencyHz < 49.8 || frequencyHz > 50.2) {
            status = 'warning';
          }
          
          const gridStatus: GridStatus = {
            timestamp: grid.timestamp,
            frequency: frequencyHz,
            voltage: grid.voltage,
            load: grid.totalLoad,
            capacity: estimatedCapacity,
            utilization: Math.round(utilization * 10) / 10,
            status,
            region: region || 'TZ-DAR',
          };
          
          console.log('[Grid Operator] Grid status from DB:', gridStatus);
          return gridStatus;
        }
      } catch (error) {
        console.error('[Grid Operator] Error fetching grid status:', error);
      }
    }
    
    // Return default status if no data available
    const defaultStatus: GridStatus = {
      timestamp: new Date(),
      frequency: 50.0,
      voltage: 230.0,
      load: 450,
      capacity: 600,
      utilization: 75,
      status: 'normal',
      region: region || 'TZ-DAR',
    };

    console.log('[Grid Operator] Grid status (default):', defaultStatus);
    return defaultStatus;
  }

  /**
   * Get current pricing signal from database
   */
  async getPricingSignal(region?: string): Promise<PricingSignal> {
    const db = await getDb();
    const now = new Date();
    
    // Try to get latest market price from database
    if (db) {
      try {
        const latestPrice = await db
          .select()
          .from(marketPrices)
          .where(
            and(
              eq(marketPrices.country, region === 'NG' ? 'nigeria' : 'tanzania'),
              lte(marketPrices.timestamp, now),
              gte(marketPrices.validUntil, now)
            )
          )
          .orderBy(desc(marketPrices.timestamp))
          .limit(1);
        
        if (latestPrice.length > 0) {
          const price = latestPrice[0];
          // Currency is determined by country: nigeria = NGN, tanzania = TZS
          const currency = price.country === 'nigeria' ? 'NGN' : 'TZS';
          const pricingSignal: PricingSignal = {
            timestamp: price.timestamp,
            price: price.price,
            currency,
            validUntil: price.validUntil,
            priceType: 'realtime',
            region: region || 'TZ-DAR',
          };
          
          console.log('[Grid Operator] Pricing signal from DB:', pricingSignal);
          return pricingSignal;
        }
      } catch (error) {
        console.error('[Grid Operator] Error fetching pricing signal:', error);
      }
    }
    
    // Calculate default price based on time of day
    const basePrice = 45;
    const hour = now.getHours();
    let priceMultiplier = 1.0;
    
    if (hour >= 18 && hour <= 22) {
      priceMultiplier = 1.5;
    } else if (hour >= 6 && hour <= 9) {
      priceMultiplier = 1.3;
    } else if (hour >= 0 && hour <= 5) {
      priceMultiplier = 0.7;
    }

    const pricingSignal: PricingSignal = {
      timestamp: now,
      price: Math.round(basePrice * priceMultiplier),
      currency: 'TZS',
      validUntil: new Date(now.getTime() + 3600000),
      priceType: 'realtime',
      region: region || 'TZ-DAR',
    };

    console.log('[Grid Operator] Pricing signal (calculated):', pricingSignal);
    return pricingSignal;
  }

  /**
   * Get grid load forecast using historical data
   * Uses rolling mean of historical load data for each hour-of-day
   */
  async getGridForecast(hoursAhead: number = 24, region?: string): Promise<GridForecast[]> {
    const db = await getDb();
    const forecasts: GridForecast[] = [];
    const now = new Date();
    
    // Get historical data for the past 7 days to build hourly averages
    const historicalData: Map<number, { loads: number[]; capacities: number[] }> = new Map();
    
    if (db) {
      try {
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        
        const historicalGrid = await db
          .select()
          .from(gridMonitoring)
          .where(gte(gridMonitoring.timestamp, sevenDaysAgo))
          .orderBy(desc(gridMonitoring.timestamp));
        
        // Group by hour of day
        for (const record of historicalGrid) {
          const hour = record.timestamp.getHours();
          
          if (!historicalData.has(hour)) {
            historicalData.set(hour, { loads: [], capacities: [] });
          }
          
          const hourData = historicalData.get(hour)!;
          hourData.loads.push(record.totalLoad);
          // Estimate capacity from generation (assume capacity is 1.2x current generation)
          const estimatedCapacity = Math.max(record.totalGeneration * 1.2, record.totalLoad * 1.1);
          hourData.capacities.push(estimatedCapacity);
        }
        
        console.log(`[Grid Operator] Loaded ${historicalGrid.length} historical records for forecasting`);
      } catch (error) {
        console.error('[Grid Operator] Error fetching historical data:', error);
      }
    }
    
    // Calculate hourly averages and standard deviations
    const hourlyStats: Map<number, { avgLoad: number; avgCapacity: number; stdDev: number }> = new Map();
    
    historicalData.forEach((data, hour) => {
      if (data.loads.length > 0) {
        const avgLoad = data.loads.reduce((a: number, b: number) => a + b, 0) / data.loads.length;
        const avgCapacity = data.capacities.reduce((a: number, b: number) => a + b, 0) / data.capacities.length;
        
        // Calculate standard deviation for confidence
        const variance = data.loads.reduce((sum: number, val: number) => sum + Math.pow(val - avgLoad, 2), 0) / data.loads.length;
        const stdDev = Math.sqrt(variance);
        
        hourlyStats.set(hour, { avgLoad, avgCapacity, stdDev });
      }
    });
    
    // Generate forecasts
    for (let i = 1; i <= hoursAhead; i++) {
      const forecastTime = new Date(now.getTime() + i * 3600000);
      const hour = forecastTime.getHours();
      
      let predictedLoad: number;
      let predictedCapacity: number;
      let confidence: number;
      
      const stats = hourlyStats.get(hour);
      
      if (stats && stats.avgLoad > 0) {
        // Use historical average with slight randomization for realism
        predictedLoad = stats.avgLoad;
        predictedCapacity = stats.avgCapacity;
        
        // Confidence based on data quality and forecast horizon
        // More data points and closer horizon = higher confidence
        const dataPoints = historicalData.get(hour)?.loads.length || 0;
        const dataConfidence = Math.min(95, 50 + dataPoints * 5); // 50-95% based on data
        const horizonPenalty = i * 0.5; // Lose 0.5% confidence per hour ahead
        const variabilityPenalty = (stats.stdDev / stats.avgLoad) * 20; // Penalty for high variability
        
        confidence = Math.max(30, dataConfidence - horizonPenalty - variabilityPenalty);
      } else {
        // Fallback to time-of-day pattern if no historical data
        const baseLoad = 450; // MW
        const baseCapacity = 600; // MW
        
        let loadMultiplier = 0.8;
        if (hour >= 18 && hour <= 22) {
          loadMultiplier = 1.2; // Evening peak
        } else if (hour >= 6 && hour <= 9) {
          loadMultiplier = 1.1; // Morning peak
        } else if (hour >= 0 && hour <= 5) {
          loadMultiplier = 0.6; // Night low
        }
        
        predictedLoad = baseLoad * loadMultiplier;
        predictedCapacity = baseCapacity;
        confidence = 60 - (i * 0.5); // Lower confidence for fallback
      }
      
      const predictedUtilization = (predictedLoad / predictedCapacity) * 100;
      
      forecasts.push({
        timestamp: now,
        forecastTime,
        predictedLoad: Math.round(predictedLoad * 10) / 10,
        predictedCapacity: Math.round(predictedCapacity * 10) / 10,
        predictedUtilization: Math.round(predictedUtilization * 10) / 10,
        confidence: Math.round(confidence * 10) / 10,
        region: region || 'TZ-DAR',
      });
    }

    console.log(`[Grid Operator] Generated ${forecasts.length} hour forecast using ${historicalData.size > 0 ? 'historical data' : 'fallback patterns'}`);
    return forecasts;
  }

  /**
   * Trigger DR event based on grid conditions
   */
  async triggerDREvent(trigger: DREventTrigger): Promise<{
    success: boolean;
    eventId?: number;
    message?: string;
    error?: string;
  }> {
    try {
      console.log('[Grid Operator] Triggering DR event:', trigger);

      const now = new Date();
      const startTime = new Date(now.getTime() + 15 * 60 * 1000); // 15 min advance notice
      const endTime = new Date(startTime.getTime() + trigger.duration * 60 * 60 * 1000);
      
      // Create DR event using the DR database service
      const eventId = await createDREvent({
        operatorId: parseInt(this.operatorId) || 1,
        eventName: `Grid ${trigger.severity.toUpperCase()}: ${trigger.reason}`,
        eventType: trigger.severity === 'critical' ? 'emergency' : 'economic',
        startTime,
        endTime,
        targetReduction: trigger.targetReduction,
        compensationRate: trigger.compensationRate,
        status: 'scheduled',
        metadata: JSON.stringify({
          triggeredBy: 'grid_operator',
          reason: trigger.reason,
          severity: trigger.severity,
          region: trigger.region,
          autoEnroll: trigger.autoEnroll,
        }),
      });

      return {
        success: true,
        eventId,
        message: `DR event triggered successfully. Starts at ${startTime.toISOString()}`,
      };
    } catch (error: any) {
      console.error('[Grid Operator] Failed to trigger DR event:', error);
      return {
        success: false,
        error: error.message || 'Failed to trigger DR event',
      };
    }
  }

  /**
   * Get VPP aggregate capacity from database
   */
  async getVPPCapacity(region?: string): Promise<{
    totalCapacity: number; // kW
    availableCapacity: number; // kW
    activeAssets: number;
    totalAssets: number;
    region: string;
  }> {
    const db = await getDb();
    
    let totalCapacity = 0;
    let availableCapacity = 0;
    let activeAssets = 0;
    let totalAssets = 0;
    
    if (db) {
      try {
        // Get all assets
        const allAssets = await db
          .select()
          .from(assets)
          .where(eq(assets.status, 'active'));
        
        totalAssets = allAssets.length;
        
        for (const asset of allAssets) {
          // Add capacity (convert Wh to kW, assuming 1 hour discharge)
          totalCapacity += asset.capacity / 1000;
          
          // Get latest telemetry to check if asset is online
          const latestTelemetry = await db
            .select()
            .from(telemetry)
            .where(eq(telemetry.assetId, asset.id))
            .orderBy(desc(telemetry.timestamp))
            .limit(1);
          
          if (latestTelemetry.length > 0) {
            const t = latestTelemetry[0];
            const timeSinceUpdate = Date.now() - t.timestamp.getTime();
            
            // Consider asset active if updated within last 5 minutes
            if (timeSinceUpdate < 5 * 60 * 1000) {
              activeAssets++;
              
              // Calculate available capacity based on state of charge
              if (t.stateOfCharge) {
                availableCapacity += (t.stateOfCharge / 10000) * (asset.capacity / 1000);
              } else {
                availableCapacity += asset.capacity / 1000 * 0.5; // Assume 50% if unknown
              }
            }
          }
        }
      } catch (error) {
        console.error('[Grid Operator] Error fetching VPP capacity:', error);
      }
    }
    
    return {
      totalCapacity: Math.round(totalCapacity),
      availableCapacity: Math.round(availableCapacity),
      activeAssets,
      totalAssets,
      region: region || 'TZ-DAR',
    };
  }

  /**
   * Get VPP performance metrics from database
   */
  async getVPPPerformance(timeWindow: number = 24): Promise<{
    energyDelivered: number; // kWh
    reductionAchieved: number; // kW
    eventsParticipated: number;
    complianceRate: number; // percentage
    revenue: number; // cents
  }> {
    const db = await getDb();
    
    let energyDelivered = 0;
    let reductionAchieved = 0;
    let eventsParticipated = 0;
    let complianceRate = 0;
    let revenue = 0;
    
    if (db) {
      try {
        const startTime = new Date();
        startTime.setHours(startTime.getHours() - timeWindow);
        
        // Get completed DR events in time window
        const completedEvents = await db
          .select()
          .from(demandResponseEvents)
          .where(
            and(
              eq(demandResponseEvents.status, 'completed'),
              gte(demandResponseEvents.endTime, startTime)
            )
          );
        
        eventsParticipated = completedEvents.length;
        
        // Calculate total reduction achieved
        for (const event of completedEvents) {
          if (event.actualReduction) {
            reductionAchieved += event.actualReduction;
          }
        }
        
        // Get trades in time window for energy delivered and revenue
        const recentTrades = await db
          .select()
          .from(trades)
          .where(
            and(
              eq(trades.status, 'executed'),
              gte(trades.timestamp, startTime)
            )
          );
        
        for (const trade of recentTrades) {
          if (trade.tradeType === 'export' || trade.tradeType === 'p2p_sell') {
            energyDelivered += trade.energy / 1000; // Convert Wh to kWh
            revenue += trade.totalAmount;
          }
        }
        
        // Calculate compliance rate from DR responses
        const responses = await db
          .select()
          .from(drResponses)
          .where(gte(drResponses.createdAt, startTime));
        
        if (responses.length > 0) {
          const participated = responses.filter(r => r.participationStatus === 'opted_in').length;
          complianceRate = (participated / responses.length) * 100;
        }
      } catch (error) {
        console.error('[Grid Operator] Error fetching VPP performance:', error);
      }
    }
    
    return {
      energyDelivered: Math.round(energyDelivered),
      reductionAchieved: Math.round(reductionAchieved),
      eventsParticipated,
      complianceRate: Math.round(complianceRate * 10) / 10,
      revenue: Math.round(revenue),
    };
  }

  /**
   * Validate configuration
   */
  validateConfig(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!this.apiKey) {
      errors.push('GRID_OPERATOR_API_KEY is not configured');
    }
    if (!this.operatorId) {
      errors.push('GRID_OPERATOR_ID is not configured');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

// Singleton instance
export const gridOperatorService = new GridOperatorService();
