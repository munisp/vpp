/**
 * EV Charging and V2G Service
 * 
 * Manages electric vehicle charging, smart charging optimization,
 * and Vehicle-to-Grid (V2G) / Vehicle-to-Home (V2H) capabilities.
 */

import { getDb } from '../db';
import { sql, and, gte, lte, asc } from 'drizzle-orm';
import { createHash } from 'crypto';
import { optimizationEngine } from './optimization-engine';
import { settlementLedger } from './settlement-ledger';
import { kafkaPublisher } from '../integration/kafka-publisher';
import { marketPrices } from '../../drizzle/schema';
import { pricePredictionService } from '../ml/price-prediction';

// Types for EV charging
export interface ElectricVehicle {
  id: number;
  userId: number;
  vin: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  batteryCapacityKwh: number | null;
  usableBatteryKwh: number | null;
  maxChargingPowerKw: number | null;
  maxDischargingPowerKw: number | null;
  v2gCapable: boolean;
  v2hCapable: boolean;
  bidirectionalProtocol: 'none' | 'chademo' | 'ccs_v2g' | 'iso15118';
  currentSocPercent: number | null;
  lastKnownLocation: string | null;
  isPluggedIn: boolean;
  isCharging: boolean;
  minSocPercent: number;
  targetSocPercent: number;
  status: 'active' | 'inactive' | 'maintenance';
}

export interface ChargingStation {
  id: number;
  userId: number | null;
  siteId: number | null;
  stationId: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  connectorType: string;
  maxPowerKw: number;
  v2gCapable: boolean;
  ocppVersion: string | null;
  ocppEndpoint: string | null;
  status: 'available' | 'occupied' | 'charging' | 'discharging' | 'faulted' | 'offline';
  lastHeartbeat: Date | null;
}

export interface ChargingSession {
  id: number;
  evId: number;
  stationId: number;
  userId: number;
  sessionId: string;
  startTime: Date;
  endTime: Date | null;
  startSocPercent: number | null;
  endSocPercent: number | null;
  energyDeliveredWh: number;
  energyExportedWh: number;
  maxPowerKw: number | null;
  avgPowerKw: number | null;
  sessionType: 'standard_charge' | 'smart_charge' | 'v2g' | 'v2h';
  targetSocPercent: number | null;
  departureTime: Date | null;
  totalCost: number | null;
  totalRevenue: number | null;
  status: 'starting' | 'charging' | 'discharging' | 'paused' | 'completed' | 'failed';
}

export interface SmartChargingSchedule {
  sessionId: string;
  intervals: Array<{
    startTime: Date;
    endTime: Date;
    powerKw: number; // Positive = charging, negative = discharging (V2G)
    expectedCost: number;
    expectedRevenue: number;
  }>;
  totalEnergykWh: number;
  totalCost: number;
  totalRevenue: number;
  estimatedCompletionTime: Date;
  optimizationObjective: string;
}

export class EVChargingService {
  
  /**
   * Register a new electric vehicle
   */
  async registerEV(
    userId: number,
    ev: {
      vin?: string;
      make?: string;
      model?: string;
      year?: number;
      batteryCapacityKwh?: number;
      usableBatteryKwh?: number;
      maxChargingPowerKw?: number;
      maxDischargingPowerKw?: number;
      v2gCapable?: boolean;
      v2hCapable?: boolean;
      bidirectionalProtocol?: 'none' | 'chademo' | 'ccs_v2g' | 'iso15118';
    }
  ): Promise<ElectricVehicle> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const result = await db.execute(sql`
      INSERT INTO electric_vehicles (
        user_id, vin, make, model, year,
        battery_capacity_kwh, usable_battery_kwh,
        max_charging_power_kw, max_discharging_power_kw,
        v2g_capable, v2h_capable, bidirectional_protocol,
        min_soc_percent, target_soc_percent, status,
        created_at, updated_at
      ) VALUES (
        ${userId}, ${ev.vin || null}, ${ev.make || null}, ${ev.model || null}, ${ev.year || null},
        ${ev.batteryCapacityKwh ? ev.batteryCapacityKwh * 10 : null},
        ${ev.usableBatteryKwh ? ev.usableBatteryKwh * 10 : null},
        ${ev.maxChargingPowerKw ? ev.maxChargingPowerKw * 10 : null},
        ${ev.maxDischargingPowerKw ? ev.maxDischargingPowerKw * 10 : null},
        ${ev.v2gCapable || false}, ${ev.v2hCapable || false},
        ${ev.bidirectionalProtocol || 'none'},
        2000, 8000, 'active', NOW(), NOW()
      )
    `);

    console.log(`[EVCharging] Registered EV for user ${userId}`);

    return this.getEV((result as any).insertId) as Promise<ElectricVehicle>;
  }

  /**
   * Get EV by ID
   */
  async getEV(evId: number): Promise<ElectricVehicle | null> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const result = await db.execute(sql`
      SELECT * FROM electric_vehicles WHERE id = ${evId}
    `);

    const row = (result as any)[0]?.[0];
    return row ? this.mapRowToEV(row) : null;
  }

  /**
   * Get user's EVs
   */
  async getUserEVs(userId: number): Promise<ElectricVehicle[]> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const result = await db.execute(sql`
      SELECT * FROM electric_vehicles WHERE user_id = ${userId} AND status = 'active'
    `);

    return ((result as any)[0] || []).map(this.mapRowToEV);
  }

  /**
   * Register a charging station
   */
  async registerStation(
    station: {
      userId?: number;
      siteId?: number;
      name: string;
      connectorType: 'type1' | 'type2' | 'chademo' | 'ccs1' | 'ccs2' | 'tesla';
      maxPowerKw: number;
      v2gCapable?: boolean;
      latitude?: number;
      longitude?: number;
      address?: string;
      ocppVersion?: '1.6' | '2.0' | '2.0.1';
      ocppEndpoint?: string;
    }
  ): Promise<ChargingStation> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const stationId = `EVSE_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;

    const result = await db.execute(sql`
      INSERT INTO charging_stations (
        user_id, site_id, station_id, name,
        latitude, longitude, address,
        connector_type, max_power_kw, v2g_capable,
        ocpp_version, ocpp_endpoint, status,
        created_at, updated_at
      ) VALUES (
        ${station.userId || null}, ${station.siteId || null}, ${stationId}, ${station.name},
        ${station.latitude || null}, ${station.longitude || null}, ${station.address || null},
        ${station.connectorType}, ${station.maxPowerKw * 10}, ${station.v2gCapable || false},
        ${station.ocppVersion || null}, ${station.ocppEndpoint || null}, 'offline',
        NOW(), NOW()
      )
    `);

    console.log(`[EVCharging] Registered station ${stationId}`);

    return this.getStation((result as any).insertId) as Promise<ChargingStation>;
  }

  /**
   * Get station by ID
   */
  async getStation(stationId: number | string): Promise<ChargingStation | null> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    let query;
    if (typeof stationId === 'number') {
      query = sql`SELECT * FROM charging_stations WHERE id = ${stationId}`;
    } else {
      query = sql`SELECT * FROM charging_stations WHERE station_id = ${stationId}`;
    }

    const result = await db.execute(query);
    const row = (result as any)[0]?.[0];
    return row ? this.mapRowToStation(row) : null;
  }

  /**
   * Start a charging session
   */
  async startSession(
    evId: number,
    stationId: number,
    options: {
      sessionType?: 'standard_charge' | 'smart_charge' | 'v2g' | 'v2h';
      targetSocPercent?: number;
      departureTime?: Date;
      maxPowerKw?: number;
    } = {}
  ): Promise<ChargingSession> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Get EV and station info
    const ev = await this.getEV(evId);
    if (!ev) throw new Error('EV not found');

    const station = await this.getStation(stationId);
    if (!station) throw new Error('Station not found');

    // Validate V2G capability
    if ((options.sessionType === 'v2g' || options.sessionType === 'v2h') && 
        (!ev.v2gCapable || !station.v2gCapable)) {
      throw new Error('V2G not supported by EV or station');
    }

    const sessionId = `CS_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;

    const result = await db.execute(sql`
      INSERT INTO charging_sessions (
        ev_id, station_id, user_id, session_id,
        start_time, start_soc_percent, session_type,
        target_soc_percent, departure_time, max_power_kw,
        energy_delivered_wh, energy_exported_wh, status,
        created_at, updated_at
      ) VALUES (
        ${evId}, ${stationId}, ${ev.userId}, ${sessionId},
        NOW(), ${ev.currentSocPercent || null}, ${options.sessionType || 'standard_charge'},
        ${options.targetSocPercent || ev.targetSocPercent}, ${options.departureTime || null},
        ${options.maxPowerKw ? options.maxPowerKw * 10 : null},
        0, 0, 'starting', NOW(), NOW()
      )
    `);

    // Update EV and station status
    await db.execute(sql`
      UPDATE electric_vehicles SET is_plugged_in = true, is_charging = true, updated_at = NOW()
      WHERE id = ${evId}
    `);

    await db.execute(sql`
      UPDATE charging_stations SET status = 'charging', updated_at = NOW()
      WHERE id = ${stationId}
    `);

    console.log(`[EVCharging] Started session ${sessionId} for EV ${evId}`);

    // Publish to Kafka for lakehouse analytics
    try {
      await kafkaPublisher.publishEVSession({
        sessionId,
        chargerId: station.stationId,
        userId: ev.userId.toString(),
        vehicleId: ev.id.toString(),
        sessionType: options.sessionType === 'v2g' || options.sessionType === 'v2h' ? 'v2g' : 'charging',
        startTime: new Date(),
        socStart: ev.currentSocPercent || undefined,
        timestamp: new Date(),
      });
    } catch (error) {
      console.error('[EVCharging] Error publishing to Kafka:', error);
    }

    return this.getSession((result as any).insertId) as Promise<ChargingSession>;
  }

  /**
   * Get session by ID
   */
  async getSession(sessionId: number | string): Promise<ChargingSession | null> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    let query;
    if (typeof sessionId === 'number') {
      query = sql`SELECT * FROM charging_sessions WHERE id = ${sessionId}`;
    } else {
      query = sql`SELECT * FROM charging_sessions WHERE session_id = ${sessionId}`;
    }

    const result = await db.execute(query);
    const row = (result as any)[0]?.[0];
    return row ? this.mapRowToSession(row) : null;
  }

  /**
   * Update session with energy data
   */
  async updateSessionEnergy(
    sessionId: string,
    update: {
      energyDeliveredWh?: number;
      energyExportedWh?: number;
      currentSocPercent?: number;
      currentPowerKw?: number;
    }
  ): Promise<void> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    await db.execute(sql`
      UPDATE charging_sessions SET
        energy_delivered_wh = COALESCE(${update.energyDeliveredWh || null}, energy_delivered_wh),
        energy_exported_wh = COALESCE(${update.energyExportedWh || null}, energy_exported_wh),
        metadata = JSON_SET(
          COALESCE(metadata, '{}'),
          '$.currentSocPercent', ${update.currentSocPercent || null},
          '$.currentPowerKw', ${update.currentPowerKw || null}
        ),
        updated_at = NOW()
      WHERE session_id = ${sessionId}
    `);

    // Update EV SoC
    if (update.currentSocPercent !== undefined) {
      const session = await this.getSession(sessionId);
      if (session) {
        await db.execute(sql`
          UPDATE electric_vehicles SET
            current_soc_percent = ${update.currentSocPercent * 100},
            updated_at = NOW()
          WHERE id = ${session.evId}
        `);
      }
    }
  }

  /**
   * End a charging session
   */
  async endSession(
    sessionId: string,
    endData: {
      endSocPercent?: number;
      totalCost?: number;
      totalRevenue?: number;
    } = {}
  ): Promise<ChargingSession> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const session = await this.getSession(sessionId);
    if (!session) throw new Error('Session not found');

    await db.execute(sql`
      UPDATE charging_sessions SET
        end_time = NOW(),
        end_soc_percent = ${endData.endSocPercent || null},
        total_cost = ${endData.totalCost || null},
        total_revenue = ${endData.totalRevenue || null},
        status = 'completed',
        updated_at = NOW()
      WHERE session_id = ${sessionId}
    `);

    // Update EV status
    await db.execute(sql`
      UPDATE electric_vehicles SET
        is_charging = false,
        current_soc_percent = ${endData.endSocPercent ? endData.endSocPercent * 100 : null},
        updated_at = NOW()
      WHERE id = ${session.evId}
    `);

    // Update station status
    await db.execute(sql`
      UPDATE charging_stations SET status = 'available', updated_at = NOW()
      WHERE id = ${session.stationId}
    `);

    // Record settlement event for V2G sessions
    if (session.sessionType === 'v2g' && session.energyExportedWh > 0) {
      const ev = await this.getEV(session.evId);
      if (ev) {
        await settlementLedger.createEvent({
          eventType: 'service_delivered',
          userId: ev.userId,
          sourceType: 'charging_session',
          sourceId: session.id,
          energyWh: -session.energyExportedWh, // Negative for export
          grossAmount: endData.totalRevenue || 0,
          fees: Math.round((endData.totalRevenue || 0) * 0.05),
          netAmount: Math.round((endData.totalRevenue || 0) * 0.95),
          currency: 'NGN',
          eventData: {
            sessionType: 'v2g',
            sessionId,
            stationId: session.stationId,
          },
        });
      }
    }

    console.log(`[EVCharging] Ended session ${sessionId}`);

    return this.getSession(sessionId) as Promise<ChargingSession>;
  }

  /**
   * Create smart charging schedule
   */
  async createSmartChargingSchedule(
    sessionId: string,
    options: {
      objective?: 'minimize_cost' | 'maximize_revenue' | 'minimize_emissions' | 'fastest';
      constraints?: {
        maxPowerKw?: number;
        minSocPercent?: number;
        mustCompleteBy?: Date;
      };
    } = {}
  ): Promise<SmartChargingSchedule> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const session = await this.getSession(sessionId);
    if (!session) throw new Error('Session not found');

    const ev = await this.getEV(session.evId);
    if (!ev) throw new Error('EV not found');

    const station = await this.getStation(session.stationId);
    if (!station) throw new Error('Station not found');

    // Calculate energy needed
    const currentSoc = ev.currentSocPercent || 20;
    const targetSoc = session.targetSocPercent || ev.targetSocPercent;
    const batteryCapacity = (ev.usableBatteryKwh || ev.batteryCapacityKwh || 60) / 10; // Convert from stored format
    const energyNeededKwh = ((targetSoc - currentSoc) / 100) * batteryCapacity;

    // Determine charging window
    const now = new Date();
    const deadline = session.departureTime || options.constraints?.mustCompleteBy || 
                     new Date(now.getTime() + 8 * 3600000); // Default 8 hours

    const maxPower = Math.min(
      (ev.maxChargingPowerKw || 110) / 10,
      station.maxPowerKw / 10,
      options.constraints?.maxPowerKw || Infinity
    );

    // Generate schedule based on objective
    const intervals: SmartChargingSchedule['intervals'] = [];
    let totalCost = 0;
    let totalRevenue = 0;
    let remainingEnergy = energyNeededKwh;

    const intervalMinutes = 15;
    const intervalsCount = Math.ceil((deadline.getTime() - now.getTime()) / (intervalMinutes * 60000));

    // Get real price forecast for scheduling (throws if no price source available)
    const pricePattern = await this.getPricePattern(now, intervalsCount, intervalMinutes);

    if (options.objective === 'fastest') {
      // Charge at max power until complete
      let currentTime = now;
      while (remainingEnergy > 0 && currentTime < deadline) {
        const intervalEnd = new Date(currentTime.getTime() + intervalMinutes * 60000);
        const energyThisInterval = Math.min(remainingEnergy, (maxPower * intervalMinutes) / 60);
        const price = pricePattern[intervals.length] ?? pricePattern[pricePattern.length - 1];
        const cost = Math.round(energyThisInterval * price);

        intervals.push({
          startTime: currentTime,
          endTime: intervalEnd,
          powerKw: maxPower,
          expectedCost: cost,
          expectedRevenue: 0,
        });

        totalCost += cost;
        remainingEnergy -= energyThisInterval;
        currentTime = intervalEnd;
      }
    } else {
      // Sort intervals by price for cost optimization
      const sortedIntervals = pricePattern
        .map((price, index) => ({ index, price }))
        .sort((a, b) => {
          if (options.objective === 'maximize_revenue') {
            return b.price - a.price; // High price first for V2G
          }
          return a.price - b.price; // Low price first for charging
        });

      // Schedule charging in cheapest intervals
      for (const { index, price } of sortedIntervals) {
        if (remainingEnergy <= 0) break;

        const intervalStart = new Date(now.getTime() + index * intervalMinutes * 60000);
        if (intervalStart >= deadline) continue;

        const intervalEnd = new Date(intervalStart.getTime() + intervalMinutes * 60000);
        const energyThisInterval = Math.min(remainingEnergy, (maxPower * intervalMinutes) / 60);
        const cost = Math.round(energyThisInterval * price);

        intervals.push({
          startTime: intervalStart,
          endTime: intervalEnd,
          powerKw: maxPower,
          expectedCost: cost,
          expectedRevenue: 0,
        });

        totalCost += cost;
        remainingEnergy -= energyThisInterval;
      }

      // Sort intervals by time for execution
      intervals.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    }

    // Add V2G intervals if capable and objective is maximize_revenue
    if (options.objective === 'maximize_revenue' && ev.v2gCapable && station.v2gCapable) {
      // Discharge only in genuinely high-price intervals (top quartile of the
      // real price pattern for this scheduling window)
      const sortedPrices = [...pricePattern].sort((a, b) => a - b);
      const highPriceThreshold = sortedPrices[Math.floor((sortedPrices.length - 1) * 0.75)];
      const maxDischarge = (ev.maxDischargingPowerKw || 0) / 10;
      const minSoc = options.constraints?.minSocPercent || ev.minSocPercent;

      for (let i = 0; i < intervalsCount; i++) {
        const price = pricePattern[i];
        if (price > highPriceThreshold && maxDischarge > 0) {
          const intervalStart = new Date(now.getTime() + i * intervalMinutes * 60000);
          const intervalEnd = new Date(intervalStart.getTime() + intervalMinutes * 60000);
          
          // Check if not already scheduled for charging
          const existingInterval = intervals.find(
            int => int.startTime.getTime() === intervalStart.getTime()
          );
          
          if (!existingInterval) {
            const energyExport = (maxDischarge * intervalMinutes) / 60;
            const revenue = Math.round(energyExport * price);

            intervals.push({
              startTime: intervalStart,
              endTime: intervalEnd,
              powerKw: -maxDischarge, // Negative for discharge
              expectedCost: 0,
              expectedRevenue: revenue,
            });

            totalRevenue += revenue;
          }
        }
      }

      // Re-sort by time
      intervals.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    }

    const estimatedCompletionTime = intervals.length > 0 
      ? intervals[intervals.length - 1].endTime 
      : deadline;

    console.log(`[EVCharging] Created smart schedule for ${sessionId}: ${intervals.length} intervals, cost=${totalCost}c, revenue=${totalRevenue}c`);

    return {
      sessionId,
      intervals,
      totalEnergykWh: energyNeededKwh,
      totalCost,
      totalRevenue,
      estimatedCompletionTime,
      optimizationObjective: options.objective || 'minimize_cost',
    };
  }

  /**
   * Get price pattern for scheduling.
   *
   * Sources real market prices from the market_prices table (same access path
   * as server/ml/price-prediction.ts). Falls back to the ML price forecast.
   * Throws when neither source is available — no invented rates are ever used
   * in user-facing cost/revenue economics.
   */
  private async getPricePattern(startTime: Date, intervalsCount: number, intervalMinutes: number = 15): Promise<number[]> {
    const intervalMs = intervalMinutes * 60000;

    // 1) Real market prices from the database
    try {
      const db = await getDb();
      if (db) {
        const endTime = new Date(startTime.getTime() + intervalsCount * intervalMs);
        const rows = await db
          .select()
          .from(marketPrices)
          .where(and(gte(marketPrices.timestamp, startTime), lte(marketPrices.timestamp, endTime)))
          .orderBy(asc(marketPrices.timestamp));

        if (rows.length > 0) {
          // Bucket real prices into scheduling intervals
          const pattern: (number | null)[] = new Array(intervalsCount).fill(null);
          for (const row of rows) {
            const idx = Math.floor((new Date(row.timestamp).getTime() - startTime.getTime()) / intervalMs);
            if (idx >= 0 && idx < intervalsCount) pattern[idx] = row.price;
          }
          // Fill gaps by carrying the nearest real price (forward, then backward)
          let last: number | null = null;
          for (let i = 0; i < intervalsCount; i++) {
            if (pattern[i] !== null) last = pattern[i];
            else if (last !== null) pattern[i] = last;
          }
          let next: number | null = null;
          for (let i = intervalsCount - 1; i >= 0; i--) {
            if (pattern[i] !== null) next = pattern[i];
            else if (next !== null) pattern[i] = next;
          }
          if (pattern.every(p => p !== null)) {
            console.log(`[EVCharging] Using ${rows.length} real market prices for scheduling`);
            return pattern as number[];
          }
        }
      }
    } catch (error) {
      console.warn('[EVCharging] Failed to load market prices, trying ML forecast:', error);
    }

    // 2) Fallback: ML price prediction service forecast
    try {
      const hoursNeeded = Math.max(1, Math.ceil((intervalsCount * intervalMinutes) / 60));
      const predictions = await pricePredictionService.predictPrices(hoursNeeded);
      if (predictions.length > 0) {
        console.log(`[EVCharging] Using ML price forecast (${predictions.length}h) for scheduling`);
        const pattern: number[] = [];
        for (let i = 0; i < intervalsCount; i++) {
          const hourIdx = Math.min(Math.floor((i * intervalMinutes) / 60), predictions.length - 1);
          pattern.push(predictions[hourIdx].predictedPrice);
        }
        return pattern;
      }
    } catch (error) {
      console.warn('[EVCharging] ML price forecast unavailable:', error);
    }

    // 3) Fail loudly — never invent rates for user-facing economics
    throw new Error('[EVCharging] No market price data or ML price forecast available; cannot compute smart-charging economics');
  }

  /**
   * Get V2G availability for grid services
   */
  async getV2GAvailability(
    scope: { userId?: number; communityId?: number }
  ): Promise<{
    totalCapacityKw: number;
    availableCapacityKw: number;
    vehicleCount: number;
    availableVehicles: number;
    estimatedEnergyKwh: number;
  }> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    let query;
    if (scope.userId) {
      query = sql`
        SELECT ev.*, cs.v2g_capable as station_v2g
        FROM electric_vehicles ev
        LEFT JOIN charging_sessions cs_active ON cs_active.ev_id = ev.id AND cs_active.status IN ('charging', 'paused')
        LEFT JOIN charging_stations cs ON cs.id = cs_active.station_id
        WHERE ev.user_id = ${scope.userId}
          AND ev.status = 'active'
          AND ev.v2g_capable = true
      `;
    } else if (scope.communityId) {
      query = sql`
        SELECT ev.*, cs.v2g_capable as station_v2g
        FROM electric_vehicles ev
        JOIN community_members cm ON cm.user_id = ev.user_id
        LEFT JOIN charging_sessions cs_active ON cs_active.ev_id = ev.id AND cs_active.status IN ('charging', 'paused')
        LEFT JOIN charging_stations cs ON cs.id = cs_active.station_id
        WHERE cm.community_id = ${scope.communityId}
          AND cm.status = 'active'
          AND ev.status = 'active'
          AND ev.v2g_capable = true
      `;
    } else {
      throw new Error('Must specify userId or communityId');
    }

    const result = await db.execute(query);
    const vehicles = (result as any)[0] || [];

    let totalCapacityKw = 0;
    let availableCapacityKw = 0;
    let availableVehicles = 0;
    let estimatedEnergyKwh = 0;

    for (const v of vehicles) {
      const maxDischarge = (v.max_discharging_power_kw || 0) / 10;
      totalCapacityKw += maxDischarge;

      // Check if available for V2G
      const isPluggedIn = v.is_plugged_in;
      const hasV2GStation = v.station_v2g;
      const currentSoc = (v.current_soc_percent || 0) / 100;
      const minSoc = (v.min_soc_percent || 2000) / 100;

      if (isPluggedIn && hasV2GStation && currentSoc > minSoc) {
        availableCapacityKw += maxDischarge;
        availableVehicles++;

        // Estimate available energy (down to min SoC)
        const batteryCapacity = (v.usable_battery_kwh || v.battery_capacity_kwh || 600) / 10;
        const availableEnergy = ((currentSoc - minSoc) / 100) * batteryCapacity;
        estimatedEnergyKwh += availableEnergy;
      }
    }

    return {
      totalCapacityKw,
      availableCapacityKw,
      vehicleCount: vehicles.length,
      availableVehicles,
      estimatedEnergyKwh,
    };
  }

  /**
   * Dispatch V2G command to vehicle
   */
  async dispatchV2G(
    evId: number,
    command: {
      action: 'start_discharge' | 'stop_discharge' | 'set_power';
      powerKw?: number;
      durationMinutes?: number;
      minSocPercent?: number;
    }
  ): Promise<{ success: boolean; message: string }> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const ev = await this.getEV(evId);
    if (!ev) return { success: false, message: 'EV not found' };
    if (!ev.v2gCapable) return { success: false, message: 'EV not V2G capable' };
    if (!ev.isPluggedIn) return { success: false, message: 'EV not plugged in' };

    // Get active session
    const sessionResult = await db.execute(sql`
      SELECT * FROM charging_sessions
      WHERE ev_id = ${evId} AND status IN ('charging', 'paused', 'discharging')
      ORDER BY start_time DESC LIMIT 1
    `);
    const session = (sessionResult as any)[0]?.[0];
    if (!session) return { success: false, message: 'No active session' };

    // Check SoC constraints
    const currentSoc = ev.currentSocPercent || 50;
    const minSoc = command.minSocPercent || ev.minSocPercent;
    if (command.action === 'start_discharge' && currentSoc <= minSoc) {
      return { success: false, message: `SoC (${currentSoc}%) at or below minimum (${minSoc}%)` };
    }

    // Update session status
    const newStatus = command.action === 'start_discharge' ? 'discharging' : 
                      command.action === 'stop_discharge' ? 'paused' : session.status;

    await db.execute(sql`
      UPDATE charging_sessions SET
        status = ${newStatus},
        session_type = 'v2g',
        metadata = JSON_SET(
          COALESCE(metadata, '{}'),
          '$.v2gCommand', ${command.action},
          '$.v2gPowerKw', ${command.powerKw || null},
          '$.v2gStartTime', ${new Date().toISOString()}
        ),
        updated_at = NOW()
      WHERE id = ${session.id}
    `);

    // Update station status
    await db.execute(sql`
      UPDATE charging_stations SET
        status = ${command.action === 'start_discharge' ? 'discharging' : 'occupied'},
        updated_at = NOW()
      WHERE id = ${session.station_id}
    `);

    console.log(`[EVCharging] V2G ${command.action} dispatched to EV ${evId}`);

    return { success: true, message: `V2G ${command.action} initiated` };
  }

  private mapRowToEV(row: any): ElectricVehicle {
    return {
      id: row.id,
      userId: row.user_id,
      vin: row.vin,
      make: row.make,
      model: row.model,
      year: row.year,
      batteryCapacityKwh: row.battery_capacity_kwh,
      usableBatteryKwh: row.usable_battery_kwh,
      maxChargingPowerKw: row.max_charging_power_kw,
      maxDischargingPowerKw: row.max_discharging_power_kw,
      v2gCapable: row.v2g_capable,
      v2hCapable: row.v2h_capable,
      bidirectionalProtocol: row.bidirectional_protocol,
      currentSocPercent: row.current_soc_percent,
      lastKnownLocation: row.last_known_location,
      isPluggedIn: row.is_plugged_in,
      isCharging: row.is_charging,
      minSocPercent: row.min_soc_percent / 100,
      targetSocPercent: row.target_soc_percent / 100,
      status: row.status,
    };
  }

  private mapRowToStation(row: any): ChargingStation {
    return {
      id: row.id,
      userId: row.user_id,
      siteId: row.site_id,
      stationId: row.station_id,
      name: row.name,
      latitude: row.latitude ? parseFloat(row.latitude) : null,
      longitude: row.longitude ? parseFloat(row.longitude) : null,
      address: row.address,
      connectorType: row.connector_type,
      maxPowerKw: row.max_power_kw / 10,
      v2gCapable: row.v2g_capable,
      ocppVersion: row.ocpp_version,
      ocppEndpoint: row.ocpp_endpoint,
      status: row.status,
      lastHeartbeat: row.last_heartbeat,
    };
  }

  private mapRowToSession(row: any): ChargingSession {
    return {
      id: row.id,
      evId: row.ev_id,
      stationId: row.station_id,
      userId: row.user_id,
      sessionId: row.session_id,
      startTime: row.start_time,
      endTime: row.end_time,
      startSocPercent: row.start_soc_percent,
      endSocPercent: row.end_soc_percent,
      energyDeliveredWh: row.energy_delivered_wh,
      energyExportedWh: row.energy_exported_wh,
      maxPowerKw: row.max_power_kw ? row.max_power_kw / 10 : null,
      avgPowerKw: row.avg_power_kw ? row.avg_power_kw / 10 : null,
      sessionType: row.session_type,
      targetSocPercent: row.target_soc_percent,
      departureTime: row.departure_time,
      totalCost: row.total_cost,
      totalRevenue: row.total_revenue,
      status: row.status,
    };
  }
}

// Singleton instance
export const evCharging = new EVChargingService();
