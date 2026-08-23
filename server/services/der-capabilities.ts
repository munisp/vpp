/**
 * DER Capabilities and Constraints Service
 * 
 * Manages distributed energy resource capabilities, constraints, and dispatch eligibility.
 * Provides the foundation for multi-service optimization.
 */

import { getDb } from '../db';
import { sql } from 'drizzle-orm';
import { kafkaPublisher } from '../integration/kafka-publisher';
import type { SqlRow } from '../sql-row';

// Types for DER management
export interface DerCapability {
  id: number;
  assetId: number;
  maxPowerExport: number | null;
  maxPowerImport: number | null;
  minPowerExport: number | null;
  minPowerImport: number | null;
  rampRateUp: number | null;
  rampRateDown: number | null;
  maxStateOfCharge: number | null;
  minStateOfCharge: number | null;
  roundTripEfficiency: number | null;
  responseTimeMs: number | null;
  minimumRunTime: number | null;
  minimumOffTime: number | null;
  canProvideFrequencyResponse: boolean;
  canProvideVoltageSupport: boolean;
  canProvideReserves: boolean;
  canProvidePeakShaving: boolean;
  protocols: string[];
  certifications: string[];
}

export interface DerConstraint {
  id: number;
  assetId: number;
  validFrom: Date;
  validUntil: Date;
  constraintType: string;
  constraintValue: number | null;
  priority: number;
  source: string;
  reason: string | null;
}

export interface DispatchEligibility {
  assetId: number;
  eligible: boolean;
  availablePowerExport: number;
  availablePowerImport: number;
  currentSoc: number | null;
  activeConstraints: DerConstraint[];
  eligibleServices: string[];
  ineligibilityReasons: string[];
}

export interface AssetWithCapabilities {
  id: number;
  userId: number;
  assetType: string;
  name: string;
  capacity: number;
  status: string;
  capabilities: DerCapability | null;
  currentTelemetry: {
    power: number | null;
    stateOfCharge: number | null;
    voltage: number | null;
    frequency: number | null;
  } | null;
}

export class DerCapabilitiesService {
  
  /**
   * Register or update DER capabilities for an asset
   */
  async registerCapabilities(
    assetId: number,
    capabilities: Partial<Omit<DerCapability, 'id' | 'assetId'>>
  ): Promise<DerCapability> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Check if capabilities already exist
    const existing = await db.execute<SqlRow>(sql`
      SELECT id FROM der_capabilities WHERE asset_id = ${assetId}
    `);

    const protocols = JSON.stringify(capabilities.protocols || []);
    const certifications = JSON.stringify(capabilities.certifications || []);

    if (existing.rows?.length > 0) {
      // Update existing
      await db.execute<SqlRow>(sql`
        UPDATE der_capabilities SET
          max_power_export = ${capabilities.maxPowerExport || null},
          max_power_import = ${capabilities.maxPowerImport || null},
          min_power_export = ${capabilities.minPowerExport || null},
          min_power_import = ${capabilities.minPowerImport || null},
          ramp_rate_up = ${capabilities.rampRateUp || null},
          ramp_rate_down = ${capabilities.rampRateDown || null},
          max_soc = ${capabilities.maxStateOfCharge || null},
          min_soc = ${capabilities.minStateOfCharge || null},
          round_trip_efficiency = ${capabilities.roundTripEfficiency || null},
          response_time_ms = ${capabilities.responseTimeMs || null},
          minimum_run_time = ${capabilities.minimumRunTime || null},
          minimum_off_time = ${capabilities.minimumOffTime || null},
          can_provide_frequency_response = ${capabilities.canProvideFrequencyResponse || false},
          can_provide_voltage_support = ${capabilities.canProvideVoltageSupport || false},
          can_provide_reserves = ${capabilities.canProvideReserves || false},
          can_provide_peak_shaving = ${capabilities.canProvidePeakShaving ?? true},
          protocols = ${protocols},
          certifications = ${certifications},
          updated_at = NOW()
        WHERE asset_id = ${assetId}
      `);
    } else {
      // Insert new
      await db.execute<SqlRow>(sql`
        INSERT INTO der_capabilities (
          asset_id, max_power_export, max_power_import, min_power_export, min_power_import,
          ramp_rate_up, ramp_rate_down, max_soc, min_soc, round_trip_efficiency,
          response_time_ms, minimum_run_time, minimum_off_time,
          can_provide_frequency_response, can_provide_voltage_support,
          can_provide_reserves, can_provide_peak_shaving,
          protocols, certifications, created_at, updated_at
        ) VALUES (
          ${assetId}, ${capabilities.maxPowerExport || null}, ${capabilities.maxPowerImport || null},
          ${capabilities.minPowerExport || null}, ${capabilities.minPowerImport || null},
          ${capabilities.rampRateUp || null}, ${capabilities.rampRateDown || null},
          ${capabilities.maxStateOfCharge || null}, ${capabilities.minStateOfCharge || null},
          ${capabilities.roundTripEfficiency || null}, ${capabilities.responseTimeMs || null},
          ${capabilities.minimumRunTime || null}, ${capabilities.minimumOffTime || null},
          ${capabilities.canProvideFrequencyResponse || false}, ${capabilities.canProvideVoltageSupport || false},
          ${capabilities.canProvideReserves || false}, ${capabilities.canProvidePeakShaving ?? true},
          ${protocols}, ${certifications}, NOW(), NOW()
        )
      `);
    }

    console.log(`[DerCapabilities] Registered capabilities for asset ${assetId}`);

    // Publish to Kafka for lakehouse analytics
    try {
      await kafkaPublisher.publishDERCapabilitiesUpdated({
        assetId: assetId.toString(),
        capabilityType: 'full_update',
        powerMinKw: capabilities.minPowerExport ? capabilities.minPowerExport / 1000 : undefined,
        powerMaxKw: capabilities.maxPowerExport ? capabilities.maxPowerExport / 1000 : undefined,
        rampRateKwMin: capabilities.rampRateUp ? capabilities.rampRateUp / 1000 : undefined,
        responseTimeSec: capabilities.responseTimeMs ? capabilities.responseTimeMs / 1000 : undefined,
        timestamp: new Date(),
      });
    } catch (error) {
      console.error('[DerCapabilities] Error publishing to Kafka:', error);
    }

    return this.getCapabilities(assetId) as Promise<DerCapability>;
  }

  /**
   * Get capabilities for an asset
   */
  async getCapabilities(assetId: number): Promise<DerCapability | null> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const result = await db.execute<SqlRow>(sql`
      SELECT * FROM der_capabilities WHERE asset_id = ${assetId}
    `);

    const row = result.rows[0];
    if (!row) return null;

    return this.mapRowToCapability(row);
  }

  /**
   * Add a constraint for an asset
   */
  async addConstraint(
    assetId: number,
    constraint: {
      validFrom: Date;
      validUntil: Date;
      constraintType: 'max_power' | 'min_power' | 'max_energy' | 'min_soc' | 'max_soc' | 'unavailable' | 'must_run' | 'user_preference';
      constraintValue?: number;
      priority?: number;
      source: 'user' | 'operator' | 'system' | 'safety' | 'grid_code';
      reason?: string;
    }
  ): Promise<DerConstraint> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const result = await db.execute<SqlRow>(sql`
      INSERT INTO der_constraints (
        asset_id, valid_from, valid_until, constraint_type,
        constraint_value, priority, source, reason, created_at
      ) VALUES (
        ${assetId}, ${constraint.validFrom}, ${constraint.validUntil},
        ${constraint.constraintType}, ${constraint.constraintValue || null},
        ${constraint.priority || 5}, ${constraint.source}, ${constraint.reason || null}, NOW()
      )
      RETURNING id
    `);

    console.log(`[DerCapabilities] Added ${constraint.constraintType} constraint for asset ${assetId}`);

    return {
      id: Number(result.rows[0].id),
      assetId,
      validFrom: constraint.validFrom,
      validUntil: constraint.validUntil,
      constraintType: constraint.constraintType,
      constraintValue: constraint.constraintValue || null,
      priority: constraint.priority || 5,
      source: constraint.source,
      reason: constraint.reason || null,
    };
  }

  /**
   * Get active constraints for an asset at a specific time
   */
  async getActiveConstraints(assetId: number, atTime?: Date): Promise<DerConstraint[]> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const checkTime = atTime || new Date();

    const result = await db.execute<SqlRow>(sql`
      SELECT * FROM der_constraints
      WHERE asset_id = ${assetId}
        AND valid_from <= ${checkTime}
        AND valid_until >= ${checkTime}
      ORDER BY priority DESC
    `);

    return (result.rows || []).map(this.mapRowToConstraint);
  }

  /**
   * Calculate dispatch eligibility for an asset
   */
  async calculateEligibility(assetId: number, atTime?: Date): Promise<DispatchEligibility> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const checkTime = atTime || new Date();
    const ineligibilityReasons: string[] = [];
    const eligibleServices: string[] = [];

    // Get asset info
    const assetResult = await db.execute<SqlRow>(sql`
      SELECT a.*, dc.* FROM assets a
      LEFT JOIN der_capabilities dc ON dc.asset_id = a.id
      WHERE a.id = ${assetId}
    `);
    const asset = assetResult.rows[0];

    if (!asset) {
      return {
        assetId,
        eligible: false,
        availablePowerExport: 0,
        availablePowerImport: 0,
        currentSoc: null,
        activeConstraints: [],
        eligibleServices: [],
        ineligibilityReasons: ['Asset not found'],
      };
    }

    // Check asset status
    if (asset.status !== 'active') {
      ineligibilityReasons.push(`Asset status is ${asset.status}`);
    }

    // Get latest telemetry
    const telemetryResult = await db.execute<SqlRow>(sql`
      SELECT * FROM telemetry
      WHERE "assetId" = ${assetId}
      ORDER BY timestamp DESC
      LIMIT 1
    `);
    const telemetry = telemetryResult.rows[0];

    // Get active constraints
    const activeConstraints = await this.getActiveConstraints(assetId, checkTime);

    // Calculate available power based on capabilities and constraints
    let availablePowerExport = asset.max_power_export || asset.capacity || 0;
    let availablePowerImport = asset.max_power_import || asset.capacity || 0;
    let currentSoc: number | null = null;

    if (telemetry) {
      currentSoc = telemetry.stateOfCharge ? telemetry.stateOfCharge / 100 : null;

      // For batteries, adjust available power based on SoC
      if (asset.assetType === 'battery' && currentSoc !== null) {
        const minSoc = (asset.min_soc || 1000) / 100; // Default 10%
        const maxSoc = (asset.max_soc || 9000) / 100; // Default 90%

        if (currentSoc <= minSoc) {
          availablePowerExport = 0;
          ineligibilityReasons.push(`Battery SoC (${currentSoc}%) at or below minimum (${minSoc}%)`);
        }
        if (currentSoc >= maxSoc) {
          availablePowerImport = 0;
          ineligibilityReasons.push(`Battery SoC (${currentSoc}%) at or above maximum (${maxSoc}%)`);
        }
      }
    } else {
      ineligibilityReasons.push('No recent telemetry data');
    }

    // Apply constraints
    for (const constraint of activeConstraints) {
      switch (constraint.constraintType) {
        case 'unavailable':
          availablePowerExport = 0;
          availablePowerImport = 0;
          ineligibilityReasons.push(`Asset unavailable: ${constraint.reason || 'No reason given'}`);
          break;
        case 'max_power':
          if (constraint.constraintValue !== null) {
            availablePowerExport = Math.min(availablePowerExport, constraint.constraintValue);
            availablePowerImport = Math.min(availablePowerImport, constraint.constraintValue);
          }
          break;
        case 'min_soc':
          if (constraint.constraintValue !== null && currentSoc !== null) {
            const minSocConstraint = constraint.constraintValue / 100;
            if (currentSoc <= minSocConstraint) {
              availablePowerExport = 0;
              ineligibilityReasons.push(`SoC constraint: must maintain ${minSocConstraint}%`);
            }
          }
          break;
        case 'max_soc':
          if (constraint.constraintValue !== null && currentSoc !== null) {
            const maxSocConstraint = constraint.constraintValue / 100;
            if (currentSoc >= maxSocConstraint) {
              availablePowerImport = 0;
            }
          }
          break;
      }
    }

    // Determine eligible services based on capabilities
    if (asset.can_provide_peak_shaving !== false && availablePowerExport > 0) {
      eligibleServices.push('peak_shaving');
      eligibleServices.push('demand_response');
    }
    if (asset.can_provide_frequency_response && availablePowerExport > 0) {
      eligibleServices.push('frequency_regulation');
    }
    if (asset.can_provide_voltage_support) {
      eligibleServices.push('voltage_support');
    }
    if (asset.can_provide_reserves && availablePowerExport > 0) {
      eligibleServices.push('spinning_reserve');
      eligibleServices.push('non_spinning_reserve');
    }
    if (availablePowerExport > 0 || availablePowerImport > 0) {
      eligibleServices.push('energy_arbitrage');
    }

    const eligible = ineligibilityReasons.length === 0 && (availablePowerExport > 0 || availablePowerImport > 0);

    return {
      assetId,
      eligible,
      availablePowerExport,
      availablePowerImport,
      currentSoc,
      activeConstraints,
      eligibleServices,
      ineligibilityReasons,
    };
  }

  /**
   * Get all assets with capabilities for a user
   */
  async getUserAssetsWithCapabilities(userId: number): Promise<AssetWithCapabilities[]> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const result = await db.execute<SqlRow>(sql`
      SELECT 
        a.id, a."userId", a."assetType", a.name, a.capacity, a.status,
        dc.id as cap_id, dc.max_power_export, dc.max_power_import,
        dc.min_power_export, dc.min_power_import, dc.ramp_rate_up, dc.ramp_rate_down,
        dc.max_soc, dc.min_soc, dc.round_trip_efficiency, dc.response_time_ms,
        dc.minimum_run_time, dc.minimum_off_time,
        dc.can_provide_frequency_response, dc.can_provide_voltage_support,
        dc.can_provide_reserves, dc.can_provide_peak_shaving,
        dc.protocols, dc.certifications,
        t.power as current_power, t."stateOfCharge" as current_soc,
        t.voltage as current_voltage, t.frequency as current_frequency
      FROM assets a
      LEFT JOIN der_capabilities dc ON dc.asset_id = a.id
      LEFT JOIN (
        SELECT "assetId", power, "stateOfCharge", voltage, frequency
        FROM telemetry t1
        WHERE timestamp = (
          SELECT MAX(timestamp) FROM telemetry t2 WHERE t2."assetId" = t1."assetId"
        )
      ) t ON t."assetId" = a.id
      WHERE a."userId" = ${userId}
      ORDER BY a.id
    `);

    return (result.rows || []).map((row: any) => ({
      id: row.id,
      userId: row.userId,
      assetType: row.assetType,
      name: row.name,
      capacity: row.capacity,
      status: row.status,
      capabilities: row.cap_id ? this.mapRowToCapability(row) : null,
      currentTelemetry: row.current_power !== null ? {
        power: row.current_power,
        stateOfCharge: row.current_soc,
        voltage: row.current_voltage,
        frequency: row.current_frequency,
      } : null,
    }));
  }

  /**
   * Get aggregated fleet capabilities for a user or community
   */
  async getFleetCapabilities(
    scope: { userId?: number; communityId?: number }
  ): Promise<{
    totalExportCapacity: number;
    totalImportCapacity: number;
    totalStorageCapacity: number;
    assetCount: number;
    eligibleAssetCount: number;
    serviceCapabilities: Record<string, number>;
  }> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    let assetQuery;
    if (scope.userId) {
      assetQuery = sql`SELECT id FROM assets WHERE "userId" = ${scope.userId} AND status = 'active'`;
    } else if (scope.communityId) {
      assetQuery = sql`
        SELECT a.id FROM assets a
        JOIN community_members cm ON cm.user_id = a."userId"
        WHERE cm.community_id = ${scope.communityId} AND cm.status = 'active' AND a.status = 'active'
      `;
    } else {
      throw new Error('Must specify userId or communityId');
    }

    const assetsResult = await db.execute<SqlRow>(assetQuery);
    const assetIds = (assetsResult.rows || []).map((r: any) => r.id);

    let totalExportCapacity = 0;
    let totalImportCapacity = 0;
    let totalStorageCapacity = 0;
    let eligibleAssetCount = 0;
    const serviceCapabilities: Record<string, number> = {};

    for (const assetId of assetIds) {
      const eligibility = await this.calculateEligibility(assetId);
      
      totalExportCapacity += eligibility.availablePowerExport;
      totalImportCapacity += eligibility.availablePowerImport;
      
      if (eligibility.eligible) {
        eligibleAssetCount++;
      }

      for (const service of eligibility.eligibleServices) {
        serviceCapabilities[service] = (serviceCapabilities[service] || 0) + eligibility.availablePowerExport;
      }

      // Get storage capacity for batteries
      const caps = await this.getCapabilities(assetId);
      if (caps && caps.maxStateOfCharge) {
        // Estimate storage from max SoC and typical battery sizing
        totalStorageCapacity += eligibility.availablePowerExport * 2; // Rough estimate: 2 hour storage
      }
    }

    return {
      totalExportCapacity,
      totalImportCapacity,
      totalStorageCapacity,
      assetCount: assetIds.length,
      eligibleAssetCount,
      serviceCapabilities,
    };
  }

  /**
   * Auto-detect capabilities from asset type and telemetry
   */
  async autoDetectCapabilities(assetId: number): Promise<Partial<DerCapability>> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Get asset info
    const assetResult = await db.execute<SqlRow>(sql`
      SELECT * FROM assets WHERE id = ${assetId}
    `);
    const asset = assetResult.rows[0];
    if (!asset) throw new Error('Asset not found');

    // Get recent telemetry to estimate capabilities
    const telemetryResult = await db.execute<SqlRow>(sql`
      SELECT 
        MAX(power) as max_power,
        MIN(power) as min_power,
        AVG(power) as avg_power,
        MAX("stateOfCharge") as max_soc,
        MIN("stateOfCharge") as min_soc
      FROM telemetry
      WHERE "assetId" = ${assetId}
        AND timestamp > (NOW() - INTERVAL '30 day')
    `);
    const telemetryStats = telemetryResult.rows[0];

    const capabilities: Partial<DerCapability> = {
      protocols: ['mqtt'],
    };

    switch (asset.assetType) {
      case 'solar':
        capabilities.maxPowerExport = asset.capacity;
        capabilities.minPowerExport = 0;
        capabilities.maxPowerImport = 0;
        capabilities.minPowerImport = 0;
        capabilities.canProvidePeakShaving = true;
        capabilities.canProvideFrequencyResponse = false;
        capabilities.canProvideVoltageSupport = false;
        capabilities.canProvideReserves = false;
        capabilities.responseTimeMs = 1000;
        break;

      case 'battery':
        capabilities.maxPowerExport = asset.capacity;
        capabilities.maxPowerImport = asset.capacity;
        capabilities.minPowerExport = 0;
        capabilities.minPowerImport = 0;
        capabilities.maxStateOfCharge = 9000; // 90%
        capabilities.minStateOfCharge = 1000; // 10%
        capabilities.roundTripEfficiency = 9000; // 90%
        capabilities.canProvidePeakShaving = true;
        capabilities.canProvideFrequencyResponse = true;
        capabilities.canProvideVoltageSupport = true;
        capabilities.canProvideReserves = true;
        capabilities.responseTimeMs = 100;
        capabilities.rampRateUp = Math.round(asset.capacity / 10); // 10% per second
        capabilities.rampRateDown = Math.round(asset.capacity / 10);
        break;

      case 'generator':
        capabilities.maxPowerExport = asset.capacity;
        capabilities.minPowerExport = Math.round(asset.capacity * 0.3); // 30% minimum load
        capabilities.maxPowerImport = 0;
        capabilities.minPowerImport = 0;
        capabilities.canProvidePeakShaving = true;
        capabilities.canProvideFrequencyResponse = false;
        capabilities.canProvideVoltageSupport = false;
        capabilities.canProvideReserves = true;
        capabilities.responseTimeMs = 30000; // 30 seconds startup
        capabilities.minimumRunTime = 1800; // 30 minutes
        capabilities.minimumOffTime = 600; // 10 minutes
        break;

      case 'wind':
        capabilities.maxPowerExport = asset.capacity;
        capabilities.minPowerExport = 0;
        capabilities.maxPowerImport = 0;
        capabilities.minPowerImport = 0;
        capabilities.canProvidePeakShaving = false; // Not dispatchable
        capabilities.canProvideFrequencyResponse = false;
        capabilities.canProvideVoltageSupport = false;
        capabilities.canProvideReserves = false;
        capabilities.responseTimeMs = 5000;
        break;

      default:
        capabilities.maxPowerExport = asset.capacity;
        capabilities.canProvidePeakShaving = true;
    }

    // Adjust based on observed telemetry
    if (telemetryStats?.max_power) {
      capabilities.maxPowerExport = Math.max(capabilities.maxPowerExport || 0, telemetryStats.max_power);
    }

    return capabilities;
  }

  private mapRowToCapability(row: any): DerCapability {
    let protocols: string[] = [];
    let certifications: string[] = [];
    
    try {
      protocols = row.protocols ? JSON.parse(row.protocols) : [];
    } catch (e) {
      protocols = [];
    }
    
    try {
      certifications = row.certifications ? JSON.parse(row.certifications) : [];
    } catch (e) {
      certifications = [];
    }

    return {
      id: row.id || row.cap_id,
      assetId: row.asset_id || row.assetId,
      maxPowerExport: row.max_power_export,
      maxPowerImport: row.max_power_import,
      minPowerExport: row.min_power_export,
      minPowerImport: row.min_power_import,
      rampRateUp: row.ramp_rate_up,
      rampRateDown: row.ramp_rate_down,
      maxStateOfCharge: row.max_soc,
      minStateOfCharge: row.min_soc,
      roundTripEfficiency: row.round_trip_efficiency,
      responseTimeMs: row.response_time_ms,
      minimumRunTime: row.minimum_run_time,
      minimumOffTime: row.minimum_off_time,
      canProvideFrequencyResponse: row.can_provide_frequency_response || false,
      canProvideVoltageSupport: row.can_provide_voltage_support || false,
      canProvideReserves: row.can_provide_reserves || false,
      canProvidePeakShaving: row.can_provide_peak_shaving !== false,
      protocols,
      certifications,
    };
  }

  private mapRowToConstraint(row: any): DerConstraint {
    return {
      id: row.id,
      assetId: row.asset_id,
      validFrom: row.valid_from,
      validUntil: row.valid_until,
      constraintType: row.constraint_type,
      constraintValue: row.constraint_value,
      priority: row.priority,
      source: row.source,
      reason: row.reason,
    };
  }
}

// Singleton instance
export const derCapabilities = new DerCapabilitiesService();
