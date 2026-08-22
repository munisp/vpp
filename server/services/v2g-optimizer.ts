/**
 * V2G Departure-Aware Charging Optimizer
 *
 * Builds on the existing EV charging service (server/services/ev-charging.ts,
 * imported but not modified) to compute a departure-aware charge/discharge
 * plan for a plugged-in vehicle.
 *
 * Economics come exclusively from REAL price data:
 *   1. Recorded market_prices rows covering the plugged-in window, or
 *   2. The ML price forecast (server/ml/price-prediction.ts predictPrices),
 *      which honestly returns [] when the model has never been trained.
 * When neither source has data, the service returns
 * { scheduleAvailable: false, reason } — it never invents rates.
 *
 * Both the optimized expectedCost and the naive baseline cost are computed
 * from the SAME price series so the comparison is apples-to-apples.
 */

import { getDb } from '../db';
import { sql, and, desc, eq, gte, lte, asc } from 'drizzle-orm';
import { marketPrices } from '../../drizzle/schema';
import { v2gSchedules } from '../../drizzle/grid-intel-schema';
import { pricePredictionService } from '../ml/price-prediction';
import { evCharging } from './ev-charging';
import type { SqlRow } from '../sql-row';

export interface ScheduleInterval {
  startTime: Date;
  endTime: Date;
  powerKw: number; // positive = charge, negative = V2G discharge
  priceCentsPerKwh: number;
  costCents: number;
  revenueCents: number;
  socAfterPercent: number;
}

export interface V2gPlanResult {
  scheduleAvailable: boolean;
  reason?: string;
  scheduleId?: number;
  priceSource?: 'market_prices' | 'ml_forecast';
  intervals?: ScheduleInterval[];
  energyToChargeKwh?: number;
  expectedCostCents?: number;
  naiveBaselineCostCents?: number;
  expectedRevenueCents?: number;
  expectedSavingsCents?: number;
  departureTime?: Date;
  targetSocPercent?: number;
  maxReachableSocPercent?: number;
}

interface HourSlot {
  index: number;
  startTime: Date;
  endTime: Date;
  price: number; // cents/kWh (real series)
  chargeKwh: number;
  dischargeKwh: number;
}

export class V2gOptimizerService {
  /**
   * Compute and persist a departure-aware schedule.
   */
  async planSchedule(
    userId: number,
    input: {
      evId: number;
      departureTime: Date;
      targetSocPercent: number;
      minSocReservePercent?: number;
      allowV2g?: boolean;
      batteryCapacityKwh?: number; // override; otherwise from EV record
      startSocPercent?: number; // override; otherwise from EV record
      maxChargeKw?: number;
      maxDischargeKw?: number;
    }
  ): Promise<V2gPlanResult> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const ev = await evCharging.getEV(input.evId);
    if (!ev) throw new Error('EV not found');
    if (ev.userId !== userId) throw new Error('EV does not belong to this user');

    // Vehicle parameters — real record or explicit input; fail loud if unknown
    const batteryCapacityKwh = input.batteryCapacityKwh
      ?? ((ev.usableBatteryKwh || ev.batteryCapacityKwh) ? (ev.usableBatteryKwh || ev.batteryCapacityKwh)! / 10 : null);
    if (!batteryCapacityKwh || batteryCapacityKwh <= 0) {
      throw new Error('Vehicle battery capacity unknown: provide batteryCapacityKwh or update the EV record');
    }
    const startSoc = input.startSocPercent
      ?? (ev.currentSocPercent !== null ? ev.currentSocPercent / 100 : null);
    if (startSoc === null) {
      throw new Error('Current state of charge unknown: provide startSocPercent or update the EV record');
    }
    const maxChargeKw = input.maxChargeKw ?? (ev.maxChargingPowerKw ? ev.maxChargingPowerKw / 10 : null);
    if (!maxChargeKw || maxChargeKw <= 0) {
      throw new Error('Max charging power unknown: provide maxChargeKw or update the EV record');
    }
    const maxDischargeKw = input.maxDischargeKw ?? (ev.maxDischargingPowerKw ? ev.maxDischargingPowerKw / 10 : 0);

    const now = new Date();
    const departure = new Date(input.departureTime);
    if (departure.getTime() <= now.getTime()) {
      throw new Error('Departure time must be in the future');
    }
    const targetSoc = input.targetSocPercent;
    if (targetSoc <= startSoc && !(input.allowV2g && ev.v2gCapable)) {
      throw new Error('Target SoC must exceed current SoC when V2G is disabled');
    }
    const minSocReserve = input.minSocReservePercent ?? ev.minSocPercent;

    const hoursNeeded = Math.ceil((departure.getTime() - now.getTime()) / 3600000);

    // ---- Real price series for the plugged-in window ----
    const priceData = await this.getWindowPrices(now, hoursNeeded);
    if (!priceData) {
      return {
        scheduleAvailable: false,
        reason: 'No recorded market prices or trained ML price forecast available for the plugged-in window; schedule economics cannot be computed without a real price series',
      };
    }
    const { prices, source } = priceData;

    // Build hourly slots
    const slots: HourSlot[] = prices.map((price, i) => ({
      index: i,
      startTime: new Date(now.getTime() + i * 3600000),
      endTime: new Date(now.getTime() + (i + 1) * 3600000),
      price,
      chargeKwh: 0,
      dischargeKwh: 0,
    }));

    // ---- Optional V2G discharge at top-quartile price hours ----
    const allowV2g = Boolean(input.allowV2g) && ev.v2gCapable && maxDischargeKw > 0;
    if (allowV2g) {
      const sortedPrices = [...prices].sort((a, b) => a - b);
      const q3 = sortedPrices[Math.floor((sortedPrices.length - 1) * 0.75)];
      const dischargeCandidates = slots
        .filter(s => s.price >= q3 && prices.length > 1 && s.price > sortedPrices[0])
        .sort((a, b) => b.price - a.price);

      // Simulate in time order: never drop below the min-SoC reserve
      const candidateSet = new Set(dischargeCandidates.map(s => s.index));
      let soc = startSoc;
      for (const slot of slots) {
        if (!candidateSet.has(slot.index)) continue;
        const availableKwh = ((soc - minSocReserve) / 100) * batteryCapacityKwh;
        const discharge = Math.min(maxDischargeKw, Math.max(0, availableKwh));
        if (discharge > 0) {
          slot.dischargeKwh = discharge;
          soc -= (discharge / batteryCapacityKwh) * 100;
        }
      }
    }

    // ---- Charging allocation at cheapest hours ----
    const allocateCharging = (): boolean => {
      // Reset charge allocation
      for (const s of slots) s.chargeKwh = 0;
      const dischargedKwh = slots.reduce((sum, s) => sum + s.dischargeKwh, 0);
      const socAfterDischarge = startSoc - (dischargedKwh / batteryCapacityKwh) * 100;
      const energyNeededKwh = ((targetSoc - socAfterDischarge) / 100) * batteryCapacityKwh;
      if (energyNeededKwh <= 0) return true;

      let remaining = energyNeededKwh;
      const cheapestFirst = [...slots]
        .filter(s => s.dischargeKwh === 0)
        .sort((a, b) => a.price - b.price);
      for (const slot of cheapestFirst) {
        if (remaining <= 0) break;
        const charge = Math.min(maxChargeKw, remaining);
        slot.chargeKwh = charge;
        remaining -= charge;
      }
      return remaining <= 1e-9;
    };

    // If the discharge plan makes the target unreachable, drop the cheapest
    // discharge slots until charging can catch up before departure.
    let feasible = allocateCharging();
    while (!feasible) {
      const discharged = slots.filter(s => s.dischargeKwh > 0).sort((a, b) => a.price - b.price);
      if (discharged.length === 0) break;
      discharged[0].dischargeKwh = 0;
      feasible = allocateCharging();
    }

    if (!feasible) {
      const maxChargeableKwh = slots.length * maxChargeKw;
      const maxReachableSoc = Math.min(100, startSoc + (maxChargeableKwh / batteryCapacityKwh) * 100);
      return {
        scheduleAvailable: false,
        reason: `Target SoC ${targetSoc}% is not reachable before departure: the plugged-in window supports charging at most ${maxChargeableKwh.toFixed(1)} kWh`,
        maxReachableSocPercent: Math.round(maxReachableSoc * 100) / 100,
        priceSource: source,
      };
    }

    // ---- Simulate the trajectory and build intervals ----
    const intervals: ScheduleInterval[] = [];
    let soc = startSoc;
    let expectedCostCents = 0;
    let expectedRevenueCents = 0;
    for (const slot of slots) {
      if (slot.chargeKwh === 0 && slot.dischargeKwh === 0) continue;
      const netKwh = slot.chargeKwh - slot.dischargeKwh;
      soc = Math.min(100, soc + (netKwh / batteryCapacityKwh) * 100);
      const costCents = Math.round(slot.chargeKwh * slot.price);
      const revenueCents = Math.round(slot.dischargeKwh * slot.price);
      expectedCostCents += costCents;
      expectedRevenueCents += revenueCents;
      intervals.push({
        startTime: slot.startTime,
        endTime: slot.endTime,
        powerKw: netKwh, // 1-hour slots: kWh == kW average
        priceCentsPerKwh: slot.price,
        costCents,
        revenueCents,
        socAfterPercent: Math.round(soc * 100) / 100,
      });
    }

    // ---- Naive baseline from the SAME price series: charge immediately at
    // max power from now until the target is reached; no V2G. ----
    let naiveBaselineCostCents = 0;
    {
      let remaining = Math.max(0, ((targetSoc - startSoc) / 100) * batteryCapacityKwh);
      for (const slot of slots) {
        if (remaining <= 0) break;
        const charge = Math.min(maxChargeKw, remaining);
        naiveBaselineCostCents += Math.round(charge * slot.price);
        remaining -= charge;
      }
    }

    const energyToChargeKwh = slots.reduce((sum, s) => sum + s.chargeKwh, 0);

    // ---- Persist ----
    const insertResult = await db.insert(v2gSchedules).values({
      userId,
      evId: input.evId,
      departureTime: departure,
      targetSocPercent: Math.round(targetSoc * 100),
      minSocReservePercent: Math.round(minSocReserve * 100),
      startSocPercent: Math.round(startSoc * 100),
      batteryCapacityKwh10: Math.round(batteryCapacityKwh * 10),
      allowV2g: allowV2g,
      priceSource: source,
      scheduleJson: JSON.stringify(intervals),
      energyToChargeKwh10: Math.round(energyToChargeKwh * 10),
      expectedCostCents,
      naiveBaselineCostCents,
      expectedRevenueCents,
      status: 'active',
    }).returning({ id: v2gSchedules.id });
    const scheduleId = Number(insertResult[0].id);

    console.log(`[V2GOptimizer] Schedule ${scheduleId} for EV ${input.evId}: ${intervals.length} intervals, cost=${expectedCostCents}c, revenue=${expectedRevenueCents}c, naive=${naiveBaselineCostCents}c (source=${source})`);

    return {
      scheduleAvailable: true,
      scheduleId,
      priceSource: source,
      intervals,
      energyToChargeKwh: Math.round(energyToChargeKwh * 100) / 100,
      expectedCostCents,
      naiveBaselineCostCents,
      expectedRevenueCents,
      expectedSavingsCents: naiveBaselineCostCents + expectedRevenueCents - expectedCostCents,
      departureTime: departure,
      targetSocPercent: targetSoc,
    };
  }

  /**
   * Real hourly prices for [start, start+hours). Recorded market prices first
   * (gap-filled by carrying the nearest real value, same approach as
   * ev-charging.getPricePattern), then the ML forecast. Null when neither
   * source has data.
   */
  private async getWindowPrices(start: Date, hours: number): Promise<{ prices: number[]; source: 'market_prices' | 'ml_forecast' } | null> {
    const db = await getDb();
    if (db) {
      try {
        const end = new Date(start.getTime() + hours * 3600000);
        const rows = await db
          .select()
          .from(marketPrices)
          .where(and(gte(marketPrices.timestamp, start), lte(marketPrices.timestamp, end)))
          .orderBy(asc(marketPrices.timestamp));

        if (rows.length > 0) {
          const pattern: (number | null)[] = new Array(hours).fill(null);
          for (const row of rows) {
            const idx = Math.floor((new Date(row.timestamp).getTime() - start.getTime()) / 3600000);
            if (idx >= 0 && idx < hours) pattern[idx] = row.price;
          }
          let last: number | null = null;
          for (let i = 0; i < hours; i++) {
            if (pattern[i] !== null) last = pattern[i];
            else if (last !== null) pattern[i] = last;
          }
          let next: number | null = null;
          for (let i = hours - 1; i >= 0; i--) {
            if (pattern[i] !== null) next = pattern[i];
            else if (next !== null) pattern[i] = next;
          }
          if (pattern.every(p => p !== null)) {
            return { prices: pattern as number[], source: 'market_prices' };
          }
        }
      } catch (error) {
        console.warn('[V2GOptimizer] Failed to load market prices, trying ML forecast:', error);
      }
    }

    try {
      const predictions = await pricePredictionService.predictPrices(hours);
      if (predictions.length > 0) {
        const prices: number[] = [];
        for (let i = 0; i < hours; i++) {
          prices.push(predictions[Math.min(i, predictions.length - 1)].predictedPrice);
        }
        return { prices, source: 'ml_forecast' };
      }
    } catch (error) {
      console.warn('[V2GOptimizer] ML price forecast unavailable:', error);
    }

    return null;
  }

  /** Get a persisted schedule (ownership enforced by caller). */
  async getSchedule(scheduleId: number) {
    const db = await getDb();
    if (!db) throw new Error('Database not available');
    const rows = await db.select().from(v2gSchedules).where(eq(v2gSchedules.id, scheduleId)).limit(1);
    return rows[0] ?? null;
  }

  /** List a user's schedules, newest first. */
  async listSchedules(userId: number, limit: number = 20) {
    const db = await getDb();
    if (!db) throw new Error('Database not available');
    return db
      .select()
      .from(v2gSchedules)
      .where(eq(v2gSchedules.userId, userId))
      .orderBy(desc(v2gSchedules.createdAt))
      .limit(limit);
  }

  /** Cancel a schedule. */
  async cancelSchedule(scheduleId: number, userId: number) {
    const db = await getDb();
    if (!db) throw new Error('Database not available');
    const schedule = await this.getSchedule(scheduleId);
    if (!schedule) throw new Error('Schedule not found');
    if (schedule.userId !== userId) throw new Error('Schedule does not belong to this user');
    if (schedule.status !== 'active' && schedule.status !== 'draft') {
      throw new Error(`Cannot cancel a schedule with status ${schedule.status}`);
    }
    await db.execute<SqlRow>(sql`UPDATE v2g_schedules SET status = 'cancelled' WHERE id = ${scheduleId}`);
    return this.getSchedule(scheduleId);
  }
}

export const v2gOptimizer = new V2gOptimizerService();
