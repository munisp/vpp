/**
 * Carbon-Aware Dispatch Service
 * 
 * Provides emissions-optimized dispatch decisions, carbon tracking,
 * and renewable energy certificate management.
 */

import { getDb } from '../db';
import { sql } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { probabilisticForecasting } from './probabilistic-forecasting';
import { kafkaPublisher } from '../integration/kafka-publisher';
import type { SqlRow } from '../sql-row';
import { jsonSetText } from '../sql-json';

// Types for carbon tracking
export interface EmissionsFactor {
  id: number;
  region: string;
  timestamp: Date;
  validUntil: Date;
  marginalEmissions: number; // grams CO2 per kWh
  averageEmissions: number;
  renewablePercent: number | null;
  coalPercent: number | null;
  gasPercent: number | null;
  nuclearPercent: number | null;
  dataSource: string | null;
  // Only 'live' factors from the emissions_factors table are ever returned;
  // hardcoded regional fallbacks were removed (they were fabricated data).
  emissionFactorSource: 'live';
}

export interface CarbonCredit {
  id: number;
  userId: number;
  creditType: 'rec' | 'carbon_offset' | 'green_certificate' | 'i_rec';
  certificateId: string | null;
  energyMwh: number | null;
  carbonTonnes: number | null;
  generationSource: string | null;
  generationPeriodStart: Date | null;
  generationPeriodEnd: Date | null;
  registry: string | null;
  registryUrl: string | null;
  status: 'pending' | 'issued' | 'transferred' | 'retired' | 'cancelled';
  blockchainProof: string | null;
}

export interface CarbonImpactReport {
  userId: number;
  periodStart: Date;
  periodEnd: Date;
  // Emissions-derived fields are null when no live emissions_factors data
  // exists for the user's region/timestamps; energy fields are always real
  // telemetry totals. Callers must render null as "unavailable".
  totalEmissionsAvoided: number | null; // grams CO2
  totalRenewableGeneration: number; // Wh
  totalGridExport: number; // Wh
  totalGridImport: number; // Wh
  netCarbonImpact: number | null; // grams CO2 (negative = net reduction)
  equivalentTreesPlanted: number | null;
  equivalentMilesDriven: number | null;
  creditsEarned: number;
  emissionsFactorSource: 'live' | 'unavailable';
  breakdown: {
    byAsset: Array<{ assetId: number; assetName: string; emissionsAvoided: number | null }>;
    byService: Array<{ service: string; emissionsAvoided: number | null }>;
    byHour: Array<{ hour: number; emissionsAvoided: number | null; marginalRate: number | null }>;
  };
}

export interface CarbonOptimizedDispatch {
  assetId: number;
  intervalStart: Date;
  intervalEnd: Date;
  recommendedPowerWatts: number;
  marginalEmissions: number;
  emissionsImpact: number; // grams CO2 saved (positive) or added (negative)
  // null: no real carbon price source exists on the platform, so no monetary
  // value is computed (never valued against an invented price).
  carbonValue: number | null;
  // From the real forecast quantiles; null when the forecast provides none.
  confidence: number | null;
  reason: string;
}

export type CarbonOptimizedDispatchResult =
  | {
      adviceAvailable: true;
      region: string;
      carbonPriceAvailable: boolean;
      recommendations: CarbonOptimizedDispatch[];
    }
  | {
      adviceAvailable: false;
      reason: 'no_region' | 'forecast_unavailable';
      carbonPriceAvailable: false;
      recommendations: [];
    };

// users.country -> emissions_factors.region codes (same mapping used by
// server/services/carbon-credits.ts). Region is never guessed beyond the
// user's recorded country.
const COUNTRY_TO_REGION: Record<string, string> = {
  nigeria: 'NG-LAGOS',
  tanzania: 'TZ-DAR',
};

export class CarbonAwareDispatchService {
  
  /**
   * Ingest emissions factor data
   */
  async ingestEmissionsFactor(
    region: string,
    data: {
      timestamp: Date;
      validUntil: Date;
      marginalEmissions: number;
      averageEmissions: number;
      renewablePercent?: number;
      coalPercent?: number;
      gasPercent?: number;
      nuclearPercent?: number;
      dataSource?: string;
    }
  ): Promise<EmissionsFactor> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const result = await db.execute<SqlRow>(sql`
      INSERT INTO emissions_factors (
        region, timestamp, valid_until,
        marginal_emissions, average_emissions,
        renewable_percent, coal_percent, gas_percent, nuclear_percent,
        data_source, created_at
      ) VALUES (
        ${region}, ${data.timestamp}, ${data.validUntil},
        ${data.marginalEmissions}, ${data.averageEmissions},
        ${data.renewablePercent || null}, ${data.coalPercent || null},
        ${data.gasPercent || null}, ${data.nuclearPercent || null},
        ${data.dataSource || null}, NOW()
      )
      RETURNING id
    `);

    // Publish to Kafka for lakehouse analytics
    try {
      await kafkaPublisher.publishCarbonSignal({
        signalId: `signal-${region}-${Date.now()}`,
        signalType: 'emissions_factor',
        gridIntensityGco2Kwh: data.marginalEmissions,
        region,
        timestamp: new Date(),
      });
    } catch (error) {
      console.error('[CarbonAwareDispatch] Error publishing to Kafka:', error);
    }

    return {
      id: Number(result.rows[0].id),
      region,
      ...data,
      renewablePercent: data.renewablePercent || null,
      coalPercent: data.coalPercent || null,
      gasPercent: data.gasPercent || null,
      nuclearPercent: data.nuclearPercent || null,
      dataSource: data.dataSource || null,
      emissionFactorSource: 'live',
    };
  }

  /**
   * Get current emissions factor for a region
   */
  async getCurrentEmissions(region: string): Promise<EmissionsFactor | null> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const result = await db.execute<SqlRow>(sql`
      SELECT * FROM emissions_factors
      WHERE region = ${region}
        AND timestamp <= NOW()
        AND valid_until > NOW()
      ORDER BY timestamp DESC
      LIMIT 1
    `);

    const row = result.rows[0];
    if (!row) {
      // No live emissions data for this region — report unavailable instead
      // of returning a fabricated regional default.
      return null;
    }

    return this.mapRowToEmissionsFactor(row);
  }

  /**
   * Resolve the emissions region for a user from their recorded country.
   * Returns null when the user (or their country mapping) cannot be resolved;
   * callers must treat that as "no advice", never substitute a guess.
   */
  async resolveRegionForUser(userId: number): Promise<string | null> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const result = await db.execute<SqlRow>(sql`
      SELECT country FROM users WHERE id = ${userId} LIMIT 1
    `);
    const country = result.rows[0]?.country;
    if (!country) return null;
    return COUNTRY_TO_REGION[country] || null;
  }

  /**
   * Real carbon price in cents per tonne CO2, or null when unavailable.
   * There is currently no carbon market price source on the platform (no
   * carbon price table/service; market_prices holds electricity tariffs
   * only), so this always returns null until a real source is integrated.
   * carbonValue stays null rather than being priced against an invented
   * constant.
   */
  private async getRealCarbonPriceCentsPerTonne(_region: string): Promise<number | null> {
    return null;
  }

  /**
   * Get carbon-optimized dispatch recommendations
   */
  async getCarbonOptimizedDispatch(
    userId: number,
    horizonHours: number = 24,
    intervalMinutes: number = 15
  ): Promise<CarbonOptimizedDispatchResult> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Region comes from the user's recorded country; without it there is no
    // honest basis for region-specific advice.
    const region = await this.resolveRegionForUser(userId);
    if (!region) {
      return { adviceAvailable: false, reason: 'no_region', carbonPriceAvailable: false, recommendations: [] };
    }

    // Get user's assets
    const assetsResult = await db.execute<SqlRow>(sql`
      SELECT a.id, a."assetType", a.capacity, a.name,
             dc.max_power_export, dc.max_power_import
      FROM assets a
      LEFT JOIN der_capabilities dc ON dc.asset_id = a.id
      WHERE a."userId" = ${userId} AND a.status = 'active'
    `);
    const assets = assetsResult.rows || [];

    // Get emissions forecast. Defensive: the forecasting service is being
    // migrated to report forecastAvailable:false instead of fabricated data —
    // treat an explicit unavailable flag, a failure, or empty points as
    // "no forecast" and never fall back to constants.
    let emissionsForecast: Awaited<ReturnType<typeof probabilisticForecasting.forecastEmissions>> | null = null;
    try {
      emissionsForecast = await probabilisticForecasting.forecastEmissions(region, horizonHours, 60);
    } catch (error) {
      console.error('[CarbonDispatch] Emissions forecast failed:', error);
      emissionsForecast = null;
    }
    const forecastPoints =
      emissionsForecast &&
      (emissionsForecast as { forecastAvailable?: boolean }).forecastAvailable !== false &&
      Array.isArray(emissionsForecast.points)
        ? emissionsForecast.points
        : [];
    if (forecastPoints.length === 0) {
      return { adviceAvailable: false, reason: 'forecast_unavailable', carbonPriceAvailable: false, recommendations: [] };
    }

    // Real carbon price, if any (currently none — see method comment).
    const carbonPriceCentsPerTonne = await this.getRealCarbonPriceCentsPerTonne(region);
    const carbonPriceAvailable = carbonPriceCentsPerTonne !== null;

    const recommendations: CarbonOptimizedDispatch[] = [];
    const now = new Date();
    const intervalsCount = Math.floor((horizonHours * 60) / intervalMinutes);

    // Average emissions for comparison (derived from the real forecast points)
    const avgEmissions = forecastPoints.reduce((sum, p) => sum + p.values.p50, 0) / forecastPoints.length;

    for (let i = 0; i < intervalsCount; i++) {
      const intervalStart = new Date(now.getTime() + i * intervalMinutes * 60000);
      const intervalEnd = new Date(intervalStart.getTime() + intervalMinutes * 60000);

      // Map this interval onto the hourly forecast points
      const forecastIndex = Math.floor((i * intervalMinutes) / 60);
      const emissionsPoint = forecastPoints[forecastIndex];
      const marginalEmissions = emissionsPoint?.values.p50 ?? avgEmissions;

      for (const asset of assets) {
        const maxExport = asset.max_power_export || asset.capacity;
        const maxImport = asset.max_power_import || asset.capacity;

        let recommendedPower = 0;
        let reason = '';

        // High emissions period - export to displace dirty generation
        if (marginalEmissions > avgEmissions * 1.15) {
          if (asset.assetType === 'battery') {
            recommendedPower = maxExport * 0.8;
            reason = 'High grid emissions - discharge battery to displace dirty generation';
          } else if (asset.assetType === 'solar') {
            recommendedPower = maxExport;
            reason = 'High grid emissions - maximize solar export';
          }
        }
        // Low emissions period - import/charge with clean energy
        else if (marginalEmissions < avgEmissions * 0.85) {
          if (asset.assetType === 'battery') {
            recommendedPower = -maxImport * 0.8;
            reason = 'Low grid emissions - charge battery with clean energy';
          }
        }
        // Normal period - moderate dispatch
        else {
          if (asset.assetType === 'solar') {
            recommendedPower = maxExport * 0.5;
            reason = 'Normal emissions - partial solar export';
          }
        }

        if (Math.abs(recommendedPower) > 100) { // Minimum 100W threshold
          const energyWh = (recommendedPower * intervalMinutes) / 60;
          const emissionsImpact = Math.round((energyWh / 1000) * marginalEmissions);
          const carbonValue = carbonPriceCentsPerTonne !== null
            ? Math.round((emissionsImpact / 1000000) * carbonPriceCentsPerTonne)
            : null;

          recommendations.push({
            assetId: asset.id,
            intervalStart,
            intervalEnd,
            recommendedPowerWatts: Math.round(recommendedPower),
            marginalEmissions,
            emissionsImpact: recommendedPower > 0 ? emissionsImpact : -emissionsImpact,
            carbonValue: carbonValue !== null
              ? (recommendedPower > 0 ? carbonValue : -carbonValue)
              : null,
            confidence: emissionsPoint?.values.confidence ?? null,
            reason,
          });
        }
      }
    }

    console.log(`[CarbonDispatch] Generated ${recommendations.length} carbon-optimized recommendations for user ${userId}`);

    return { adviceAvailable: true, region, carbonPriceAvailable, recommendations };
  }

  /**
   * Calculate carbon impact report for a user
   */
  async calculateCarbonImpact(
    userId: number,
    periodStart: Date,
    periodEnd: Date
  ): Promise<CarbonImpactReport> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Region from the user's recorded country; null means no emissions rates
    // can be looked up and emissions-derived fields will report unavailable.
    const region = await this.resolveRegionForUser(userId);

    // Get user's energy data
    const telemetryResult = await db.execute<SqlRow>(sql`
      SELECT 
        a.id as asset_id, a.name as asset_name, a."assetType",
        t.timestamp, t.power, t.energy
      FROM telemetry t
      JOIN assets a ON a.id = t."assetId"
      WHERE a."userId" = ${userId}
        AND t.timestamp >= ${periodStart}
        AND t.timestamp <= ${periodEnd}
      ORDER BY t.timestamp
    `);
    const telemetry = telemetryResult.rows || [];

    // Get settlement events for services
    const settlementResult = await db.execute<SqlRow>(sql`
      SELECT * FROM settlement_events
      WHERE user_id = ${userId}
        AND created_at >= ${periodStart}
        AND created_at <= ${periodEnd}
    `);
    const settlements = settlementResult.rows || [];

    // Calculate totals
    let totalEmissionsAvoided = 0;
    let totalRenewableGeneration = 0;
    let totalGridExport = 0;
    let totalGridImport = 0;

    const byAsset: Map<number, { name: string; emissionsAvoided: number }> = new Map();
    const byService: Map<string, number> = new Map();
    const byHour: Map<number, { emissionsAvoided: number; marginalRate: number; count: number }> = new Map();

    let importEmissions = 0;
    // Set whenever an emissions rate was needed but no live data existed;
    // emissions-derived report fields then become null ("unavailable").
    let emissionsLookupFailed = false;

    // Process telemetry
    for (const t of telemetry) {
      const hour = new Date(t.timestamp).getHours();
      const power = t.power || 0;

      // Emissions rate for this timestamp from stored data only; null when
      // no live factor exists (never a fabricated fallback).
      const emissionsRate = region ? await this.getEmissionsRateAt(t.timestamp, region) : null;
      if (emissionsRate === null) emissionsLookupFailed = true;

      // Calculate energy for 5-minute interval (typical telemetry interval)
      const energyWh = (power * 5) / 60;

      if (power > 0) {
        // Export - avoiding grid emissions
        totalGridExport += energyWh;

        if (emissionsRate !== null) {
          const avoided = (energyWh / 1000) * emissionsRate;
          totalEmissionsAvoided += avoided;

          // Track by asset
          const assetData = byAsset.get(t.asset_id) || { name: t.asset_name, emissionsAvoided: 0 };
          assetData.emissionsAvoided += avoided;
          byAsset.set(t.asset_id, assetData);

          // Track by hour
          const hourData = byHour.get(hour) || { emissionsAvoided: 0, marginalRate: 0, count: 0 };
          hourData.emissionsAvoided += avoided;
          hourData.marginalRate += emissionsRate;
          hourData.count++;
          byHour.set(hour, hourData);
        }

        // Track renewable generation
        if (t.assetType === 'solar' || t.assetType === 'wind') {
          totalRenewableGeneration += energyWh;
        }
      } else {
        // Import - adding grid emissions
        totalGridImport += Math.abs(energyWh);
        if (emissionsRate !== null) {
          importEmissions += (Math.abs(energyWh) / 1000) * emissionsRate;
        }
      }
    }

    // Process settlement events for service-based emissions
    for (const s of settlements) {
      if (s.energy_wh && s.energy_wh > 0) {
        const service = s.event_type || 'other';
        const currentService = byService.get(service) || 0;

        // Emissions avoided at the event's actual rate; null rate means the
        // service breakdown cannot be computed honestly.
        const eventRate = region && s.created_at ? await this.getEmissionsRateAt(new Date(s.created_at), region) : null;
        if (eventRate === null) {
          emissionsLookupFailed = true;
          continue;
        }
        const avoided = (s.energy_wh / 1000) * eventRate;
        byService.set(service, currentService + avoided);
      }
    }

    const emissionsAvailable = !emissionsLookupFailed;

    // Calculate net impact
    const netCarbonImpact = emissionsAvailable ? Math.round(importEmissions - totalEmissionsAvoided) : null;

    // Calculate equivalents (conversion factors are fixed physical constants,
    // but only applied to real emissions totals)
    const equivalentTreesPlanted = emissionsAvailable ? Math.round(totalEmissionsAvoided / 21000) : null; // ~21kg CO2 per tree per year
    const equivalentMilesDriven = emissionsAvailable ? Math.round(totalEmissionsAvoided / 404) : null; // ~404g CO2 per mile

    // Calculate credits earned (1 credit per MWh of renewable generation)
    const creditsEarned = Math.floor(totalRenewableGeneration / 1000000);

    // Format breakdown (emissions fields null when unavailable)
    const breakdown = {
      byAsset: Array.from(byAsset.entries()).map(([assetId, data]) => ({
        assetId,
        assetName: data.name,
        emissionsAvoided: emissionsAvailable ? Math.round(data.emissionsAvoided) : null,
      })),
      byService: Array.from(byService.entries()).map(([service, emissionsAvoided]) => ({
        service,
        emissionsAvoided: emissionsAvailable ? Math.round(emissionsAvoided) : null,
      })),
      byHour: Array.from(byHour.entries()).map(([hour, data]) => ({
        hour,
        emissionsAvoided: emissionsAvailable ? Math.round(data.emissionsAvoided) : null,
        marginalRate: emissionsAvailable && data.count > 0 ? Math.round(data.marginalRate / data.count) : null,
      })).sort((a, b) => a.hour - b.hour),
    };

    return {
      userId,
      periodStart,
      periodEnd,
      totalEmissionsAvoided: emissionsAvailable ? Math.round(totalEmissionsAvoided) : null,
      totalRenewableGeneration: Math.round(totalRenewableGeneration),
      totalGridExport: Math.round(totalGridExport),
      totalGridImport: Math.round(totalGridImport),
      netCarbonImpact,
      equivalentTreesPlanted,
      equivalentMilesDriven,
      creditsEarned,
      emissionsFactorSource: emissionsAvailable ? 'live' : 'unavailable',
      breakdown,
    };
  }

  /**
   * Get emissions rate at a specific timestamp from stored emissions_factors
   * data only. Returns null when no live factor covers the timestamp — never
   * a fabricated fallback.
   */
  private async getEmissionsRateAt(timestamp: Date, region: string): Promise<number | null> {
    const db = await getDb();
    if (!db) return null;

    const result = await db.execute<SqlRow>(sql`
      SELECT marginal_emissions FROM emissions_factors
      WHERE region = ${region}
        AND timestamp <= ${timestamp}
        AND valid_until > ${timestamp}
      ORDER BY timestamp DESC
      LIMIT 1
    `);

    const row = result.rows[0];
    return row?.marginal_emissions ?? null;
  }

  /**
   * Issue a carbon credit/REC
   */
  async issueCarbonCredit(
    userId: number,
    credit: {
      creditType: 'rec' | 'carbon_offset' | 'green_certificate' | 'i_rec';
      energyMwh?: number;
      carbonTonnes?: number;
      generationSource?: string;
      generationPeriodStart?: Date;
      generationPeriodEnd?: Date;
      registry?: string;
    }
  ): Promise<CarbonCredit> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const certificateId = `${credit.creditType.toUpperCase()}_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`;

    const result = await db.execute<SqlRow>(sql`
      INSERT INTO carbon_credits (
        user_id, credit_type, certificate_id,
        energy_mwh, carbon_tonnes, generation_source,
        generation_period_start, generation_period_end,
        registry, status, created_at, updated_at
      ) VALUES (
        ${userId}, ${credit.creditType}, ${certificateId},
        ${credit.energyMwh || null}, ${credit.carbonTonnes || null},
        ${credit.generationSource || null},
        ${credit.generationPeriodStart || null}, ${credit.generationPeriodEnd || null},
        ${credit.registry || null}, 'issued', NOW(), NOW()
      )
      RETURNING id
    `);

    console.log(`[CarbonDispatch] Issued ${credit.creditType} credit ${certificateId} for user ${userId}`);

    return {
      id: Number(result.rows[0].id),
      userId,
      creditType: credit.creditType,
      certificateId,
      energyMwh: credit.energyMwh || null,
      carbonTonnes: credit.carbonTonnes || null,
      generationSource: credit.generationSource || null,
      generationPeriodStart: credit.generationPeriodStart || null,
      generationPeriodEnd: credit.generationPeriodEnd || null,
      registry: credit.registry || null,
      registryUrl: null,
      status: 'issued',
      blockchainProof: null,
    };
  }

  /**
   * Get user's carbon credits
   */
  async getUserCredits(userId: number): Promise<CarbonCredit[]> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const result = await db.execute<SqlRow>(sql`
      SELECT * FROM carbon_credits
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `);

    return (result.rows || []).map(this.mapRowToCredit);
  }

  /**
   * Retire a carbon credit
   */
  async retireCredit(creditId: number, reason?: string): Promise<CarbonCredit> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    await db.execute<SqlRow>(sql`
      UPDATE carbon_credits SET
        status = 'retired',
        metadata = ${jsonSetText(sql`metadata`, {
          retiredAt: new Date().toISOString(),
          retireReason: reason || null,
        })},
        updated_at = NOW()
      WHERE id = ${creditId}
    `);

    const result = await db.execute<SqlRow>(sql`SELECT * FROM carbon_credits WHERE id = ${creditId}`);
    return this.mapRowToCredit(result.rows[0]);
  }

  /**
   * Get real-time carbon intensity signal.
   * signalAvailable is false (with null current/recommendation) whenever the
   * live emissions factor or the forecast is unavailable — no fabricated
   * intensity is ever substituted.
   */
  async getCarbonIntensitySignal(region: string): Promise<{
    signalAvailable: boolean;
    current: number | null;
    emissionFactorSource: 'live' | 'unavailable';
    forecast: Array<{ timestamp: Date; intensity: number; confidence: number | null }>;
    recommendation: 'charge' | 'discharge' | 'hold' | null;
    reason: string;
  }> {
    const current = await this.getCurrentEmissions(region);

    // Defensive: treat an explicit unavailable flag, a failure, or empty
    // points as "no forecast".
    let forecastResult: Awaited<ReturnType<typeof probabilisticForecasting.forecastEmissions>> | null = null;
    try {
      forecastResult = await probabilisticForecasting.forecastEmissions(region, 24, 60);
    } catch (error) {
      console.error('[CarbonDispatch] Emissions forecast failed:', error);
      forecastResult = null;
    }
    const forecastPoints =
      forecastResult &&
      (forecastResult as { forecastAvailable?: boolean }).forecastAvailable !== false &&
      Array.isArray(forecastResult.points)
        ? forecastResult.points
        : [];

    const forecast = forecastPoints.slice(0, 24).map(p => ({
      timestamp: p.timestamp,
      intensity: p.values.p50,
      confidence: p.values.confidence ?? null,
    }));

    const currentIntensity = current?.marginalEmissions ?? null;

    if (currentIntensity === null || forecastPoints.length === 0) {
      return {
        signalAvailable: false,
        current: currentIntensity,
        emissionFactorSource: current ? 'live' : 'unavailable',
        forecast,
        recommendation: null,
        reason: currentIntensity === null
          ? 'Carbon intensity unavailable - no live emissions data for region'
          : 'Carbon intensity signal unavailable - emissions forecast unavailable',
      };
    }

    const avgForecast = forecastPoints.reduce((sum, p) => sum + p.values.p50, 0) / forecastPoints.length;

    let recommendation: 'charge' | 'discharge' | 'hold';
    let reason: string;

    if (currentIntensity > avgForecast * 1.15) {
      recommendation = 'discharge';
      reason = 'Grid carbon intensity is high - discharge to displace dirty generation';
    } else if (currentIntensity < avgForecast * 0.85) {
      recommendation = 'charge';
      reason = 'Grid carbon intensity is low - charge with clean energy';
    } else {
      recommendation = 'hold';
      reason = 'Grid carbon intensity is normal - maintain current state';
    }

    return {
      signalAvailable: true,
      current: currentIntensity,
      emissionFactorSource: 'live',
      forecast,
      recommendation,
      reason,
    };
  }

  private mapRowToEmissionsFactor(row: any): EmissionsFactor {
    return {
      id: row.id,
      region: row.region,
      timestamp: row.timestamp,
      validUntil: row.valid_until,
      marginalEmissions: row.marginal_emissions,
      averageEmissions: row.average_emissions,
      renewablePercent: row.renewable_percent,
      coalPercent: row.coal_percent,
      gasPercent: row.gas_percent,
      nuclearPercent: row.nuclear_percent,
      dataSource: row.data_source,
      emissionFactorSource: 'live',
    };
  }

  private mapRowToCredit(row: any): CarbonCredit {
    return {
      id: row.id,
      userId: row.user_id,
      creditType: row.credit_type,
      certificateId: row.certificate_id,
      energyMwh: row.energy_mwh,
      carbonTonnes: row.carbon_tonnes,
      generationSource: row.generation_source,
      generationPeriodStart: row.generation_period_start,
      generationPeriodEnd: row.generation_period_end,
      registry: row.registry,
      registryUrl: row.registry_url,
      status: row.status,
      blockchainProof: row.blockchain_proof,
    };
  }
}

// Singleton instance
export const carbonAwareDispatch = new CarbonAwareDispatchService();
