/**
 * Grid Operator Integration
 *
 * Provides APIs for grid operators to monitor VPP status and trigger DR events.
 * Uses real database queries for grid monitoring, asset data, and performance
 * metrics.
 *
 * Platform rule: real data or fail loud. When the underlying measurement does
 * not exist (empty grid_monitoring, no current market price, thin history,
 * unknown state of charge), these endpoints report `available: false` /
 * `insufficientHistory: true` with a reason, or throw a named
 * GridOperatorError. They never emit plausible-looking invented values, and a
 * region is never silently defaulted — it comes from caller input or from a
 * real user profile via resolveRegionForUser (see server/services/regions.ts).
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
import { eq, and, desc, gte, lte } from 'drizzle-orm';
import { createDREvent } from '../dr-db';
import { COUNTRY_TO_REGION, resolveRegionForUser } from '../services/regions';

/** Named error for grid-operator failures; messages carry a machine-readable prefix. */
export class GridOperatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GridOperatorError';
  }
}

/** Inverse of COUNTRY_TO_REGION: a pricing region maps to its market-price country. */
const REGION_TO_COUNTRY: Record<string, 'nigeria' | 'tanzania'> = Object.fromEntries(
  Object.entries(COUNTRY_TO_REGION).map(([country, region]) => [
    region,
    country as 'nigeria' | 'tanzania',
  ])
);

/**
 * Minimum grid_monitoring records (last 7 days) before an hourly-average
 * forecast is reported. Precedent: probabilistic-forecasting.ts refuses to fit
 * a model on thin history (MIN_HISTORY_SPAN_DAYS); a handful of samples would
 * produce averages that look measured but are noise.
 */
const MIN_FORECAST_HISTORY_RECORDS = 24;

export interface GridStatus {
  timestamp: Date | null;
  frequency: number | null; // Hz
  voltage: number | null; // V
  load: number | null; // kW, as recorded in grid_monitoring
  capacity: number | null; // null: no grid capacity source exists in the schema
  utilization: number | null; // percentage; null when capacity is unknown
  status: 'normal' | 'warning' | 'critical' | 'unavailable';
  region: string;
  /** false when no real grid monitoring row backs this response. */
  available: boolean;
  /** why the status (or a field within it) is unavailable */
  reason?: string;
}

export interface PricingSignal {
  timestamp: Date | null;
  price: number | null; // cents per kWh
  currency: string | null;
  validUntil: Date | null;
  /**
   * The real stored market price type (marketPrices_price_type enum), or
   * 'unavailable' when no current market price row exists. A computed guess
   * is never labelled 'realtime'.
   */
  priceType: 'off_peak' | 'shoulder' | 'peak' | 'super_peak' | 'unavailable';
  region: string;
  available: boolean;
  reason?: string;
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
  predictedLoad: number; // kW, hourly average of real grid_monitoring rows
  predictedCapacity: number | null; // null: no grid capacity source exists
  predictedUtilization: number | null; // null when capacity is unknown
  confidence: number; // percentage, derived from data volume and variability
  region: string;
}

export interface GridForecastResult {
  forecasts: GridForecast[];
  /**
   * Mirrors the insufficient-history idiom in
   * server/services/probabilistic-forecasting.ts: when true, forecasts is
   * empty and reason says why. Never fabricate a time-of-day pattern instead.
   */
  insufficientHistory: boolean;
  reason?: string;
  region: string;
}

export interface ExcludedAsset {
  assetId: number;
  /** Why the asset could not contribute to available capacity. Never silently dropped. */
  reason: string;
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
   * Region is never assumed. Use the caller's region, else resolve it from a
   * real user profile country; otherwise fail loud with a no_region error.
   */
  private async resolveRegion(region: string | undefined, userId?: number): Promise<string> {
    if (region) return region;
    if (userId !== undefined) {
      const resolved = await resolveRegionForUser(userId);
      if (resolved) return resolved;
    }
    throw new GridOperatorError(
      'no_region: grid operator request carries no region and no user profile with a ' +
        'mappable country; pass an explicit region or a userId with a profile country'
    );
  }

  private unavailableGridStatus(region: string, reason: string): GridStatus {
    console.warn(`[Grid Operator] Grid status unavailable for ${region}: ${reason}`);
    return {
      timestamp: null,
      frequency: null,
      voltage: null,
      load: null,
      capacity: null,
      utilization: null,
      status: 'unavailable',
      region,
      available: false,
      reason,
    };
  }

  /**
   * Get current grid status from database.
   *
   * Every reported metric comes from a real grid_monitoring row. Capacity has
   * no source anywhere in the schema (checked drizzle/schema.ts and
   * drizzle/*-schema.ts), so it is null with a reason rather than estimated
   * from generation or load; utilization cannot be computed without it. When
   * no row exists the whole status is unavailable — never a fabricated
   * "normal" 50 Hz / 230 V reading.
   */
  async getGridStatus(region?: string, userId?: number): Promise<GridStatus> {
    const resolvedRegion = await this.resolveRegion(region, userId);
    const db = await getDb();
    if (!db) {
      return this.unavailableGridStatus(resolvedRegion, 'database unavailable');
    }

    let latestGrid;
    try {
      latestGrid = await db
        .select()
        .from(gridMonitoring)
        .orderBy(desc(gridMonitoring.timestamp))
        .limit(1);
    } catch (error) {
      return this.unavailableGridStatus(
        resolvedRegion,
        `grid monitoring query failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (latestGrid.length === 0) {
      return this.unavailableGridStatus(resolvedRegion, 'no grid monitoring data available');
    }

    const grid = latestGrid[0];
    // Frequency is stored as Hz * 100, convert back
    const frequencyHz = grid.frequency / 100;

    // Use the recorded grid status enum; map it onto this API's vocabulary.
    let status: GridStatus['status'] = 'normal';
    if (grid.gridStatus === 'stressed') {
      status = 'warning';
    } else if (grid.gridStatus === 'critical' || grid.gridStatus === 'emergency') {
      status = 'critical';
    }

    const gridStatus: GridStatus = {
      timestamp: grid.timestamp,
      frequency: frequencyHz,
      voltage: grid.voltage,
      load: grid.totalLoad,
      capacity: null,
      utilization: null,
      status,
      region: resolvedRegion,
      available: true,
      reason:
        'capacity and utilization unavailable: no grid capacity source exists in the schema',
    };

    console.log('[Grid Operator] Grid status from DB:', gridStatus);
    return gridStatus;
  }

  private unavailablePricingSignal(region: string, reason: string): PricingSignal {
    console.warn(`[Grid Operator] Pricing signal unavailable for ${region}: ${reason}`);
    return {
      timestamp: null,
      price: null,
      currency: null,
      validUntil: null,
      priceType: 'unavailable',
      region,
      available: false,
      reason,
    };
  }

  /**
   * Get current pricing signal from database.
   *
   * Only real market_prices rows are reported, with their real stored price
   * type. When no current row exists the signal is priceType 'unavailable'
   * with a null price and a reason — a time-of-day guess is never emitted,
   * and never labelled 'realtime'.
   */
  async getPricingSignal(region?: string, userId?: number): Promise<PricingSignal> {
    const resolvedRegion = await this.resolveRegion(region, userId);
    const now = new Date();

    const country = REGION_TO_COUNTRY[resolvedRegion];
    if (!country) {
      return this.unavailablePricingSignal(
        resolvedRegion,
        `no market price feed is mapped for region '${resolvedRegion}'`
      );
    }

    const db = await getDb();
    if (!db) {
      return this.unavailablePricingSignal(resolvedRegion, 'database unavailable');
    }

    let latestPrice;
    try {
      latestPrice = await db
        .select()
        .from(marketPrices)
        .where(
          and(
            eq(marketPrices.country, country),
            lte(marketPrices.timestamp, now),
            gte(marketPrices.validUntil, now)
          )
        )
        .orderBy(desc(marketPrices.timestamp))
        .limit(1);
    } catch (error) {
      return this.unavailablePricingSignal(
        resolvedRegion,
        `market price query failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (latestPrice.length === 0) {
      return this.unavailablePricingSignal(
        resolvedRegion,
        `no current market price row for ${country}`
      );
    }

    const price = latestPrice[0];
    // Currency is determined by country: nigeria = NGN, tanzania = TZS
    const currency = price.country === 'nigeria' ? 'NGN' : 'TZS';
    const pricingSignal: PricingSignal = {
      timestamp: price.timestamp,
      price: price.price,
      currency,
      validUntil: price.validUntil,
      priceType: price.priceType,
      region: resolvedRegion,
      available: true,
    };

    console.log('[Grid Operator] Pricing signal from DB:', pricingSignal);
    return pricingSignal;
  }

  /**
   * Get grid load forecast using historical data.
   *
   * Forecasts are hourly averages of real grid_monitoring rows from the last
   * 7 days. Hours with no historical samples are omitted, and when history is
   * too thin the result is an empty forecast with insufficientHistory: true
   * and a reason (the same idiom as probabilistic-forecasting.ts) — the old
   * time-of-day fallback pattern with a fabricated 60% confidence is gone.
   * Capacity is null throughout: nothing in the schema measures it.
   */
  async getGridForecast(
    hoursAhead: number = 24,
    region?: string,
    userId?: number
  ): Promise<GridForecastResult> {
    const resolvedRegion = await this.resolveRegion(region, userId);
    const now = new Date();

    const insufficient = (reason: string): GridForecastResult => {
      console.warn(`[Grid Operator] Forecast unavailable for ${resolvedRegion}: ${reason}`);
      return { forecasts: [], insufficientHistory: true, reason, region: resolvedRegion };
    };

    const db = await getDb();
    if (!db) {
      return insufficient('database unavailable');
    }

    let historicalGrid;
    try {
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      historicalGrid = await db
        .select()
        .from(gridMonitoring)
        .where(gte(gridMonitoring.timestamp, sevenDaysAgo))
        .orderBy(desc(gridMonitoring.timestamp));
    } catch (error) {
      return insufficient(
        `grid monitoring query failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (historicalGrid.length === 0) {
      return insufficient('insufficient_history: no grid monitoring data available');
    }
    if (historicalGrid.length < MIN_FORECAST_HISTORY_RECORDS) {
      return insufficient(
        `insufficient_history: ${historicalGrid.length} grid monitoring records in the last 7 days; ` +
          `at least ${MIN_FORECAST_HISTORY_RECORDS} are required`
      );
    }
    if (historicalGrid.every(record => record.totalLoad === 0)) {
      return insufficient('insufficient_history: all recorded loads are zero');
    }

    console.log(
      `[Grid Operator] Loaded ${historicalGrid.length} historical records for forecasting`
    );

    // Group real loads by hour of day
    const hourlyLoads: Map<number, number[]> = new Map();
    for (const record of historicalGrid) {
      const hour = record.timestamp.getHours();
      if (!hourlyLoads.has(hour)) {
        hourlyLoads.set(hour, []);
      }
      hourlyLoads.get(hour)!.push(record.totalLoad);
    }

    // Calculate hourly averages and standard deviations
    const hourlyStats: Map<number, { avgLoad: number; stdDev: number; samples: number }> =
      new Map();
    hourlyLoads.forEach((loads, hour) => {
      const avgLoad = loads.reduce((a, b) => a + b, 0) / loads.length;
      const variance =
        loads.reduce((sum, val) => sum + Math.pow(val - avgLoad, 2), 0) / loads.length;
      hourlyStats.set(hour, { avgLoad, stdDev: Math.sqrt(variance), samples: loads.length });
    });

    // Generate forecasts only for hours backed by real samples
    const forecasts: GridForecast[] = [];
    for (let i = 1; i <= hoursAhead; i++) {
      const forecastTime = new Date(now.getTime() + i * 3600000);
      const hour = forecastTime.getHours();

      const stats = hourlyStats.get(hour);
      if (!stats || stats.avgLoad <= 0) {
        // No real samples for this hour: omit it rather than inventing a
        // time-of-day pattern.
        continue;
      }

      // Confidence from data quality and forecast horizon: more samples and a
      // closer horizon raise it, load variability lowers it.
      const dataConfidence = Math.min(95, 50 + stats.samples * 5);
      const horizonPenalty = i * 0.5;
      const variabilityPenalty = (stats.stdDev / stats.avgLoad) * 20;
      const confidence = Math.max(30, dataConfidence - horizonPenalty - variabilityPenalty);

      forecasts.push({
        timestamp: now,
        forecastTime,
        predictedLoad: Math.round(stats.avgLoad * 10) / 10,
        predictedCapacity: null,
        predictedUtilization: null,
        confidence: Math.round(confidence * 10) / 10,
        region: resolvedRegion,
      });
    }

    if (forecasts.length === 0) {
      return insufficient(
        'insufficient_history: no forecast hour is covered by real grid monitoring samples'
      );
    }

    console.log(
      `[Grid Operator] Generated ${forecasts.length} hour forecast from historical data`
    );
    return { forecasts, insufficientHistory: false, region: resolvedRegion };
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

      // Never attribute an event to an invented operator id.
      const operatorId = parseInt(this.operatorId, 10);
      if (!Number.isFinite(operatorId)) {
        return {
          success: false,
          error:
            'GRID_OPERATOR_ID is not configured or not a number; refusing to create a DR event under an invented operator id',
        };
      }

      const now = new Date();
      const startTime = new Date(now.getTime() + 15 * 60 * 1000); // 15 min advance notice
      const endTime = new Date(startTime.getTime() + trigger.duration * 60 * 60 * 1000);

      // Create DR event using the DR database service
      await createDREvent({
        operatorId,
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
   * Get VPP aggregate capacity from database.
   *
   * Available capacity only counts assets whose state of charge is actually
   * measured in fresh telemetry. An asset with no telemetry, stale telemetry,
   * or a null SoC is excluded and listed with its reason — the old
   * "assume 50% if unknown" fabrication is gone.
   */
  async getVPPCapacity(region?: string, userId?: number): Promise<{
    totalCapacity: number; // kW
    availableCapacity: number; // kW
    activeAssets: number;
    totalAssets: number;
    excluded: ExcludedAsset[];
    region: string;
  }> {
    const resolvedRegion = await this.resolveRegion(region, userId);
    const db = await getDb();
    if (!db) {
      throw new GridOperatorError('vpp_capacity_unavailable: database not available');
    }

    let totalCapacity = 0;
    let availableCapacity = 0;
    let activeAssets = 0;
    let totalAssets = 0;
    const excluded: ExcludedAsset[] = [];

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

        if (latestTelemetry.length === 0) {
          excluded.push({
            assetId: asset.id,
            reason: 'no telemetry recorded; state of charge is unknown',
          });
          continue;
        }

        const t = latestTelemetry[0];
        const timeSinceUpdate = Date.now() - t.timestamp.getTime();

        // Consider asset active only if updated within last 5 minutes
        if (timeSinceUpdate >= 5 * 60 * 1000) {
          excluded.push({
            assetId: asset.id,
            reason: `telemetry is stale (${Math.round(timeSinceUpdate / 60000)} min old); state of charge is unknown`,
          });
          continue;
        }

        activeAssets++;

        // Available capacity from measured state of charge only
        if (t.stateOfCharge === null || t.stateOfCharge === undefined) {
          excluded.push({
            assetId: asset.id,
            reason: 'latest telemetry has no state of charge; available energy is unknown',
          });
          continue;
        }

        availableCapacity += (t.stateOfCharge / 10000) * (asset.capacity / 1000);
      }
    } catch (error) {
      throw new GridOperatorError(
        `vpp_capacity_unavailable: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return {
      totalCapacity: Math.round(totalCapacity),
      availableCapacity: Math.round(availableCapacity),
      activeAssets,
      totalAssets,
      excluded,
      region: resolvedRegion,
    };
  }

  /**
   * Get VPP performance metrics from database.
   *
   * Aggregates over real DR events, responses and trades. Empty tables yield
   * genuine zeros; a missing or failing database fails loud with a named
   * error instead of returning zeros that look measured.
   */
  async getVPPPerformance(timeWindow: number = 24): Promise<{
    energyDelivered: number; // kWh
    reductionAchieved: number; // kW
    eventsParticipated: number;
    complianceRate: number; // percentage
    revenue: number; // cents
  }> {
    const db = await getDb();
    if (!db) {
      throw new GridOperatorError('vpp_performance_unavailable: database not available');
    }

    let energyDelivered = 0;
    let reductionAchieved = 0;
    let eventsParticipated = 0;
    let complianceRate = 0;
    let revenue = 0;

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
      throw new GridOperatorError(
        `vpp_performance_unavailable: ${error instanceof Error ? error.message : String(error)}`
      );
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
