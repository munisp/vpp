/**
 * Edge Orchestration Service
 * 
 * Manages edge gateways for local control execution with offline operation,
 * command queuing, and cryptographically verifiable telemetry.
 */

import { getDb } from '../db';
import { sql } from 'drizzle-orm';
import { createHash, createHmac } from 'crypto';
import { kafkaPublisher } from '../integration/kafka-publisher';

// Types for edge orchestration
export interface EdgeGateway {
  id: number;
  gatewayId: string;
  name: string;
  siteId: number | null;
  communityId: number | null;
  hardwareModel: string | null;
  firmwareVersion: string | null;
  primaryProtocol: 'mqtt' | 'grpc' | 'https';
  connectionEndpoint: string | null;
  canOperateOffline: boolean;
  localStorageCapacityMb: number | null;
  maxManagedDevices: number | null;
  certificateFingerprint: string | null;
  status: 'online' | 'offline' | 'degraded' | 'maintenance';
  lastHeartbeat: Date | null;
  offlineMode: boolean;
  pendingCommandsCount: number;
}

export interface EdgeCommand {
  id: number;
  gatewayId: number;
  commandId: string;
  idempotencyKey: string;
  targetDeviceId: number | null;
  targetAssetId: number | null;
  commandType: string;
  commandPayload: Record<string, any>;
  priority: number;
  validUntil: Date;
  status: 'queued' | 'sent' | 'acknowledged' | 'executing' | 'completed' | 'failed' | 'expired';
  queuedAt: Date;
  sentAt: Date | null;
  acknowledgedAt: Date | null;
  completedAt: Date | null;
  responsePayload: Record<string, any> | null;
  errorMessage: string | null;
  responseSignature: string | null;
}

export interface SignedTelemetry {
  gatewayId: string;
  deviceId: string;
  timestamp: Date;
  measurements: Record<string, number>;
  signature: string;
  sequenceNumber: number;
}

export interface GatewayHealth {
  gatewayId: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  lastHeartbeat: Date | null;
  uptimeSeconds: number;
  pendingCommands: number;
  failedCommands24h: number;
  avgResponseTimeMs: number;
  offlineMode: boolean;
  managedDevices: number;
  issues: string[];
}

// Secret key for HMAC signing - REQUIRED in production
const SIGNING_SECRET = process.env.EDGE_SIGNING_SECRET;
if (!SIGNING_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('EDGE_SIGNING_SECRET environment variable is required in production');
}
const EFFECTIVE_SIGNING_SECRET = SIGNING_SECRET || 'dev-only-signing-key-not-for-production';

export class EdgeOrchestrationService {
  
  /**
   * Register a new edge gateway
   */
  async registerGateway(
    gatewayId: string,
    name: string,
    options: {
      siteId?: number;
      communityId?: number;
      hardwareModel?: string;
      firmwareVersion?: string;
      primaryProtocol?: 'mqtt' | 'grpc' | 'https';
      connectionEndpoint?: string;
      canOperateOffline?: boolean;
      localStorageCapacityMb?: number;
      maxManagedDevices?: number;
    } = {}
  ): Promise<EdgeGateway> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Generate certificate fingerprint
    const certificateFingerprint = createHash('sha256')
      .update(`${gatewayId}-${Date.now()}-${Math.random()}`)
      .digest('hex');

    const result = await db.execute(sql`
      INSERT INTO edge_gateways (
        gateway_id, name, site_id, community_id,
        hardware_model, firmware_version, primary_protocol, connection_endpoint,
        can_operate_offline, local_storage_capacity_mb, max_managed_devices,
        certificate_fingerprint, status, offline_mode, pending_commands_count,
        created_at, updated_at
      ) VALUES (
        ${gatewayId}, ${name}, ${options.siteId || null}, ${options.communityId || null},
        ${options.hardwareModel || null}, ${options.firmwareVersion || null},
        ${options.primaryProtocol || 'mqtt'}, ${options.connectionEndpoint || null},
        ${options.canOperateOffline ?? true}, ${options.localStorageCapacityMb || null},
        ${options.maxManagedDevices || null}, ${certificateFingerprint},
        'offline', false, 0, NOW(), NOW()
      )
    `);

    console.log(`[EdgeOrchestration] Registered gateway ${gatewayId}`);

    return {
      id: (result as any).insertId,
      gatewayId,
      name,
      siteId: options.siteId || null,
      communityId: options.communityId || null,
      hardwareModel: options.hardwareModel || null,
      firmwareVersion: options.firmwareVersion || null,
      primaryProtocol: options.primaryProtocol || 'mqtt',
      connectionEndpoint: options.connectionEndpoint || null,
      canOperateOffline: options.canOperateOffline ?? true,
      localStorageCapacityMb: options.localStorageCapacityMb || null,
      maxManagedDevices: options.maxManagedDevices || null,
      certificateFingerprint,
      status: 'offline',
      lastHeartbeat: null,
      offlineMode: false,
      pendingCommandsCount: 0,
    };
  }

  /**
   * Process gateway heartbeat
   */
  async processHeartbeat(
    gatewayId: string,
    heartbeat: {
      firmwareVersion?: string;
      uptimeSeconds: number;
      pendingCommandsLocal: number;
      managedDevices: number;
      offlineMode: boolean;
      memoryUsagePercent?: number;
      storageUsagePercent?: number;
    }
  ): Promise<{ acknowledged: boolean; pendingCommands: EdgeCommand[] }> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Update gateway status
    await db.execute(sql`
      UPDATE edge_gateways SET
        status = 'online',
        last_heartbeat = NOW(),
        offline_mode = ${heartbeat.offlineMode},
        firmware_version = COALESCE(${heartbeat.firmwareVersion || null}, firmware_version),
        metadata = JSON_SET(
          COALESCE(metadata, '{}'),
          '$.uptimeSeconds', ${heartbeat.uptimeSeconds},
          '$.managedDevices', ${heartbeat.managedDevices},
          '$.memoryUsagePercent', ${heartbeat.memoryUsagePercent || 0},
          '$.storageUsagePercent', ${heartbeat.storageUsagePercent || 0}
        ),
        updated_at = NOW()
      WHERE gateway_id = ${gatewayId}
    `);

    // Get pending commands for this gateway
    const pendingResult = await db.execute(sql`
      SELECT ec.* FROM edge_commands ec
      JOIN edge_gateways eg ON eg.id = ec.gateway_id
      WHERE eg.gateway_id = ${gatewayId}
        AND ec.status = 'queued'
        AND ec.valid_until > NOW()
      ORDER BY ec.priority DESC, ec.queued_at ASC
      LIMIT 10
    `);

    const pendingCommands = ((pendingResult as any)[0] || []).map(this.mapRowToCommand);

    // Mark commands as sent
    for (const cmd of pendingCommands) {
      await db.execute(sql`
        UPDATE edge_commands SET status = 'sent', sent_at = NOW()
        WHERE id = ${cmd.id}
      `);
    }

    console.log(`[EdgeOrchestration] Heartbeat from ${gatewayId}: ${pendingCommands.length} commands dispatched`);

    return {
      acknowledged: true,
      pendingCommands,
    };
  }

  /**
   * Queue a command for edge execution
   */
  async queueCommand(
    gatewayId: string,
    command: {
      commandType: 'set_power' | 'set_soc_target' | 'start_charging' | 'stop_charging' | 
                   'enable_v2g' | 'disable_v2g' | 'emergency_stop' | 'update_config';
      targetDeviceId?: number;
      targetAssetId?: number;
      payload: Record<string, any>;
      priority?: number;
      validForSeconds?: number;
      idempotencyKey?: string;
    }
  ): Promise<EdgeCommand> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Get gateway ID
    const gatewayResult = await db.execute(sql`
      SELECT id FROM edge_gateways WHERE gateway_id = ${gatewayId}
    `);
    const gateway = (gatewayResult as any)[0]?.[0];
    if (!gateway) throw new Error(`Gateway ${gatewayId} not found`);

    const commandId = this.generateCommandId();
    const idempotencyKey = command.idempotencyKey || commandId;
    const validUntil = new Date(Date.now() + (command.validForSeconds || 300) * 1000);

    // Check for duplicate idempotency key
    const existingResult = await db.execute(sql`
      SELECT id, status FROM edge_commands
      WHERE idempotency_key = ${idempotencyKey}
    `);
    const existing = (existingResult as any)[0]?.[0];
    if (existing) {
      console.log(`[EdgeOrchestration] Duplicate command with idempotency key ${idempotencyKey}`);
      return this.getCommand(existing.id) as Promise<EdgeCommand>;
    }

    const result = await db.execute(sql`
      INSERT INTO edge_commands (
        gateway_id, command_id, idempotency_key,
        target_device_id, target_asset_id, command_type, command_payload,
        priority, valid_until, status, queued_at, created_at
      ) VALUES (
        ${gateway.id}, ${commandId}, ${idempotencyKey},
        ${command.targetDeviceId || null}, ${command.targetAssetId || null},
        ${command.commandType}, ${JSON.stringify(command.payload)},
        ${command.priority || 5}, ${validUntil}, 'queued', NOW(), NOW()
      )
    `);

    // Update pending count
    await db.execute(sql`
      UPDATE edge_gateways SET
        pending_commands_count = pending_commands_count + 1,
        updated_at = NOW()
      WHERE id = ${gateway.id}
    `);

    console.log(`[EdgeOrchestration] Queued ${command.commandType} command ${commandId} for gateway ${gatewayId}`);

    // Publish to Kafka for lakehouse analytics
    try {
      await kafkaPublisher.publishEdgeCommand({
        commandId,
        gatewayId,
        deviceId: command.targetDeviceId?.toString(),
        commandType: command.commandType,
        status: 'queued',
        issuedAt: new Date(),
        timestamp: new Date(),
      });
    } catch (error) {
      console.error('[EdgeOrchestration] Error publishing to Kafka:', error);
    }

    return {
      id: (result as any).insertId,
      gatewayId: gateway.id,
      commandId,
      idempotencyKey,
      targetDeviceId: command.targetDeviceId || null,
      targetAssetId: command.targetAssetId || null,
      commandType: command.commandType,
      commandPayload: command.payload,
      priority: command.priority || 5,
      validUntil,
      status: 'queued',
      queuedAt: new Date(),
      sentAt: null,
      acknowledgedAt: null,
      completedAt: null,
      responsePayload: null,
      errorMessage: null,
      responseSignature: null,
    };
  }

  /**
   * Process command acknowledgment from edge
   */
  async acknowledgeCommand(
    commandId: string,
    acknowledgment: {
      status: 'acknowledged' | 'executing' | 'completed' | 'failed';
      responsePayload?: Record<string, any>;
      errorMessage?: string;
      signature?: string;
    }
  ): Promise<boolean> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Verify signature if provided
    if (acknowledgment.signature) {
      const isValid = this.verifySignature(
        commandId,
        acknowledgment.responsePayload || {},
        acknowledgment.signature
      );
      if (!isValid) {
        console.warn(`[EdgeOrchestration] Invalid signature for command ${commandId}`);
        // Continue processing but log the warning
      }
    }

    const updateFields: Record<string, any> = {
      status: acknowledgment.status,
    };

    if (acknowledgment.status === 'acknowledged') {
      updateFields.acknowledgedAt = new Date();
    } else if (acknowledgment.status === 'completed' || acknowledgment.status === 'failed') {
      updateFields.completedAt = new Date();
    }

    await db.execute(sql`
      UPDATE edge_commands SET
        status = ${acknowledgment.status},
        acknowledged_at = ${updateFields.acknowledgedAt || null},
        completed_at = ${updateFields.completedAt || null},
        response_payload = ${acknowledgment.responsePayload ? JSON.stringify(acknowledgment.responsePayload) : null},
        error_message = ${acknowledgment.errorMessage || null},
        response_signature = ${acknowledgment.signature || null}
      WHERE command_id = ${commandId}
    `);

    // Update pending count if completed or failed
    if (acknowledgment.status === 'completed' || acknowledgment.status === 'failed') {
      await db.execute(sql`
        UPDATE edge_gateways eg
        JOIN edge_commands ec ON ec.gateway_id = eg.id
        SET eg.pending_commands_count = GREATEST(0, eg.pending_commands_count - 1),
            eg.updated_at = NOW()
        WHERE ec.command_id = ${commandId}
      `);
    }

    console.log(`[EdgeOrchestration] Command ${commandId} ${acknowledgment.status}`);
    return true;
  }

  /**
   * Process signed telemetry from edge
   */
  async processSignedTelemetry(telemetry: SignedTelemetry): Promise<{
    accepted: boolean;
    reason?: string;
  }> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Verify signature
    const dataToSign = `${telemetry.gatewayId}|${telemetry.deviceId}|${telemetry.timestamp.toISOString()}|${telemetry.sequenceNumber}|${JSON.stringify(telemetry.measurements)}`;
    const expectedSignature = createHmac('sha256', EFFECTIVE_SIGNING_SECRET)
      .update(dataToSign)
      .digest('hex');

    if (telemetry.signature !== expectedSignature) {
      console.warn(`[EdgeOrchestration] Invalid telemetry signature from ${telemetry.gatewayId}`);
      return { accepted: false, reason: 'Invalid signature' };
    }

    // Check sequence number to detect gaps
    const lastSeqResult = await db.execute(sql`
      SELECT MAX(JSON_EXTRACT(metadata, '$.sequenceNumber')) as last_seq
      FROM telemetry t
      JOIN devices d ON d.id = t.assetId
      WHERE d.deviceId = ${telemetry.deviceId}
    `);
    const lastSeq = (lastSeqResult as any)[0]?.[0]?.last_seq || 0;

    if (telemetry.sequenceNumber <= lastSeq) {
      return { accepted: false, reason: 'Duplicate or out-of-order telemetry' };
    }

    if (telemetry.sequenceNumber > lastSeq + 1) {
      console.warn(`[EdgeOrchestration] Telemetry gap detected: expected ${lastSeq + 1}, got ${telemetry.sequenceNumber}`);
    }

    // Get device and asset IDs
    const deviceResult = await db.execute(sql`
      SELECT id, assetId FROM devices WHERE deviceId = ${telemetry.deviceId}
    `);
    const device = (deviceResult as any)[0]?.[0];
    if (!device) {
      return { accepted: false, reason: 'Unknown device' };
    }

    // Store telemetry
    await db.execute(sql`
      INSERT INTO telemetry (
        assetId, timestamp, power, energy, voltage, current, frequency,
        stateOfCharge, temperature, metadata, createdAt
      ) VALUES (
        ${device.assetId}, ${telemetry.timestamp},
        ${telemetry.measurements.power || null},
        ${telemetry.measurements.energy || null},
        ${telemetry.measurements.voltage || null},
        ${telemetry.measurements.current || null},
        ${telemetry.measurements.frequency || null},
        ${telemetry.measurements.stateOfCharge || null},
        ${telemetry.measurements.temperature || null},
        ${JSON.stringify({ sequenceNumber: telemetry.sequenceNumber, gatewayId: telemetry.gatewayId, signed: true })},
        NOW()
      )
    `);

    return { accepted: true };
  }

  /**
   * Get gateway health status
   */
  async getGatewayHealth(gatewayId: string): Promise<GatewayHealth> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const gatewayResult = await db.execute(sql`
      SELECT * FROM edge_gateways WHERE gateway_id = ${gatewayId}
    `);
    const gateway = (gatewayResult as any)[0]?.[0];
    if (!gateway) throw new Error(`Gateway ${gatewayId} not found`);

    // Get command statistics
    const statsResult = await db.execute(sql`
      SELECT
        COUNT(CASE WHEN status = 'failed' AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR) THEN 1 END) as failed_24h,
        AVG(TIMESTAMPDIFF(SECOND, sent_at, acknowledged_at)) as avg_response_time
      FROM edge_commands
      WHERE gateway_id = ${gateway.id}
    `);
    const stats = (statsResult as any)[0]?.[0] || {};

    // Get managed devices count
    const devicesResult = await db.execute(sql`
      SELECT COUNT(*) as count FROM devices d
      JOIN assets a ON a.id = d.assetId
      WHERE a.userId IN (
        SELECT user_id FROM community_members WHERE community_id = ${gateway.community_id}
        UNION SELECT userId FROM assets WHERE id IN (
          SELECT asset_id FROM der_capabilities WHERE protocols LIKE '%mqtt%'
        )
      )
    `);
    const managedDevices = (devicesResult as any)[0]?.[0]?.count || 0;

    // Determine health status
    const issues: string[] = [];
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

    const lastHeartbeat = gateway.last_heartbeat ? new Date(gateway.last_heartbeat) : null;
    const heartbeatAge = lastHeartbeat ? (Date.now() - lastHeartbeat.getTime()) / 1000 : Infinity;

    if (heartbeatAge > 300) {
      issues.push('No heartbeat in last 5 minutes');
      status = 'unhealthy';
    } else if (heartbeatAge > 60) {
      issues.push('Heartbeat delayed');
      status = 'degraded';
    }

    if (stats.failed_24h > 10) {
      issues.push(`${stats.failed_24h} failed commands in last 24h`);
      status = status === 'unhealthy' ? 'unhealthy' : 'degraded';
    }

    if (gateway.offline_mode) {
      issues.push('Operating in offline mode');
      status = status === 'unhealthy' ? 'unhealthy' : 'degraded';
    }

    if (gateway.pending_commands_count > 50) {
      issues.push('High pending command queue');
      status = status === 'unhealthy' ? 'unhealthy' : 'degraded';
    }

    // Calculate uptime from metadata
    let uptimeSeconds = 0;
    try {
      const metadata = gateway.metadata ? JSON.parse(gateway.metadata) : {};
      uptimeSeconds = metadata.uptimeSeconds || 0;
    } catch (e) {
      // Ignore parse errors
    }

    return {
      gatewayId,
      status,
      lastHeartbeat,
      uptimeSeconds,
      pendingCommands: gateway.pending_commands_count,
      failedCommands24h: stats.failed_24h || 0,
      avgResponseTimeMs: (stats.avg_response_time || 0) * 1000,
      offlineMode: gateway.offline_mode,
      managedDevices,
      issues,
    };
  }

  /**
   * Get all gateways for a site or community
   */
  async getGateways(scope: { siteId?: number; communityId?: number }): Promise<EdgeGateway[]> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    let query;
    if (scope.siteId) {
      query = sql`SELECT * FROM edge_gateways WHERE site_id = ${scope.siteId}`;
    } else if (scope.communityId) {
      query = sql`SELECT * FROM edge_gateways WHERE community_id = ${scope.communityId}`;
    } else {
      query = sql`SELECT * FROM edge_gateways ORDER BY created_at DESC LIMIT 100`;
    }

    const result = await db.execute(query);
    return ((result as any)[0] || []).map(this.mapRowToGateway);
  }

  /**
   * Get command by ID
   */
  async getCommand(commandId: number | string): Promise<EdgeCommand | null> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    let query;
    if (typeof commandId === 'number') {
      query = sql`SELECT * FROM edge_commands WHERE id = ${commandId}`;
    } else {
      query = sql`SELECT * FROM edge_commands WHERE command_id = ${commandId}`;
    }

    const result = await db.execute(query);
    const row = (result as any)[0]?.[0];
    return row ? this.mapRowToCommand(row) : null;
  }

  /**
   * Expire old commands
   */
  async expireCommands(): Promise<number> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const result = await db.execute(sql`
      UPDATE edge_commands
      SET status = 'expired'
      WHERE status IN ('queued', 'sent')
        AND valid_until < NOW()
    `);

    const expiredCount = (result as any).affectedRows || 0;
    if (expiredCount > 0) {
      console.log(`[EdgeOrchestration] Expired ${expiredCount} commands`);
    }

    return expiredCount;
  }

  /**
   * Send emergency stop to all devices on a gateway
   */
  async emergencyStop(gatewayId: string, reason: string): Promise<EdgeCommand> {
    return this.queueCommand(gatewayId, {
      commandType: 'emergency_stop',
      payload: { reason, timestamp: new Date().toISOString() },
      priority: 10, // Highest priority
      validForSeconds: 60,
    });
  }

  /**
   * Generate command ID
   */
  private generateCommandId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `cmd_${timestamp}_${random}`;
  }

  /**
   * Verify response signature
   */
  private verifySignature(commandId: string, payload: Record<string, any>, signature: string): boolean {
    const dataToSign = `${commandId}|${JSON.stringify(payload)}`;
    const expectedSignature = createHmac('sha256', EFFECTIVE_SIGNING_SECRET)
      .update(dataToSign)
      .digest('hex');
    return signature === expectedSignature;
  }

  /**
   * Create signature for telemetry
   */
  createTelemetrySignature(
    gatewayId: string,
    deviceId: string,
    timestamp: Date,
    sequenceNumber: number,
    measurements: Record<string, number>
  ): string {
    const dataToSign = `${gatewayId}|${deviceId}|${timestamp.toISOString()}|${sequenceNumber}|${JSON.stringify(measurements)}`;
    return createHmac('sha256', EFFECTIVE_SIGNING_SECRET)
      .update(dataToSign)
      .digest('hex');
  }

  private mapRowToGateway(row: any): EdgeGateway {
    return {
      id: row.id,
      gatewayId: row.gateway_id,
      name: row.name,
      siteId: row.site_id,
      communityId: row.community_id,
      hardwareModel: row.hardware_model,
      firmwareVersion: row.firmware_version,
      primaryProtocol: row.primary_protocol,
      connectionEndpoint: row.connection_endpoint,
      canOperateOffline: row.can_operate_offline,
      localStorageCapacityMb: row.local_storage_capacity_mb,
      maxManagedDevices: row.max_managed_devices,
      certificateFingerprint: row.certificate_fingerprint,
      status: row.status,
      lastHeartbeat: row.last_heartbeat,
      offlineMode: row.offline_mode,
      pendingCommandsCount: row.pending_commands_count,
    };
  }

  private mapRowToCommand(row: any): EdgeCommand {
    return {
      id: row.id,
      gatewayId: row.gateway_id,
      commandId: row.command_id,
      idempotencyKey: row.idempotency_key,
      targetDeviceId: row.target_device_id,
      targetAssetId: row.target_asset_id,
      commandType: row.command_type,
      commandPayload: row.command_payload ? JSON.parse(row.command_payload) : {},
      priority: row.priority,
      validUntil: row.valid_until,
      status: row.status,
      queuedAt: row.queued_at,
      sentAt: row.sent_at,
      acknowledgedAt: row.acknowledged_at,
      completedAt: row.completed_at,
      responsePayload: row.response_payload ? JSON.parse(row.response_payload) : null,
      errorMessage: row.error_message,
      responseSignature: row.response_signature,
    };
  }
}

// Singleton instance
export const edgeOrchestration = new EdgeOrchestrationService();
