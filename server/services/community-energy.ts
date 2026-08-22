/**
 * Community Energy Service
 * 
 * Manages energy communities, shared resources, peer allocations,
 * and microgrid operations including islanding mode.
 */

import { getDb } from '../db';
import { sql, and, gte, lte } from 'drizzle-orm';
import { settlementLedger } from './settlement-ledger';
import { derCapabilities } from './der-capabilities';
import { kafkaPublisher } from '../integration/kafka-publisher';
import { marketPrices } from '../../drizzle/schema';
import { pricePredictionService } from '../ml/price-prediction';
import type { SqlRow } from '../sql-row';
import { jsonSetText } from '../sql-json';

// Types for community energy
export interface EnergyCommunity {
  id: number;
  communityCode: string;
  name: string;
  description: string | null;
  communityType: 'residential' | 'commercial' | 'mixed' | 'microgrid' | 'virtual';
  region: string | null;
  gridConnectionPoint: string | null;
  governanceModel: 'cooperative' | 'utility_managed' | 'peer_to_peer' | 'hybrid';
  hasSharedBattery: boolean;
  hasSharedSolar: boolean;
  sharedCapacityKw: number | null;
  canIsland: boolean;
  islandingMode: 'grid_tied' | 'islanded' | 'transitioning';
  allocationMethod: 'equal_share' | 'proportional_capacity' | 'proportional_consumption' | 'dynamic_pricing' | 'custom';
  status: 'forming' | 'active' | 'suspended' | 'dissolved';
}

export interface CommunityMember {
  id: number;
  communityId: number;
  userId: number;
  role: 'member' | 'prosumer' | 'admin' | 'operator';
  joinedAt: Date;
  contributedCapacityKw: number;
  sharePercentage: number | null;
  autoParticipate: boolean;
  priorityLevel: number;
  status: 'pending' | 'active' | 'suspended' | 'left';
}

export interface CommunityAllocation {
  id: number;
  communityId: number;
  periodStart: Date;
  periodEnd: Date;
  totalGenerationWh: number;
  totalConsumptionWh: number;
  totalExportWh: number;
  totalImportWh: number;
  totalRevenue: number;
  totalCost: number;
  netValue: number;
  memberAllocations: MemberAllocation[];
  status: 'calculated' | 'approved' | 'distributed' | 'disputed';
}

export interface MemberAllocation {
  userId: number;
  userName: string;
  contributedCapacityKw: number;
  sharePercentage: number;
  generationWh: number;
  consumptionWh: number;
  netEnergyWh: number;
  grossValue: number;
  fees: number;
  netValue: number;
}

export interface MicrogridStatus {
  communityId: number;
  mode: 'grid_tied' | 'islanded' | 'transitioning';
  gridConnectionStatus: 'connected' | 'disconnected' | 'fault';
  totalGenerationKw: number;
  totalLoadKw: number;
  batterySOC: number | null;
  frequencyHz: number | null;
  voltageV: number | null;
  criticalLoadsServed: boolean;
  estimatedAutonomyHours: number | null;
  lastTransition: Date | null;
  telemetryAvailable: boolean; // false when no recent telemetry exists for community assets
  alerts: string[];
}

export class CommunityEnergyService {
  
  /**
   * Create a new energy community
   */
  async createCommunity(
    community: {
      name: string;
      description?: string;
      communityType: EnergyCommunity['communityType'];
      region?: string;
      gridConnectionPoint?: string;
      governanceModel?: EnergyCommunity['governanceModel'];
      allocationMethod?: EnergyCommunity['allocationMethod'];
      canIsland?: boolean;
    }
  ): Promise<EnergyCommunity> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const communityCode = `EC_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;

    const result = await db.execute<SqlRow>(sql`
      INSERT INTO energy_communities (
        community_code, name, description, community_type,
        region, grid_connection_point, governance_model,
        has_shared_battery, has_shared_solar, shared_capacity_kw,
        can_island, islanding_mode, allocation_method, status,
        created_at, updated_at
      ) VALUES (
        ${communityCode}, ${community.name}, ${community.description || null},
        ${community.communityType}, ${community.region || null},
        ${community.gridConnectionPoint || null},
        ${community.governanceModel || 'cooperative'},
        false, false, null,
        ${community.canIsland || false}, 'grid_tied',
        ${community.allocationMethod || 'proportional_capacity'},
        'forming', NOW(), NOW()
      )
      RETURNING id
    `);

    console.log(`[CommunityEnergy] Created community ${communityCode}: ${community.name}`);

    return this.getCommunity(Number(result.rows[0].id)) as Promise<EnergyCommunity>;
  }

  /**
   * Get community by ID or code
   */
  async getCommunity(communityId: number | string): Promise<EnergyCommunity | null> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    let query;
    if (typeof communityId === 'number') {
      query = sql`SELECT * FROM energy_communities WHERE id = ${communityId}`;
    } else {
      query = sql`SELECT * FROM energy_communities WHERE community_code = ${communityId}`;
    }

    const result = await db.execute<SqlRow>(query);
    const row = result.rows[0];
    return row ? this.mapRowToCommunity(row) : null;
  }

  /**
   * Add a member to a community
   */
  async addMember(
    communityId: number,
    userId: number,
    options: {
      role?: CommunityMember['role'];
      contributedCapacityKw?: number;
      sharePercentage?: number;
      autoParticipate?: boolean;
      priorityLevel?: number;
    } = {}
  ): Promise<CommunityMember> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Check if already a member
    const existingResult = await db.execute<SqlRow>(sql`
      SELECT id FROM community_members
      WHERE community_id = ${communityId} AND user_id = ${userId}
    `);
    if (existingResult.rows?.length > 0) {
      throw new Error('User is already a member of this community');
    }

    // Calculate contributed capacity from user's assets if not provided
    let contributedCapacity = options.contributedCapacityKw || 0;
    if (!options.contributedCapacityKw) {
      const assetsResult = await db.execute<SqlRow>(sql`
        SELECT SUM(capacity) as total FROM assets
        WHERE "userId" = ${userId} AND status = 'active'
      `);
      contributedCapacity = (assetsResult.rows[0]?.total || 0) / 1000; // Convert W to kW
    }

    const result = await db.execute<SqlRow>(sql`
      INSERT INTO community_members (
        community_id, user_id, role, joined_at,
        contributed_capacity_kw, share_percentage,
        auto_participate, priority_level, status,
        created_at, updated_at
      ) VALUES (
        ${communityId}, ${userId}, ${options.role || 'member'}, NOW(),
        ${contributedCapacity}, ${options.sharePercentage || null},
        ${options.autoParticipate ?? true}, ${options.priorityLevel || 5},
        'pending', NOW(), NOW()
      )
    `);

    // Recalculate share percentages
    await this.recalculateShares(communityId);

    console.log(`[CommunityEnergy] Added user ${userId} to community ${communityId}`);

    return this.getMember(Number(result.rows[0].id)) as Promise<CommunityMember>;
  }

  /**
   * Get member by ID
   */
  async getMember(memberId: number): Promise<CommunityMember | null> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const result = await db.execute<SqlRow>(sql`
      SELECT * FROM community_members WHERE id = ${memberId}
    `);

    const row = result.rows[0];
    return row ? this.mapRowToMember(row) : null;
  }

  /**
   * Get all members of a community
   */
  async getCommunityMembers(communityId: number): Promise<CommunityMember[]> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const result = await db.execute<SqlRow>(sql`
      SELECT * FROM community_members
      WHERE community_id = ${communityId} AND status IN ('pending', 'active')
      ORDER BY joined_at
    `);

    return (result.rows || []).map(this.mapRowToMember);
  }

  /**
   * Approve a pending member
   */
  async approveMember(memberId: number): Promise<CommunityMember> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    await db.execute<SqlRow>(sql`
      UPDATE community_members SET status = 'active', updated_at = NOW()
      WHERE id = ${memberId}
    `);

    const member = await this.getMember(memberId);
    if (member) {
      await this.recalculateShares(member.communityId);
    }

    return member as CommunityMember;
  }

  /**
   * Recalculate share percentages based on contributed capacity
   */
  private async recalculateShares(communityId: number): Promise<void> {
    const db = await getDb();
    if (!db) return;

    const community = await this.getCommunity(communityId);
    if (!community) return;

    const members = await this.getCommunityMembers(communityId);
    const activeMembers = members.filter(m => m.status === 'active');

    if (activeMembers.length === 0) return;

    let totalCapacity = 0;
    for (const member of activeMembers) {
      totalCapacity += member.contributedCapacityKw;
    }

    for (const member of activeMembers) {
      let sharePercentage: number;

      switch (community.allocationMethod) {
        case 'equal_share':
          sharePercentage = 10000 / activeMembers.length; // percentage * 100
          break;
        case 'proportional_capacity':
          sharePercentage = totalCapacity > 0 
            ? (member.contributedCapacityKw / totalCapacity) * 10000 
            : 10000 / activeMembers.length;
          break;
        default:
          sharePercentage = totalCapacity > 0 
            ? (member.contributedCapacityKw / totalCapacity) * 10000 
            : 10000 / activeMembers.length;
      }

      await db.execute<SqlRow>(sql`
        UPDATE community_members SET share_percentage = ${Math.round(sharePercentage)}, updated_at = NOW()
        WHERE id = ${member.id}
      `);
    }
  }

  /**
   * Calculate energy allocation for a period
   */
  async calculateAllocation(
    communityId: number,
    periodStart: Date,
    periodEnd: Date
  ): Promise<CommunityAllocation> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const community = await this.getCommunity(communityId);
    if (!community) throw new Error('Community not found');

    const members = await this.getCommunityMembers(communityId);
    const activeMembers = members.filter(m => m.status === 'active');

    // Get energy data for all members
    let totalGenerationWh = 0;
    let totalConsumptionWh = 0;
    let totalExportWh = 0;
    let totalImportWh = 0;

    const memberData: Map<number, {
      userName: string;
      contributedCapacityKw: number;
      sharePercentage: number;
      generationWh: number;
      consumptionWh: number;
    }> = new Map();

    for (const member of activeMembers) {
      // Get user name
      const userResult = await db.execute<SqlRow>(sql`SELECT name FROM users WHERE id = ${member.userId}`);
      const userName = userResult.rows[0]?.name || `User ${member.userId}`;

      // Get telemetry data
      const telemetryResult = await db.execute<SqlRow>(sql`
        SELECT 
          SUM(CASE WHEN t.power > 0 THEN t.power * 5 / 60 ELSE 0 END) as generation_wh,
          SUM(CASE WHEN t.power < 0 THEN ABS(t.power) * 5 / 60 ELSE 0 END) as consumption_wh
        FROM telemetry t
        JOIN assets a ON a.id = t."assetId"
        WHERE a."userId" = ${member.userId}
          AND t.timestamp >= ${periodStart}
          AND t.timestamp <= ${periodEnd}
      `);
      const telemetry = telemetryResult.rows[0] || {};

      const generationWh = telemetry.generation_wh || 0;
      const consumptionWh = telemetry.consumption_wh || 0;

      memberData.set(member.userId, {
        userName,
        contributedCapacityKw: member.contributedCapacityKw,
        sharePercentage: (member.sharePercentage || 0) / 100,
        generationWh,
        consumptionWh,
      });

      totalGenerationWh += generationWh;
      totalConsumptionWh += consumptionWh;
    }

    // Calculate net export/import
    if (totalGenerationWh > totalConsumptionWh) {
      totalExportWh = totalGenerationWh - totalConsumptionWh;
    } else {
      totalImportWh = totalConsumptionWh - totalGenerationWh;
    }

    // Calculate financial values from real market prices (throws if unavailable)
    const { exportPrice, importPrice } = await this.getPeriodPrices(periodStart, periodEnd);
    const totalRevenue = Math.round((totalExportWh / 1000) * exportPrice);
    const totalCost = Math.round((totalImportWh / 1000) * importPrice);
    const netValue = totalRevenue - totalCost;

    // Calculate member allocations
    const memberAllocations: MemberAllocation[] = [];

    for (const member of activeMembers) {
      const data = memberData.get(member.userId)!;
      const netEnergyWh = data.generationWh - data.consumptionWh;

      // Allocate based on share percentage and net contribution
      let grossValue: number;
      if (community.allocationMethod === 'proportional_consumption') {
        // Allocate based on consumption share
        const consumptionShare = totalConsumptionWh > 0 
          ? data.consumptionWh / totalConsumptionWh 
          : data.sharePercentage;
        grossValue = Math.round(netValue * consumptionShare);
      } else {
        // Allocate based on capacity share
        grossValue = Math.round(netValue * data.sharePercentage);
      }

      const fees = Math.round(Math.abs(grossValue) * 0.05); // 5% platform fee
      const memberNetValue = grossValue > 0 ? grossValue - fees : grossValue;

      memberAllocations.push({
        userId: member.userId,
        userName: data.userName,
        contributedCapacityKw: data.contributedCapacityKw,
        sharePercentage: data.sharePercentage * 100,
        generationWh: Math.round(data.generationWh),
        consumptionWh: Math.round(data.consumptionWh),
        netEnergyWh: Math.round(netEnergyWh),
        grossValue,
        fees,
        netValue: memberNetValue,
      });
    }

    // Store allocation
    const result = await db.execute<SqlRow>(sql`
      INSERT INTO community_allocations (
        community_id, period_start, period_end,
        total_generation_wh, total_consumption_wh,
        total_export_wh, total_import_wh,
        total_revenue, total_cost, net_value,
        member_allocations, status, created_at
      ) VALUES (
        ${communityId}, ${periodStart}, ${periodEnd},
        ${Math.round(totalGenerationWh)}, ${Math.round(totalConsumptionWh)},
        ${Math.round(totalExportWh)}, ${Math.round(totalImportWh)},
        ${totalRevenue}, ${totalCost}, ${netValue},
        ${JSON.stringify(memberAllocations)}, 'calculated', NOW()
      )
    `);

    console.log(`[CommunityEnergy] Calculated allocation for community ${communityId}: net=${netValue}c`);

    // Publish to Kafka for lakehouse analytics
    try {
      await kafkaPublisher.publishCommunityAllocation({
        communityId: communityId.toString(),
        allocationType: 'period_settlement',
        allocationKwh: (totalGenerationWh - totalConsumptionWh) / 1000,
        fairnessMetric: memberAllocations.length > 0 ? 1.0 : 0,
        timestamp: new Date(),
      });
    } catch (error) {
      console.error('[CommunityEnergy] Error publishing to Kafka:', error);
    }

    return {
      id: Number(result.rows[0].id),
      communityId,
      periodStart,
      periodEnd,
      totalGenerationWh: Math.round(totalGenerationWh),
      totalConsumptionWh: Math.round(totalConsumptionWh),
      totalExportWh: Math.round(totalExportWh),
      totalImportWh: Math.round(totalImportWh),
      totalRevenue,
      totalCost,
      netValue,
      memberAllocations,
      status: 'calculated',
    };
  }

  /**
   * Distribute allocation to members
   */
  async distributeAllocation(allocationId: number): Promise<void> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const allocationResult = await db.execute<SqlRow>(sql`
      SELECT * FROM community_allocations WHERE id = ${allocationId}
    `);
    const allocation = allocationResult.rows[0];
    if (!allocation) throw new Error('Allocation not found');

    const memberAllocations: MemberAllocation[] = JSON.parse(allocation.member_allocations);

    // Create settlement events for each member
    for (const ma of memberAllocations) {
      if (ma.netValue !== 0) {
        await settlementLedger.createEvent({
          eventType: 'compensation_calculated',
          userId: ma.userId,
          sourceType: 'community_allocation',
          sourceId: allocationId,
          energyWh: ma.netEnergyWh,
          grossAmount: ma.grossValue,
          fees: ma.fees,
          netAmount: ma.netValue,
          currency: 'NGN',
          eventData: {
            communityId: allocation.community_id,
            periodStart: allocation.period_start,
            periodEnd: allocation.period_end,
            sharePercentage: ma.sharePercentage,
          },
        });
      }
    }

    // Update allocation status
    await db.execute<SqlRow>(sql`
      UPDATE community_allocations SET status = 'distributed' WHERE id = ${allocationId}
    `);

    console.log(`[CommunityEnergy] Distributed allocation ${allocationId} to ${memberAllocations.length} members`);
  }

  /**
   * Get microgrid status
   */
  async getMicrogridStatus(communityId: number): Promise<MicrogridStatus> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const community = await this.getCommunity(communityId);
    if (!community) throw new Error('Community not found');
    if (!community.canIsland) throw new Error('Community is not microgrid-capable');

    const members = await this.getCommunityMembers(communityId);
    const alerts: string[] = [];

    // Get aggregated telemetry
    let totalGenerationKw = 0;
    let totalLoadKw = 0;
    let batterySOC: number | null = null;
    let batteryCount = 0;
    let totalBatterySOC = 0;

    // Grid quality is reported from real readings only; these stay null when no
    // asset reported them in the window.
    let latestFrequencyHz: number | null = null;
    let latestVoltageV: number | null = null;
    let telemetryRowsSeen = 0;

    for (const member of members.filter(m => m.status === 'active')) {
      const telemetryResult = await db.execute<SqlRow>(sql`
        SELECT a."assetType", t.power, t."stateOfCharge", t.frequency, t.voltage
        FROM telemetry t
        JOIN assets a ON a.id = t."assetId"
        WHERE a."userId" = ${member.userId}
          AND t.timestamp > (NOW() - INTERVAL '5 minute')
        ORDER BY t.timestamp DESC
      `);

      for (const t of telemetryResult.rows || []) {
        telemetryRowsSeen++;
        // Rows arrive newest-first, so the first non-null reading is the latest.
        if (latestFrequencyHz === null && t.frequency != null) {
          latestFrequencyHz = Number(t.frequency) / 1000; // millihertz -> Hz
        }
        if (latestVoltageV === null && t.voltage != null) {
          latestVoltageV = Number(t.voltage) / 1000; // millivolts -> V
        }

        const power = (t.power || 0) / 1000; // Convert to kW
        
        if (t.assetType === 'solar' || t.assetType === 'wind' || t.assetType === 'generator') {
          totalGenerationKw += Math.max(0, power);
        } else if (t.assetType === 'battery') {
          if (power > 0) totalGenerationKw += power;
          else totalLoadKw += Math.abs(power);
          
          if (t.stateOfCharge) {
            totalBatterySOC += t.stateOfCharge / 100;
            batteryCount++;
          }
        } else {
          totalLoadKw += Math.abs(power);
        }
      }
    }

    if (batteryCount > 0) {
      batterySOC = totalBatterySOC / batteryCount;
    }

    // Determine grid connection status
    let gridConnectionStatus: 'connected' | 'disconnected' | 'fault' = 'connected';
    if (community.islandingMode === 'islanded') {
      gridConnectionStatus = 'disconnected';
    }

    // Check for alerts
    if (totalLoadKw > totalGenerationKw * 1.1 && community.islandingMode === 'islanded') {
      alerts.push('Load exceeds generation - battery discharge required');
    }
    if (batterySOC !== null && batterySOC < 20) {
      alerts.push('Battery SOC below 20%');
    }
    if (totalGenerationKw === 0 && community.islandingMode === 'islanded') {
      alerts.push('No generation available in island mode');
    }

    // Estimate autonomy
    let estimatedAutonomyHours: number | null = null;
    if (batterySOC !== null && totalLoadKw > totalGenerationKw) {
      const netDrain = totalLoadKw - totalGenerationKw;
      const batteryCapacityKwh = (community.sharedCapacityKw || 0) * 2; // Assume 2-hour battery
      const availableEnergy = batteryCapacityKwh * (batterySOC / 100);
      estimatedAutonomyHours = netDrain > 0 ? availableEnergy / netDrain : 24;
    }

    // Critical loads check (simplified - assume served if generation + battery > 50% of load)
    const criticalLoadsServed = totalGenerationKw + (batterySOC ? batterySOC / 100 * 10 : 0) > totalLoadKw * 0.5;

    return {
      communityId,
      mode: community.islandingMode,
      gridConnectionStatus,
      totalGenerationKw: Math.round(totalGenerationKw * 100) / 100,
      totalLoadKw: Math.round(totalLoadKw * 100) / 100,
      batterySOC,
      // Real telemetry readings; null (never hardcoded) when none are available
      frequencyHz: latestFrequencyHz,
      voltageV: latestVoltageV,
      criticalLoadsServed,
      estimatedAutonomyHours,
      lastTransition: null, // Would track from state changes
      telemetryAvailable: telemetryRowsSeen > 0,
      alerts,
    };
  }

  /**
   * Resolve real export/import prices (cents/kWh) for an allocation period.
   *
   * Uses the average recorded market price over the period from market_prices
   * (same access path as server/ml/price-prediction.ts). Falls back to the ML
   * price forecast average when no recorded prices exist. Throws when neither
   * source is available — real money shares must never use invented rates.
   */
  private async getPeriodPrices(periodStart: Date, periodEnd: Date): Promise<{ exportPrice: number; importPrice: number }> {
    try {
      const db = await getDb();
      if (db) {
        const rows = await db
          .select({ price: marketPrices.price })
          .from(marketPrices)
          .where(and(gte(marketPrices.timestamp, periodStart), lte(marketPrices.timestamp, periodEnd)));

        if (rows.length > 0) {
          const avgPrice = rows.reduce((sum, r) => sum + r.price, 0) / rows.length;
          console.log(`[CommunityEnergy] Using average market price ${avgPrice.toFixed(2)}c/kWh from ${rows.length} recorded prices`);
          return { exportPrice: avgPrice, importPrice: avgPrice };
        }
      }
    } catch (error) {
      console.warn('[CommunityEnergy] Failed to load market prices, trying ML forecast:', error);
    }

    try {
      const predictions = await pricePredictionService.predictPrices(24);
      if (predictions.length > 0) {
        const avgPrice = predictions.reduce((sum, p) => sum + p.predictedPrice, 0) / predictions.length;
        console.log(`[CommunityEnergy] Using ML forecast average price ${avgPrice.toFixed(2)}c/kWh`);
        return { exportPrice: avgPrice, importPrice: avgPrice };
      }
    } catch (error) {
      console.warn('[CommunityEnergy] ML price forecast unavailable:', error);
    }

    throw new Error('[CommunityEnergy] No market price data or ML price forecast available; cannot calculate allocation values');
  }

  /**
   * Initiate islanding (disconnect from grid)
   */
  async initiateIslanding(communityId: number, reason: string): Promise<{
    success: boolean;
    message: string;
    newMode: string;
    transitionInitiated: boolean;
    reason?: string;
  }> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const community = await this.getCommunity(communityId);
    if (!community) return { success: false, message: 'Community not found', newMode: 'unknown', transitionInitiated: false };
    if (!community.canIsland) return { success: false, message: 'Community cannot island', newMode: community.islandingMode, transitionInitiated: false };

    // Check if safe to island
    const status = await this.getMicrogridStatus(communityId);
    if (status.totalGenerationKw < status.totalLoadKw * 0.5) {
      return {
        success: false,
        message: 'Insufficient generation to support island mode',
        newMode: community.islandingMode,
        transitionInitiated: false,
      };
    }

    // Record the transition request as pending operator confirmation.
    // islanding_mode is NOT changed here: physically disconnecting from the
    // grid requires switchgear actuation that this platform cannot perform or
    // verify. The mode only changes when an operator explicitly confirms the
    // physical transition via confirmModeTransition().
    const pendingTransition = JSON.stringify({
      targetMode: 'islanded',
      status: 'pending_operator_confirmation',
      reason,
      requestedAt: new Date().toISOString(),
    });
    await db.execute<SqlRow>(sql`
      UPDATE energy_communities SET
        metadata = ${jsonSetText(sql`metadata`, { pendingTransition: { json: pendingTransition } })},
        updated_at = NOW()
      WHERE id = ${communityId}
    `);

    console.log(`[CommunityEnergy] Islanding requested for community ${communityId} (pending operator confirmation): ${reason}`);

    return {
      success: true,
      transitionInitiated: false,
      reason: 'physical_switchgear_confirmation_required',
      message: 'Islanding request recorded; islanding_mode will change only after an operator confirms the physical switchgear transition',
      newMode: community.islandingMode,
    };
  }

  /**
   * Operator confirmation for a pending islanding/reconnection transition.
   *
   * This is the ONLY path that changes islanding_mode: it must be called by
   * an operator after the physical switchgear transition has been performed
   * and verified on site. Without a pending request, or with approve=false,
   * the mode is left unchanged.
   */
  async confirmModeTransition(communityId: number, operatorId: number, approve: boolean): Promise<{
    success: boolean;
    message: string;
    newMode: string;
  }> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const result = await db.execute<SqlRow>(sql`
      SELECT islanding_mode, metadata FROM energy_communities WHERE id = ${communityId} LIMIT 1
    `);
    const row = result.rows[0] ?? result.rows;
    if (!row) return { success: false, message: 'Community not found', newMode: 'unknown' };

    let pending: { targetMode?: string; status?: string; reason?: string } | null = null;
    try {
      const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
      pending = metadata?.pendingTransition ?? null;
    } catch {
      pending = null;
    }

    if (!pending || pending.status !== 'pending_operator_confirmation' || !pending.targetMode) {
      return {
        success: false,
        message: 'No pending islanding transition to confirm for this community',
        newMode: row.islanding_mode,
      };
    }

    const confirmedAt = new Date().toISOString();
    if (!approve) {
      await db.execute<SqlRow>(sql`
        UPDATE energy_communities SET
          metadata = ${jsonSetText(sql`metadata`, {
            'pendingTransition.status': 'rejected',
            'pendingTransition.rejectedBy': operatorId,
            'pendingTransition.rejectedAt': confirmedAt,
          })},
          updated_at = NOW()
        WHERE id = ${communityId}
      `);
      console.log(`[CommunityEnergy] Transition to ${pending.targetMode} rejected by operator ${operatorId} for community ${communityId}`);
      return {
        success: true,
        message: `Transition to ${pending.targetMode} rejected; community remains ${row.islanding_mode}`,
        newMode: row.islanding_mode,
      };
    }

    await db.execute<SqlRow>(sql`
      UPDATE energy_communities SET
        islanding_mode = ${pending.targetMode},
        metadata = ${jsonSetText(sql`metadata`, {
          'pendingTransition.status': 'confirmed',
          'pendingTransition.confirmedBy': operatorId,
          'pendingTransition.confirmedAt': confirmedAt,
        })},
        updated_at = NOW()
      WHERE id = ${communityId}
    `);

    console.log(`[CommunityEnergy] Community ${communityId} transitioned to ${pending.targetMode} (confirmed by operator ${operatorId})`);

    return {
      success: true,
      message: `Transition to ${pending.targetMode} confirmed by operator`,
      newMode: pending.targetMode,
    };
  }

  /**
   * Reconnect to grid
   */
  async reconnectToGrid(communityId: number): Promise<{
    success: boolean;
    message: string;
    newMode: string;
    transitionInitiated: boolean;
    reason?: string;
  }> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const community = await this.getCommunity(communityId);
    if (!community) return { success: false, message: 'Community not found', newMode: 'unknown', transitionInitiated: false };

    if (community.islandingMode !== 'islanded') {
      return { success: false, message: 'Community is not in island mode', newMode: community.islandingMode, transitionInitiated: false };
    }

    // Record the reconnection request as pending operator confirmation.
    // Reconnecting to the grid requires physical synchronization
    // (frequency/voltage match at the point of interconnection) that this
    // platform cannot perform or verify. islanding_mode only changes when an
    // operator confirms via confirmModeTransition().
    const pendingTransition = JSON.stringify({
      targetMode: 'grid_tied',
      status: 'pending_operator_confirmation',
      reason: 'grid_reconnection_requested',
      requestedAt: new Date().toISOString(),
    });
    await db.execute<SqlRow>(sql`
      UPDATE energy_communities SET
        metadata = ${jsonSetText(sql`metadata`, { pendingTransition: { json: pendingTransition } })},
        updated_at = NOW()
      WHERE id = ${communityId}
    `);

    console.log(`[CommunityEnergy] Grid reconnection requested for community ${communityId} (pending operator confirmation)`);

    return {
      success: true,
      transitionInitiated: false,
      reason: 'physical_switchgear_confirmation_required',
      message: 'Reconnection request recorded; islanding_mode will change only after an operator confirms physical synchronization with the grid',
      newMode: community.islandingMode,
    };
  }

  /**
   * Get user's communities
   */
  async getUserCommunities(userId: number): Promise<Array<EnergyCommunity & { membership: CommunityMember }>> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const result = await db.execute<SqlRow>(sql`
      SELECT ec.*, cm.id as member_id, cm.role, cm.joined_at, cm.contributed_capacity_kw,
             cm.share_percentage, cm.auto_participate, cm.priority_level, cm.status as member_status
      FROM energy_communities ec
      JOIN community_members cm ON cm.community_id = ec.id
      WHERE cm.user_id = ${userId} AND cm.status IN ('pending', 'active')
    `);

    return (result.rows || []).map((row: any) => ({
      ...this.mapRowToCommunity(row),
      membership: {
        id: row.member_id,
        communityId: row.id,
        userId,
        role: row.role,
        joinedAt: row.joined_at,
        contributedCapacityKw: row.contributed_capacity_kw,
        sharePercentage: row.share_percentage,
        autoParticipate: row.auto_participate,
        priorityLevel: row.priority_level,
        status: row.member_status,
      },
    }));
  }

  private mapRowToCommunity(row: any): EnergyCommunity {
    return {
      id: row.id,
      communityCode: row.community_code,
      name: row.name,
      description: row.description,
      communityType: row.community_type,
      region: row.region,
      gridConnectionPoint: row.grid_connection_point,
      governanceModel: row.governance_model,
      hasSharedBattery: row.has_shared_battery,
      hasSharedSolar: row.has_shared_solar,
      sharedCapacityKw: row.shared_capacity_kw,
      canIsland: row.can_island,
      islandingMode: row.islanding_mode,
      allocationMethod: row.allocation_method,
      status: row.status,
    };
  }

  private mapRowToMember(row: any): CommunityMember {
    return {
      id: row.id,
      communityId: row.community_id,
      userId: row.user_id,
      role: row.role,
      joinedAt: row.joined_at,
      contributedCapacityKw: row.contributed_capacity_kw,
      sharePercentage: row.share_percentage,
      autoParticipate: row.auto_participate,
      priorityLevel: row.priority_level,
      status: row.status,
    };
  }
}

// Singleton instance
export const communityEnergy = new CommunityEnergyService();
