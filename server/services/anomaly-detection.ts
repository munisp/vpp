/**
 * Anomaly Detection and Predictive Maintenance Service
 * 
 * Detects asset behavior anomalies using statistical methods and
 * provides predictive maintenance recommendations.
 */

import { getDb } from '../db';
import { sql } from 'drizzle-orm';
import { kafkaPublisher } from '../integration/kafka-publisher';
import type { SqlRow } from '../sql-row';

// Types for anomaly detection
export interface AnomalyEvent {
  id: number;
  assetId: number;
  anomalyType: 'performance_degradation' | 'unusual_pattern' | 'sensor_fault' | 
               'efficiency_drop' | 'overheating' | 'communication_loss' | 
               'power_quality' | 'battery_health' | 'inverter_fault';
  severity: 'low' | 'medium' | 'high' | 'critical';
  detectedAt: Date;
  metricName: string;
  expectedValue: number | null;
  actualValue: number;
  deviationPercent: number | null;
  confidenceScore: number;
  description: string;
  recommendedAction: 'monitor' | 'schedule_inspection' | 'immediate_inspection' | 'reduce_load' | 'shutdown';
  maintenanceRequired: boolean;
  estimatedImpact: string | null;
  acknowledgedAt: Date | null;
  acknowledgedBy: number | null;
  resolvedAt: Date | null;
  resolutionNotes: string | null;
}

export interface AssetHealthScore {
  assetId: number;
  assetName: string;
  assetType: string;
  overallScore: number; // 0-100
  performanceScore: number;
  reliabilityScore: number;
  efficiencyScore: number;
  communicationScore: number;
  trend: 'improving' | 'stable' | 'degrading';
  lastUpdated: Date;
  activeAnomalies: number;
  maintenanceRecommendations: string[];
  estimatedRemainingLife: string | null;
}

export interface MaintenanceRecommendation {
  assetId: number;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  recommendationType: 'preventive' | 'corrective' | 'predictive';
  description: string;
  estimatedCost: number | null;
  estimatedDowntime: string | null;
  dueDate: Date | null;
  basedOnAnomalies: number[];
}

// Statistical thresholds for anomaly detection
const ANOMALY_THRESHOLDS = {
  power_deviation: 0.3, // 30% deviation from expected
  efficiency_drop: 0.15, // 15% efficiency drop
  temperature_high: 60, // Celsius
  temperature_deviation: 0.2,
  voltage_deviation: 0.1,
  frequency_deviation: 0.02,
  communication_timeout_minutes: 15,
  battery_soc_anomaly: 0.1, // 10% unexpected SoC change
};

export class AnomalyDetectionService {
  
  /**
   * Run anomaly detection for an asset
   */
  async detectAnomalies(assetId: number): Promise<AnomalyEvent[]> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const anomalies: AnomalyEvent[] = [];

    // Get asset info
    const assetResult = await db.execute<SqlRow>(sql`
      SELECT a.*, dc.* FROM assets a
      LEFT JOIN der_capabilities dc ON dc.asset_id = a.id
      WHERE a.id = ${assetId}
    `);
    const asset = assetResult.rows[0];
    if (!asset) return anomalies;

    // Get recent telemetry
    const telemetryResult = await db.execute<SqlRow>(sql`
      SELECT * FROM telemetry
      WHERE "assetId" = ${assetId}
      ORDER BY timestamp DESC
      LIMIT 100
    `);
    const telemetry = telemetryResult.rows || [];

    if (telemetry.length === 0) {
      // Communication loss detection
      const lastTelemetryResult = await db.execute<SqlRow>(sql`
        SELECT MAX(timestamp) as last_ts FROM telemetry WHERE "assetId" = ${assetId}
      `);
      const lastTs = lastTelemetryResult.rows[0]?.last_ts;
      
      if (lastTs) {
        const minutesSinceLastTelemetry = (Date.now() - new Date(lastTs).getTime()) / 60000;
        if (minutesSinceLastTelemetry > ANOMALY_THRESHOLDS.communication_timeout_minutes) {
          const anomaly = await this.recordAnomaly(assetId, {
            anomalyType: 'communication_loss',
            severity: minutesSinceLastTelemetry > 60 ? 'high' : 'medium',
            metricName: 'last_communication',
            expectedValue: null,
            actualValue: minutesSinceLastTelemetry,
            deviationPercent: null,
            confidenceScore: 95,
            description: `No telemetry received for ${Math.round(minutesSinceLastTelemetry)} minutes. Check device connectivity and power supply.`,
            recommendedAction: minutesSinceLastTelemetry > 60 ? 'immediate_inspection' : 'schedule_inspection',
            maintenanceRequired: minutesSinceLastTelemetry > 120,
            estimatedImpact: minutesSinceLastTelemetry > 60 ? 'Loss of monitoring and control capability' : null,
          });
          anomalies.push(anomaly);
        }
      }
      return anomalies;
    }

    // Calculate statistics from recent telemetry
    const stats = this.calculateTelemetryStats(telemetry);
    const latest = telemetry[0];

    // Power anomaly detection
    if (asset.assetType === 'solar') {
      const solarAnomalies = await this.detectSolarAnomalies(assetId, asset, latest, stats);
      anomalies.push(...solarAnomalies);
    } else if (asset.assetType === 'battery') {
      const batteryAnomalies = await this.detectBatteryAnomalies(assetId, asset, latest, stats);
      anomalies.push(...batteryAnomalies);
    } else if (asset.assetType === 'generator') {
      const generatorAnomalies = await this.detectGeneratorAnomalies(assetId, asset, latest, stats);
      anomalies.push(...generatorAnomalies);
    }

    // Generic anomaly detection
    const genericAnomalies = await this.detectGenericAnomalies(assetId, asset, latest, stats);
    anomalies.push(...genericAnomalies);

    if (anomalies.length > 0) {
      console.log(`[AnomalyDetection] Detected ${anomalies.length} anomalies for asset ${assetId}`);
    }

    return anomalies;
  }

  /**
   * Detect solar-specific anomalies
   */
  private async detectSolarAnomalies(
    assetId: number,
    asset: any,
    latest: any,
    stats: TelemetryStats
  ): Promise<AnomalyEvent[]> {
    const anomalies: AnomalyEvent[] = [];
    const hour = new Date().getHours();

    // Check for underperformance during daylight hours
    if (hour >= 8 && hour <= 17) {
      const expectedPower = asset.capacity * this.getSolarIrradianceFactor(hour);
      const actualPower = latest.power || 0;

      if (expectedPower > 0 && actualPower < expectedPower * (1 - ANOMALY_THRESHOLDS.power_deviation)) {
        const deviationPercent = ((expectedPower - actualPower) / expectedPower) * 100;
        
        const anomaly = await this.recordAnomaly(assetId, {
          anomalyType: 'performance_degradation',
          severity: deviationPercent > 50 ? 'high' : deviationPercent > 30 ? 'medium' : 'low',
          metricName: 'solar_power_output',
          expectedValue: expectedPower,
          actualValue: actualPower,
          deviationPercent,
          confidenceScore: 75,
          description: `Solar output ${Math.round(deviationPercent)}% below expected for current conditions. Check for shading, soiling, or inverter issues.`,
          recommendedAction: deviationPercent > 50 ? 'immediate_inspection' : 'schedule_inspection',
          maintenanceRequired: deviationPercent > 40,
          estimatedImpact: `Potential daily loss: ${Math.round((expectedPower - actualPower) * 8 / 1000)} kWh`,
        });
        anomalies.push(anomaly);
      }
    }

    // Check for power at night (inverter fault)
    if ((hour < 6 || hour > 20) && (latest.power || 0) > asset.capacity * 0.05) {
      const anomaly = await this.recordAnomaly(assetId, {
        anomalyType: 'inverter_fault',
        severity: 'medium',
        metricName: 'night_power_output',
        expectedValue: 0,
        actualValue: latest.power,
        deviationPercent: null,
        confidenceScore: 85,
        description: 'Unexpected power output during nighttime hours. Inspect inverter for faults or measurement errors.',
        recommendedAction: 'schedule_inspection',
        maintenanceRequired: true,
        estimatedImpact: 'Potential inverter malfunction or measurement error',
      });
      anomalies.push(anomaly);
    }

    return anomalies;
  }

  /**
   * Detect battery-specific anomalies
   */
  private async detectBatteryAnomalies(
    assetId: number,
    asset: any,
    latest: any,
    stats: TelemetryStats
  ): Promise<AnomalyEvent[]> {
    const anomalies: AnomalyEvent[] = [];

    // Check for rapid SoC changes (potential cell degradation)
    if (stats.socChangeRate !== null && Math.abs(stats.socChangeRate) > 5) {
      const anomaly = await this.recordAnomaly(assetId, {
        anomalyType: 'battery_health',
        severity: Math.abs(stats.socChangeRate) > 10 ? 'high' : 'medium',
        metricName: 'soc_change_rate',
        expectedValue: null,
        actualValue: stats.socChangeRate,
        deviationPercent: null,
        confidenceScore: 80,
        description: `Abnormal SoC change rate: ${stats.socChangeRate.toFixed(1)}%/hour`,
        recommendedAction: 'schedule_inspection',
        maintenanceRequired: Math.abs(stats.socChangeRate) > 10,
        estimatedImpact: 'Potential battery capacity degradation',
      });
      anomalies.push(anomaly);
    }

    // Check for temperature anomalies
    if (latest.temperature && latest.temperature > ANOMALY_THRESHOLDS.temperature_high) {
      const anomaly = await this.recordAnomaly(assetId, {
        anomalyType: 'overheating',
        severity: latest.temperature > 70 ? 'critical' : 'high',
        metricName: 'battery_temperature',
        expectedValue: 35,
        actualValue: latest.temperature,
        deviationPercent: ((latest.temperature - 35) / 35) * 100,
        confidenceScore: 95,
        description: `Battery temperature ${latest.temperature}°C exceeds safe threshold`,
        recommendedAction: latest.temperature > 70 ? 'shutdown' : 'reduce_load',
        maintenanceRequired: true,
        estimatedImpact: 'Risk of thermal runaway if not addressed',
      });
      anomalies.push(anomaly);
    }

    // Check for efficiency degradation
    if (stats.roundTripEfficiency !== null && stats.roundTripEfficiency < 0.8) {
      const anomaly = await this.recordAnomaly(assetId, {
        anomalyType: 'efficiency_drop',
        severity: stats.roundTripEfficiency < 0.7 ? 'high' : 'medium',
        metricName: 'round_trip_efficiency',
        expectedValue: 0.9,
        actualValue: stats.roundTripEfficiency,
        deviationPercent: ((0.9 - stats.roundTripEfficiency) / 0.9) * 100,
        confidenceScore: 70,
        description: `Battery efficiency ${(stats.roundTripEfficiency * 100).toFixed(1)}% below expected 90%`,
        recommendedAction: 'schedule_inspection',
        maintenanceRequired: stats.roundTripEfficiency < 0.75,
        estimatedImpact: 'Reduced energy storage capacity and increased operating costs',
      });
      anomalies.push(anomaly);
    }

    return anomalies;
  }

  /**
   * Detect generator-specific anomalies
   */
  private async detectGeneratorAnomalies(
    assetId: number,
    asset: any,
    latest: any,
    stats: TelemetryStats
  ): Promise<AnomalyEvent[]> {
    const anomalies: AnomalyEvent[] = [];

    // Check for frequency deviation
    if (latest.frequency && Math.abs(latest.frequency - 50) > 50 * ANOMALY_THRESHOLDS.frequency_deviation) {
      const anomaly = await this.recordAnomaly(assetId, {
        anomalyType: 'power_quality',
        severity: Math.abs(latest.frequency - 50) > 2 ? 'high' : 'medium',
        metricName: 'output_frequency',
        expectedValue: 50,
        actualValue: latest.frequency,
        deviationPercent: ((latest.frequency - 50) / 50) * 100,
        confidenceScore: 90,
        description: `Generator frequency ${latest.frequency.toFixed(2)} Hz deviates from 50 Hz`,
        recommendedAction: 'schedule_inspection',
        maintenanceRequired: true,
        estimatedImpact: 'Risk of equipment damage and grid instability',
      });
      anomalies.push(anomaly);
    }

    // Check for voltage deviation
    if (latest.voltage && Math.abs(latest.voltage - 230) > 230 * ANOMALY_THRESHOLDS.voltage_deviation) {
      const anomaly = await this.recordAnomaly(assetId, {
        anomalyType: 'power_quality',
        severity: Math.abs(latest.voltage - 230) > 30 ? 'high' : 'medium',
        metricName: 'output_voltage',
        expectedValue: 230,
        actualValue: latest.voltage,
        deviationPercent: ((latest.voltage - 230) / 230) * 100,
        confidenceScore: 90,
        description: `Generator voltage ${latest.voltage.toFixed(1)} V deviates from 230 V`,
        recommendedAction: 'schedule_inspection',
        maintenanceRequired: true,
        estimatedImpact: 'Risk of equipment damage from voltage fluctuations',
      });
      anomalies.push(anomaly);
    }

    return anomalies;
  }

  /**
   * Detect generic anomalies applicable to all asset types
   */
  private async detectGenericAnomalies(
    assetId: number,
    asset: any,
    latest: any,
    stats: TelemetryStats
  ): Promise<AnomalyEvent[]> {
    const anomalies: AnomalyEvent[] = [];

    // Check for unusual patterns using z-score
    if (stats.powerMean !== null && stats.powerStd !== null && stats.powerStd > 0) {
      const zScore = Math.abs((latest.power - stats.powerMean) / stats.powerStd);
      if (zScore > 3) {
        const anomaly = await this.recordAnomaly(assetId, {
          anomalyType: 'unusual_pattern',
          severity: zScore > 4 ? 'medium' : 'low',
          metricName: 'power_z_score',
          expectedValue: stats.powerMean,
          actualValue: latest.power,
          deviationPercent: ((latest.power - stats.powerMean) / stats.powerMean) * 100,
          confidenceScore: Math.min(95, 60 + zScore * 5),
          description: `Power reading ${latest.power}W is ${zScore.toFixed(1)} standard deviations from mean`,
          recommendedAction: 'monitor',
          maintenanceRequired: false,
          estimatedImpact: null,
        });
        anomalies.push(anomaly);
      }
    }

    return anomalies;
  }

  /**
   * Record an anomaly event
   */
  private async recordAnomaly(
    assetId: number,
    anomaly: Omit<AnomalyEvent, 'id' | 'assetId' | 'detectedAt' | 'acknowledgedAt' | 'acknowledgedBy' | 'resolvedAt' | 'resolutionNotes'>
  ): Promise<AnomalyEvent> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Check for recent similar anomaly to avoid duplicates
    const recentResult = await db.execute<SqlRow>(sql`
      SELECT id FROM anomaly_events
      WHERE asset_id = ${assetId}
        AND anomaly_type = ${anomaly.anomalyType}
        AND metric_name = ${anomaly.metricName}
        AND detected_at > (NOW() - INTERVAL '1 hour')
        AND resolved_at IS NULL
      LIMIT 1
    `);

    if (recentResult.rows?.length > 0) {
      // Return existing anomaly instead of creating duplicate
      const existingId = recentResult.rows[0].id;
      return this.getAnomaly(existingId) as Promise<AnomalyEvent>;
    }

    const result = await db.execute<SqlRow>(sql`
      INSERT INTO anomaly_events (
        asset_id, anomaly_type, severity, detected_at,
        metric_name, expected_value, measured_value, deviation_percent,
        confidence_score, description, recommended_action,
        maintenance_required, estimated_impact, created_at
      ) VALUES (
        ${assetId}, ${anomaly.anomalyType}, ${anomaly.severity}, NOW(),
        ${anomaly.metricName}, ${anomaly.expectedValue || null}, ${anomaly.actualValue},
        ${anomaly.deviationPercent || null}, ${anomaly.confidenceScore},
        ${anomaly.description}, ${anomaly.recommendedAction || null},
        ${anomaly.maintenanceRequired}, ${anomaly.estimatedImpact || null}, NOW()
      )
      RETURNING id
    `);

    const anomalyId = Number(result.rows[0].id);

    // Publish to Kafka for lakehouse analytics
    try {
      await kafkaPublisher.publishAnomalyDetected({
        anomalyId: anomalyId.toString(),
        assetId: assetId.toString(),
        anomalyType: anomaly.anomalyType,
        score: anomaly.confidenceScore,
        severity: anomaly.severity,
        recommendedAction: anomaly.recommendedAction,
        timestamp: new Date(),
      });
    } catch (error) {
      console.error('[AnomalyDetection] Error publishing to Kafka:', error);
    }

    return {
      id: anomalyId,
      assetId,
      detectedAt: new Date(),
      acknowledgedAt: null,
      acknowledgedBy: null,
      resolvedAt: null,
      resolutionNotes: null,
      ...anomaly,
    };
  }

  /**
   * Get anomaly by ID
   */
  async getAnomaly(anomalyId: number): Promise<AnomalyEvent | null> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const result = await db.execute<SqlRow>(sql`
      SELECT * FROM anomaly_events WHERE id = ${anomalyId}
    `);

    const row = result.rows[0];
    return row ? this.mapRowToAnomaly(row) : null;
  }

  /**
   * Calculate asset health score
   */
  async calculateHealthScore(assetId: number): Promise<AssetHealthScore> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Get asset info
    const assetResult = await db.execute<SqlRow>(sql`
      SELECT * FROM assets WHERE id = ${assetId}
    `);
    const asset = assetResult.rows[0];
    if (!asset) throw new Error('Asset not found');

    // Get active anomalies
    const anomaliesResult = await db.execute<SqlRow>(sql`
      SELECT * FROM anomaly_events
      WHERE asset_id = ${assetId} AND resolved_at IS NULL
      ORDER BY severity DESC
    `);
    const activeAnomalies = anomaliesResult.rows || [];

    // Get recent telemetry for trend analysis
    const telemetryResult = await db.execute<SqlRow>(sql`
      SELECT * FROM telemetry
      WHERE "assetId" = ${assetId}
      ORDER BY timestamp DESC
      LIMIT 1000
    `);
    const telemetry = telemetryResult.rows || [];

    // Calculate component scores
    let performanceScore = 100;
    let reliabilityScore = 100;
    let efficiencyScore = 100;
    let communicationScore = 100;

    // Deduct points for anomalies
    for (const anomaly of activeAnomalies) {
      const deduction = anomaly.severity === 'critical' ? 30 :
                        anomaly.severity === 'high' ? 20 :
                        anomaly.severity === 'medium' ? 10 : 5;

      switch (anomaly.anomaly_type) {
        case 'performance_degradation':
        case 'unusual_pattern':
          performanceScore -= deduction;
          break;
        case 'communication_loss':
          communicationScore -= deduction;
          break;
        case 'efficiency_drop':
        case 'battery_health':
          efficiencyScore -= deduction;
          break;
        default:
          reliabilityScore -= deduction;
      }
    }

    // Check communication health
    if (telemetry.length > 0) {
      const lastTelemetry = new Date(telemetry[0].timestamp);
      const minutesSinceLastTelemetry = (Date.now() - lastTelemetry.getTime()) / 60000;
      if (minutesSinceLastTelemetry > 30) {
        communicationScore -= 20;
      } else if (minutesSinceLastTelemetry > 10) {
        communicationScore -= 10;
      }
    } else {
      communicationScore = 0;
    }

    // Ensure scores are within bounds
    performanceScore = Math.max(0, Math.min(100, performanceScore));
    reliabilityScore = Math.max(0, Math.min(100, reliabilityScore));
    efficiencyScore = Math.max(0, Math.min(100, efficiencyScore));
    communicationScore = Math.max(0, Math.min(100, communicationScore));

    const overallScore = Math.round(
      (performanceScore * 0.3 + reliabilityScore * 0.3 + efficiencyScore * 0.25 + communicationScore * 0.15)
    );

    // Determine trend
    let trend: 'improving' | 'stable' | 'degrading' = 'stable';
    const recentAnomaliesResult = await db.execute<SqlRow>(sql`
      SELECT COUNT(*) as count FROM anomaly_events
      WHERE asset_id = ${assetId}
        AND detected_at > (NOW() - INTERVAL '7 day')
    `);
    const recentCount = recentAnomaliesResult.rows[0]?.count || 0;
    
    const olderAnomaliesResult = await db.execute<SqlRow>(sql`
      SELECT COUNT(*) as count FROM anomaly_events
      WHERE asset_id = ${assetId}
        AND detected_at BETWEEN (NOW() - INTERVAL '14 day') AND (NOW() - INTERVAL '7 day')
    `);
    const olderCount = olderAnomaliesResult.rows[0]?.count || 0;

    if (recentCount > olderCount * 1.5) {
      trend = 'degrading';
    } else if (recentCount < olderCount * 0.5) {
      trend = 'improving';
    }

    // Generate maintenance recommendations
    const maintenanceRecommendations: string[] = [];
    for (const anomaly of activeAnomalies) {
      if (anomaly.maintenance_required && anomaly.recommended_action) {
        maintenanceRecommendations.push(anomaly.recommended_action);
      }
    }

    // Estimate remaining life (simplified)
    let estimatedRemainingLife: string | null = null;
    if (asset.assetType === 'battery' && overallScore < 70) {
      estimatedRemainingLife = overallScore < 50 ? '< 1 year' : '1-2 years';
    }

    return {
      assetId,
      assetName: asset.name,
      assetType: asset.assetType,
      overallScore,
      performanceScore,
      reliabilityScore,
      efficiencyScore,
      communicationScore,
      trend,
      lastUpdated: new Date(),
      activeAnomalies: activeAnomalies.length,
      maintenanceRecommendations: Array.from(new Set(maintenanceRecommendations)),
      estimatedRemainingLife,
    };
  }

  /**
   * Get maintenance recommendations for a user's assets
   */
  async getMaintenanceRecommendations(userId: number): Promise<MaintenanceRecommendation[]> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Get user's assets with active anomalies requiring maintenance
    const result = await db.execute<SqlRow>(sql`
      SELECT a.id as asset_id, ae.* FROM anomaly_events ae
      JOIN assets a ON a.id = ae.asset_id
      WHERE a."userId" = ${userId}
        AND ae.resolved_at IS NULL
        AND ae.maintenance_required = true
      ORDER BY ae.severity DESC, ae.detected_at DESC
    `);

    const anomalies = result.rows || [];
    const recommendations: MaintenanceRecommendation[] = [];
    const assetRecommendations: Map<number, MaintenanceRecommendation> = new Map();

    for (const anomaly of anomalies) {
      const existing = assetRecommendations.get(anomaly.asset_id);
      
      if (existing) {
        // Add anomaly to existing recommendation
        existing.basedOnAnomalies.push(anomaly.id);
        // Upgrade priority if needed
        if (anomaly.severity === 'critical' || anomaly.severity === 'high') {
          existing.priority = 'urgent';
        }
      } else {
        // Create new recommendation
        const priority = anomaly.severity === 'critical' ? 'urgent' :
                        anomaly.severity === 'high' ? 'high' :
                        anomaly.severity === 'medium' ? 'medium' : 'low';

        const recommendation: MaintenanceRecommendation = {
          assetId: anomaly.asset_id,
          priority,
          recommendationType: 'predictive',
          description: anomaly.description || anomaly.recommended_action,
          estimatedCost: null,
          estimatedDowntime: priority === 'urgent' ? '2-4 hours' : '1-2 hours',
          dueDate: priority === 'urgent' ? new Date(Date.now() + 24 * 3600000) :
                   priority === 'high' ? new Date(Date.now() + 7 * 24 * 3600000) :
                   new Date(Date.now() + 30 * 24 * 3600000),
          basedOnAnomalies: [anomaly.id],
        };

        assetRecommendations.set(anomaly.asset_id, recommendation);
      }
    }

    return Array.from(assetRecommendations.values())
      .sort((a, b) => {
        const priorityOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      });
  }

  /**
   * Acknowledge an anomaly
   */
  async acknowledgeAnomaly(anomalyId: number, userId: number): Promise<AnomalyEvent> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    await db.execute<SqlRow>(sql`
      UPDATE anomaly_events SET
        acknowledged_at = NOW(),
        acknowledged_by = ${userId}
      WHERE id = ${anomalyId}
    `);

    return this.getAnomaly(anomalyId) as Promise<AnomalyEvent>;
  }

  /**
   * Resolve an anomaly
   */
  async resolveAnomaly(anomalyId: number, resolutionNotes: string): Promise<AnomalyEvent> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    await db.execute<SqlRow>(sql`
      UPDATE anomaly_events SET
        resolved_at = NOW(),
        resolution_notes = ${resolutionNotes}
      WHERE id = ${anomalyId}
    `);

    return this.getAnomaly(anomalyId) as Promise<AnomalyEvent>;
  }

  /**
   * Get active anomalies for a user
   */
  async getUserAnomalies(userId: number, severity?: string): Promise<AnomalyEvent[]> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    let query;
    if (severity) {
      query = sql`
        SELECT ae.* FROM anomaly_events ae
        JOIN assets a ON a.id = ae.asset_id
        WHERE a."userId" = ${userId}
          AND ae.resolved_at IS NULL
          AND ae.severity = ${severity}
        ORDER BY ae.detected_at DESC
      `;
    } else {
      query = sql`
        SELECT ae.* FROM anomaly_events ae
        JOIN assets a ON a.id = ae.asset_id
        WHERE a."userId" = ${userId}
          AND ae.resolved_at IS NULL
        ORDER BY ae.severity DESC, ae.detected_at DESC
      `;
    }

    const result = await db.execute<SqlRow>(query);
    return (result.rows || []).map(this.mapRowToAnomaly);
  }

  /**
   * Run anomaly detection for all user assets
   */
  async runDetectionForUser(userId: number): Promise<AnomalyEvent[]> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const assetsResult = await db.execute<SqlRow>(sql`
      SELECT id FROM assets WHERE "userId" = ${userId} AND status = 'active'
    `);
    const assets = assetsResult.rows || [];

    const allAnomalies: AnomalyEvent[] = [];
    for (const asset of assets) {
      const anomalies = await this.detectAnomalies(asset.id);
      allAnomalies.push(...anomalies);
    }

    return allAnomalies;
  }

  /**
   * Calculate telemetry statistics
   */
  private calculateTelemetryStats(telemetry: any[]): TelemetryStats {
    if (telemetry.length === 0) {
      return {
        powerMean: null,
        powerStd: null,
        socChangeRate: null,
        roundTripEfficiency: null,
      };
    }

    // Power statistics
    const powers = telemetry.map(t => t.power || 0);
    const powerMean = powers.reduce((a, b) => a + b, 0) / powers.length;
    const powerVariance = powers.reduce((acc, p) => acc + Math.pow(p - powerMean, 2), 0) / powers.length;
    const powerStd = Math.sqrt(powerVariance);

    // SoC change rate (for batteries)
    let socChangeRate: number | null = null;
    const socReadings = telemetry.filter(t => t.stateOfCharge !== null);
    if (socReadings.length >= 2) {
      const firstSoc = socReadings[socReadings.length - 1].stateOfCharge;
      const lastSoc = socReadings[0].stateOfCharge;
      const firstTime = new Date(socReadings[socReadings.length - 1].timestamp).getTime();
      const lastTime = new Date(socReadings[0].timestamp).getTime();
      const hoursDiff = (lastTime - firstTime) / 3600000;
      if (hoursDiff > 0) {
        socChangeRate = (lastSoc - firstSoc) / hoursDiff;
      }
    }

    // Round-trip efficiency (simplified)
    let roundTripEfficiency: number | null = null;
    const chargeEnergy = telemetry.filter(t => (t.power || 0) < 0).reduce((acc, t) => acc + Math.abs(t.power || 0), 0);
    const dischargeEnergy = telemetry.filter(t => (t.power || 0) > 0).reduce((acc, t) => acc + (t.power || 0), 0);
    if (chargeEnergy > 0) {
      roundTripEfficiency = dischargeEnergy / chargeEnergy;
    }

    return {
      powerMean,
      powerStd,
      socChangeRate,
      roundTripEfficiency,
    };
  }

  /**
   * Get solar irradiance factor for hour of day
   */
  private getSolarIrradianceFactor(hour: number): number {
    // Simplified solar curve (peak at noon)
    if (hour < 6 || hour > 18) return 0;
    return Math.sin(((hour - 6) / 12) * Math.PI);
  }

  private mapRowToAnomaly(row: any): AnomalyEvent {
    return {
      id: row.id,
      assetId: row.asset_id,
      anomalyType: row.anomaly_type,
      severity: row.severity,
      detectedAt: row.detected_at,
      metricName: row.metric_name,
      expectedValue: row.expected_value,
      actualValue: row.measured_value,
      deviationPercent: row.deviation_percent,
      confidenceScore: row.confidence_score,
      description: row.description,
      recommendedAction: row.recommended_action,
      maintenanceRequired: row.maintenance_required,
      estimatedImpact: row.estimated_impact,
      acknowledgedAt: row.acknowledged_at,
      acknowledgedBy: row.acknowledged_by,
      resolvedAt: row.resolved_at,
      resolutionNotes: row.resolution_notes,
    };
  }
}

interface TelemetryStats {
  powerMean: number | null;
  powerStd: number | null;
  socChangeRate: number | null;
  roundTripEfficiency: number | null;
}

// Singleton instance
export const anomalyDetection = new AnomalyDetectionService();
