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
  // 'live' = from recorded emissions_factors data; 'default' = hardcoded regional fallback
  emissionFactorSource: 'default' | 'live';
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
  totalEmissionsAvoided: number; // grams CO2
  totalRenewableGeneration: number; // Wh
  totalGridExport: number; // Wh
  totalGridImport: number; // Wh
  netCarbonImpact: number; // grams CO2 (negative = net reduction)
  equivalentTreesPlanted: number;
  equivalentMilesDriven: number;
  creditsEarned: number;
  breakdown: {
    byAsset: Array<{ assetId: number; assetName: string; emissionsAvoided: number }>;
    byService: Array<{ service: string; emissionsAvoided: number }>;
    byHour: Array<{ hour: number; emissionsAvoided: number; marginalRate: number }>;
  };
}

export interface CarbonOptimizedDispatch {
  assetId: number;
  intervalStart: Date;
  intervalEnd: Date;
  recommendedPowerWatts: number;
  marginalEmissions: number;
  emissionsImpact: number; // grams CO2 saved (positive) or added (negative)
  carbonValue: number; // cents (based on carbon price)
  confidence: number;
  reason: string;
}

// Default carbon price in cents per tonne CO2
const DEFAULT_CARBON_PRICE_CENTS_PER_TONNE = 5000; // $50/tonne

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

    const result = await db.execute(sql`
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
      id: (result as any).insertId,
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

    const result = await db.execute(sql`
      SELECT * FROM emissions_factors
      WHERE region = ${region}
        AND timestamp <= NOW()
        AND valid_until > NOW()
      ORDER BY timestamp DESC
      LIMIT 1
    `);

    const row = (result as any)[0]?.[0];
    if (!row) {
      // Return default emissions for region
      return this.getDefaultEmissions(region);
    }

    return this.mapRowToEmissionsFactor(row);
  }

  /**
   * Get default emissions for a region
   */
  private getDefaultEmissions(region: string): EmissionsFactor {
    // Default emissions based on region (grams CO2 per kWh)
    const defaults: Record<string, { marginal: number; average: number; renewable: number }> = {
      'NG-LAGOS': { marginal: 450, average: 420, renewable: 15 },
      'NG-ABUJA': { marginal: 480, average: 450, renewable: 12 },
      'TZ-DAR': { marginal: 380, average: 350, renewable: 35 },
      'TZ-ARUSHA': { marginal: 350, average: 320, renewable: 45 },
      'DEFAULT': { marginal: 400, average: 380, renewable: 20 },
    };

    const regionDefaults = defaults[region] || defaults['DEFAULT'];
    const now = new Date();

    return {
      id: 0,
      region,
      timestamp: now,
      validUntil: new Date(now.getTime() + 3600000),
      marginalEmissions: regionDefaults.marginal,
      averageEmissions: regionDefaults.average,
      renewablePercent: regionDefaults.renewable * 100,
      coalPercent: null,
      gasPercent: null,
      nuclearPercent: null,
      dataSource: 'default',
      emissionFactorSource: 'default',
    };
  }

  /**
   * Get carbon-optimized dispatch recommendations
   */
  async getCarbonOptimizedDispatch(
    userId: number,
    horizonHours: number = 24,
    intervalMinutes: number = 15
  ): Promise<CarbonOptimizedDispatch[]> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Get user's assets
    const assetsResult = await db.execute(sql`
      SELECT a.id, a.assetType, a.capacity, a.name,
             dc.max_power_export, dc.max_power_import
      FROM assets a
      LEFT JOIN der_capabilities dc ON dc.asset_id = a.id
      WHERE a.userId = ${userId} AND a.status = 'active'
    `);
    const assets = (assetsResult as any)[0] || [];

    // Get emissions forecast
    const region = 'NG-LAGOS'; // Should be derived from user location
    const emissionsForecast = await probabilisticForecasting.forecastEmissions(region, horizonHours, 60);

    const recommendations: CarbonOptimizedDispatch[] = [];
    const now = new Date();
    const intervalsCount = (horizonHours * 60) / intervalMinutes;

    // Average emissions for comparison
    const avgEmissions = emissionsForecast.points.reduce((sum, p) => sum + p.values.p50, 0) / emissionsForecast.points.length;

    for (let i = 0; i < intervalsCount; i++) {
      const intervalStart = new Date(now.getTime() + i * intervalMinutes * 60000);
      const intervalEnd = new Date(intervalStart.getTime() + intervalMinutes * 60000);
      
      // Get emissions for this interval (hourly forecast, so divide by 4)
      const forecastIndex = Math.floor(i / 4);
      const emissionsPoint = emissionsForecast.points[forecastIndex];
      const marginalEmissions = emissionsPoint?.values.p50 || avgEmissions;

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
          const carbonValue = Math.round((emissionsImpact / 1000000) * DEFAULT_CARBON_PRICE_CENTS_PER_TONNE);

          recommendations.push({
            assetId: asset.id,
            intervalStart,
            intervalEnd,
            recommendedPowerWatts: Math.round(recommendedPower),
            marginalEmissions,
            emissionsImpact: recommendedPower > 0 ? emissionsImpact : -emissionsImpact,
            carbonValue: recommendedPower > 0 ? carbonValue : -carbonValue,
            confidence: emissionsPoint?.values.confidence || 60,
            reason,
          });
        }
      }
    }

    console.log(`[CarbonDispatch] Generated ${recommendations.length} carbon-optimized recommendations for user ${userId}`);

    return recommendations;
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

    // Get user's energy data
    const telemetryResult = await db.execute(sql`
      SELECT 
        a.id as asset_id, a.name as asset_name, a.assetType,
        t.timestamp, t.power, t.energy
      FROM telemetry t
      JOIN assets a ON a.id = t.assetId
      WHERE a.userId = ${userId}
        AND t.timestamp >= ${periodStart}
        AND t.timestamp <= ${periodEnd}
      ORDER BY t.timestamp
    `);
    const telemetry = (telemetryResult as any)[0] || [];

    // Get settlement events for services
    const settlementResult = await db.execute(sql`
      SELECT * FROM settlement_events
      WHERE user_id = ${userId}
        AND created_at >= ${periodStart}
        AND created_at <= ${periodEnd}
    `);
    const settlements = (settlementResult as any)[0] || [];

    // Calculate totals
    let totalEmissionsAvoided = 0;
    let totalRenewableGeneration = 0;
    let totalGridExport = 0;
    let totalGridImport = 0;

    const byAsset: Map<number, { name: string; emissionsAvoided: number }> = new Map();
    const byService: Map<string, number> = new Map();
    const byHour: Map<number, { emissionsAvoided: number; marginalRate: number; count: number }> = new Map();

    // Process telemetry
    for (const t of telemetry) {
      const hour = new Date(t.timestamp).getHours();
      const power = t.power || 0;
      
      // Get emissions rate for this timestamp
      const emissionsRate = await this.getEmissionsRateAt(t.timestamp, 'NG-LAGOS');
      
      // Calculate energy for 5-minute interval (typical telemetry interval)
      const energyWh = (power * 5) / 60;

      if (power > 0) {
        // Export - avoiding grid emissions
        totalGridExport += energyWh;
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

        // Track renewable generation
        if (t.assetType === 'solar' || t.assetType === 'wind') {
          totalRenewableGeneration += energyWh;
        }
      } else {
        // Import - adding grid emissions
        totalGridImport += Math.abs(energyWh);
      }
    }

    // Process settlement events for service-based emissions
    for (const s of settlements) {
      if (s.energy_wh && s.energy_wh > 0) {
        const service = s.event_type || 'other';
        const currentService = byService.get(service) || 0;
        
        // Estimate emissions avoided based on average rate
        const avgRate = 400; // grams CO2/kWh
        const avoided = (s.energy_wh / 1000) * avgRate;
        byService.set(service, currentService + avoided);
      }
    }

    // Calculate net impact
    const avgImportEmissions = 400; // grams CO2/kWh
    const importEmissions = (totalGridImport / 1000) * avgImportEmissions;
    const netCarbonImpact = importEmissions - totalEmissionsAvoided;

    // Calculate equivalents
    const equivalentTreesPlanted = Math.round(totalEmissionsAvoided / 21000); // ~21kg CO2 per tree per year
    const equivalentMilesDriven = Math.round(totalEmissionsAvoided / 404); // ~404g CO2 per mile

    // Calculate credits earned (1 credit per MWh of renewable generation)
    const creditsEarned = Math.floor(totalRenewableGeneration / 1000000);

    // Format breakdown
    const breakdown = {
      byAsset: Array.from(byAsset.entries()).map(([assetId, data]) => ({
        assetId,
        assetName: data.name,
        emissionsAvoided: Math.round(data.emissionsAvoided),
      })),
      byService: Array.from(byService.entries()).map(([service, emissionsAvoided]) => ({
        service,
        emissionsAvoided: Math.round(emissionsAvoided),
      })),
      byHour: Array.from(byHour.entries()).map(([hour, data]) => ({
        hour,
        emissionsAvoided: Math.round(data.emissionsAvoided),
        marginalRate: Math.round(data.marginalRate / data.count),
      })).sort((a, b) => a.hour - b.hour),
    };

    return {
      userId,
      periodStart,
      periodEnd,
      totalEmissionsAvoided: Math.round(totalEmissionsAvoided),
      totalRenewableGeneration: Math.round(totalRenewableGeneration),
      totalGridExport: Math.round(totalGridExport),
      totalGridImport: Math.round(totalGridImport),
      netCarbonImpact: Math.round(netCarbonImpact),
      equivalentTreesPlanted,
      equivalentMilesDriven,
      creditsEarned,
      breakdown,
    };
  }

  /**
   * Get emissions rate at a specific timestamp
   */
  private async getEmissionsRateAt(timestamp: Date, region: string): Promise<number> {
    const db = await getDb();
    if (!db) return 400; // Default

    const result = await db.execute(sql`
      SELECT marginal_emissions FROM emissions_factors
      WHERE region = ${region}
        AND timestamp <= ${timestamp}
        AND valid_until > ${timestamp}
      ORDER BY timestamp DESC
      LIMIT 1
    `);

    const row = (result as any)[0]?.[0];
    return row?.marginal_emissions || 400;
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

    const result = await db.execute(sql`
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
    `);

    console.log(`[CarbonDispatch] Issued ${credit.creditType} credit ${certificateId} for user ${userId}`);

    return {
      id: (result as any).insertId,
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

    const result = await db.execute(sql`
      SELECT * FROM carbon_credits
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `);

    return ((result as any)[0] || []).map(this.mapRowToCredit);
  }

  /**
   * Retire a carbon credit
   */
  async retireCredit(creditId: number, reason?: string): Promise<CarbonCredit> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    await db.execute(sql`
      UPDATE carbon_credits SET
        status = 'retired',
        metadata = JSON_SET(COALESCE(metadata, '{}'), '$.retiredAt', ${new Date().toISOString()}, '$.retireReason', ${reason || null}),
        updated_at = NOW()
      WHERE id = ${creditId}
    `);

    const result = await db.execute(sql`SELECT * FROM carbon_credits WHERE id = ${creditId}`);
    return this.mapRowToCredit((result as any)[0]?.[0]);
  }

  /**
   * Get real-time carbon intensity signal
   */
  async getCarbonIntensitySignal(region: string): Promise<{
    current: number;
    forecast: Array<{ timestamp: Date; intensity: number; confidence: number }>;
    recommendation: 'charge' | 'discharge' | 'hold';
    reason: string;
  }> {
    const current = await this.getCurrentEmissions(region);
    const forecast = await probabilisticForecasting.forecastEmissions(region, 24, 60);

    const currentIntensity = current?.marginalEmissions || 400;
    const avgForecast = forecast.points.reduce((sum, p) => sum + p.values.p50, 0) / forecast.points.length;

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
      current: currentIntensity,
      forecast: forecast.points.slice(0, 24).map(p => ({
        timestamp: p.timestamp,
        intensity: p.values.p50,
        confidence: p.values.confidence,
      })),
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
