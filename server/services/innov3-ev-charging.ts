/**
 * EV Smart Charging Planner
 *
 * Computes cost-optimal charge windows for an EV (modelled as a battery
 * asset, matching the platform's v2g_schedules convention) against the
 * currently *published* dynamic tariff for the user's country. Every price
 * comes from a dynamic_tariffs row — the published 24-period profile is
 * treated as a repeating daily profile (each period's hour-of-day price
 * applies to every day until departure).
 *
 * Honest states — the plan is persisted either way:
 *  - no published tariff          -> scheduleAvailable:false, reason 'no_tariff'
 *  - no SoC telemetry at planning -> scheduleAvailable:false, reason 'no_soc_telemetry'
 *  - not enough time to reach the -> scheduleAvailable:false, reason 'insufficient_time'
 *    target at maxChargePowerW
 * No schedule, energy or cost figure is ever invented.
 *
 * Sessions are derived from real telemetry only: a session is a contiguous
 * run of rising state-of-charge; its energy is the SoC delta applied to the
 * asset's capacity. Elapsed time is never treated as energy.
 */

import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { getDb } from '../db';
import { assets, telemetry } from '../../drizzle/schema';
import { evChargingPlans, evChargingSessions } from '../../drizzle/innov3-planning-schema';
import { getPublishedTariff } from './dynamic-tariffs';

const GAP_CAP_MS = 60 * 60 * 1000; // a session breaks across telemetry gaps > 1h
const MIN_SESSION_SOC_DELTA_PCT100 = 100; // ignore runs under 1% SoC rise (noise)
const MAX_SAMPLES = 200000;

export type PlanUnavailableReason = 'no_tariff' | 'no_soc_telemetry' | 'insufficient_time';

export interface ChargeWindow {
  startTime: string;
  endTime: string;
  priceCentsPerKwh: number;
  energyWh: number;
  costCents: number;
}

export interface EvPlanResult {
  planId: number | null;
  assetId: number;
  scheduleAvailable: boolean;
  unavailableReason: PlanUnavailableReason | null;
  departureTime: string;
  targetSocPct100: number;
  startSocPct100: number | null;
  capacityWh: number;
  maxChargePowerW: number;
  tariffId: number | null;
  tariffVersion: number | null;
  energyNeededWh: number | null;
  windows: ChargeWindow[];
  expectedCostCents: number | null;
  naiveImmediateCostCents: number | null;
  savingsVsImmediateCents: number | null;
  status: 'scheduled' | 'infeasible';
  createdAt: string;
}

async function getOwnedAsset(assetId: number, userId: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  if (!asset) throw new Error('ASSET_NOT_FOUND');
  if (asset.userId !== userId) throw new Error('ASSET_NOT_OWNED');
  if (asset.assetType !== 'battery') throw new Error('ASSET_NOT_BATTERY');
  return { db, asset };
}

export async function createEvChargingPlan(
  userId: number,
  country: 'nigeria' | 'tanzania',
  input: { assetId: number; departureTime: Date; targetSocPct100: number; maxChargePowerW: number },
): Promise<EvPlanResult> {
  const { db, asset } = await getOwnedAsset(input.assetId, userId);
  const now = new Date();
  if (input.departureTime.getTime() <= now.getTime()) throw new Error('DEPARTURE_IN_PAST');
  if (input.maxChargePowerW <= 0) throw new Error('INVALID_CHARGE_POWER');

  // Latest SoC from real telemetry.
  const [latestSoc] = await db
    .select({ stateOfCharge: telemetry.stateOfCharge })
    .from(telemetry)
    .where(eq(telemetry.assetId, asset.id))
    .orderBy(desc(telemetry.timestamp))
    .limit(1);
  const startSocPct100 = latestSoc?.stateOfCharge ?? null;

  const capacityWh = asset.capacity;
  const published = await getPublishedTariff(country);

  const base: Omit<EvPlanResult, 'planId' | 'status' | 'createdAt'> = {
    assetId: asset.id,
    scheduleAvailable: false,
    unavailableReason: null,
    departureTime: input.departureTime.toISOString(),
    targetSocPct100: input.targetSocPct100,
    startSocPct100,
    capacityWh,
    maxChargePowerW: input.maxChargePowerW,
    tariffId: published?.id ?? null,
    tariffVersion: published?.version ?? null,
    energyNeededWh: null,
    windows: [],
    expectedCostCents: null,
    naiveImmediateCostCents: null,
    savingsVsImmediateCents: null,
  };

  const persist = async (r: typeof base): Promise<EvPlanResult> => {
    const status = r.scheduleAvailable ? ('scheduled' as const) : ('infeasible' as const);
    const insert = await db.insert(evChargingPlans).values({
      userId,
      assetId: asset.id,
      country,
      departureTime: input.departureTime,
      targetSocPct100: input.targetSocPct100,
      startSocPct100,
      capacityWh,
      maxChargePowerW: input.maxChargePowerW,
      tariffId: r.tariffId,
      scheduleAvailable: r.scheduleAvailable,
      unavailableReason: r.unavailableReason,
      energyNeededWh: r.energyNeededWh,
      windows: r.windows,
      expectedCostCents: r.expectedCostCents,
      naiveImmediateCostCents: r.naiveImmediateCostCents,
      status,
    }).returning({ id: evChargingPlans.id, createdAt: evChargingPlans.createdAt });
    return {
      ...r,
      planId: Number(insert[0].id ?? 0) || null,
      status,
      createdAt: new Date(insert[0].createdAt).toISOString(),
    };
  };

  if (!published) {
    return persist({ ...base, unavailableReason: 'no_tariff', tariffId: null });
  }
  if (startSocPct100 === null) {
    return persist({ ...base, unavailableReason: 'no_soc_telemetry' });
  }
  if (input.targetSocPct100 <= startSocPct100) {
    // Already at/above target: nothing to schedule, zero-cost plan is real.
    return persist({ ...base, scheduleAvailable: true, energyNeededWh: 0, expectedCostCents: 0, naiveImmediateCostCents: 0, savingsVsImmediateCents: 0 });
  }

  const energyNeededWh = Math.round(((input.targetSocPct100 - startSocPct100) / 10000) * capacityWh);

  // Hour-of-day price map from the published 24-period profile. Hours whose
  // finalPriceCentsPerKwh is null cannot be priced and are excluded from the
  // schedule (they are never given an assumed price).
  const priceByHour = new Map<number, number>();
  for (const p of published.periods) {
    if (p.finalPriceCentsPerKwh !== null && p.finalPriceCentsPerKwh !== undefined) {
      priceByHour.set(new Date(p.hourStart).getHours(), p.finalPriceCentsPerKwh);
    }
  }

  // Enumerate whole hours from the next hour boundary to departure.
  const firstHour = new Date(now);
  firstHour.setMinutes(0, 0, 0);
  firstHour.setTime(firstHour.getTime() + 3600000);

  interface Slot { start: Date; price: number }
  const slots: Slot[] = [];
  for (let t = firstHour.getTime(); t + 1800000 <= input.departureTime.getTime(); t += 3600000) {
    const price = priceByHour.get(new Date(t).getHours());
    if (price !== undefined) slots.push({ start: new Date(t), price });
  }

  // Greedy cheapest-first allocation at the charger's power cap.
  const ordered = [...slots].sort((a, b) => a.price - b.price || a.start.getTime() - b.start.getTime());
  const windows: ChargeWindow[] = [];
  let remaining = energyNeededWh;
  let expectedCostCents = 0;
  for (const slot of ordered) {
    if (remaining <= 0) break;
    const energyWh = Math.min(input.maxChargePowerW, remaining); // W * 1h = Wh
    const costCents = Math.round((energyWh * slot.price) / 1000);
    windows.push({
      startTime: slot.start.toISOString(),
      endTime: new Date(slot.start.getTime() + 3600000).toISOString(),
      priceCentsPerKwh: slot.price,
      energyWh,
      costCents,
    });
    expectedCostCents += costCents;
    remaining -= energyWh;
  }

  if (remaining > 0) {
    return persist({ ...base, unavailableReason: 'insufficient_time', energyNeededWh });
  }

  windows.sort((a, b) => a.startTime.localeCompare(b.startTime));

  // Naive baseline: the same energy charged entirely at the current hour's price.
  const currentPrice = priceByHour.get(now.getHours());
  const naiveImmediateCostCents = currentPrice !== undefined
    ? Math.round((energyNeededWh * currentPrice) / 1000)
    : null;

  return persist({
    ...base,
    scheduleAvailable: true,
    energyNeededWh,
    windows,
    expectedCostCents,
    naiveImmediateCostCents,
    savingsVsImmediateCents: naiveImmediateCostCents !== null ? naiveImmediateCostCents - expectedCostCents : null,
  });
}

export async function listEvChargingPlans(userId: number, assetId: number | undefined, limit: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const where = assetId !== undefined
    ? and(eq(evChargingPlans.userId, userId), eq(evChargingPlans.assetId, assetId))
    : eq(evChargingPlans.userId, userId);
  return db.select().from(evChargingPlans).where(where).orderBy(desc(evChargingPlans.createdAt)).limit(limit);
}

export async function cancelEvChargingPlan(planId: number, userId: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const [plan] = await db.select().from(evChargingPlans).where(eq(evChargingPlans.id, planId)).limit(1);
  if (!plan) throw new Error('PLAN_NOT_FOUND');
  if (plan.userId !== userId) throw new Error('PLAN_NOT_OWNED');
  if (plan.status === 'completed' || plan.status === 'cancelled') throw new Error('PLAN_NOT_CANCELLABLE');
  await db.update(evChargingPlans).set({ status: 'cancelled' }).where(eq(evChargingPlans.id, planId));
  return { planId, status: 'cancelled' as const };
}

/**
 * Derive charging sessions from the asset's real SoC telemetry and persist
 * any not already recorded (idempotent: only sessions starting after the last
 * recorded session's end are inserted).
 */
export async function syncEvChargingSessions(assetId: number, userId: number) {
  const { db, asset } = await getOwnedAsset(assetId, userId);

  const [lastSession] = await db
    .select({ endedAt: evChargingSessions.endedAt })
    .from(evChargingSessions)
    .where(eq(evChargingSessions.assetId, assetId))
    .orderBy(desc(evChargingSessions.endedAt))
    .limit(1);

  const samples = await db
    .select({ timestamp: telemetry.timestamp, stateOfCharge: telemetry.stateOfCharge })
    .from(telemetry)
    .where(
      lastSession
        ? and(eq(telemetry.assetId, assetId), gt(telemetry.timestamp, lastSession.endedAt))
        : eq(telemetry.assetId, assetId),
    )
    .orderBy(asc(telemetry.timestamp))
    .limit(MAX_SAMPLES);

  const soc = samples.filter(s => s.stateOfCharge !== null) as Array<{ timestamp: Date; stateOfCharge: number }>;

  interface Run { start: Date; end: Date; startSoc: number; endSoc: number; n: number }
  const runs: Run[] = [];
  let cur: Run | null = null;
  for (let i = 1; i < soc.length; i++) {
    const prev = soc[i - 1];
    const s = soc[i];
    const dtMs = new Date(s.timestamp).getTime() - new Date(prev.timestamp).getTime();
    const rising = s.stateOfCharge > prev.stateOfCharge && dtMs > 0 && dtMs <= GAP_CAP_MS;
    if (rising) {
      if (!cur) cur = { start: new Date(prev.timestamp), end: new Date(s.timestamp), startSoc: prev.stateOfCharge, endSoc: s.stateOfCharge, n: 2 };
      else { cur.end = new Date(s.timestamp); cur.endSoc = s.stateOfCharge; cur.n += 1; }
    } else if (cur) {
      runs.push(cur);
      cur = null;
    }
  }
  if (cur) runs.push(cur);

  const qualifying = runs.filter(r => r.endSoc - r.startSoc >= MIN_SESSION_SOC_DELTA_PCT100);

  // Active plans for overlap attribution.
  const plans = await db
    .select({ id: evChargingPlans.id, createdAt: evChargingPlans.createdAt, departureTime: evChargingPlans.departureTime })
    .from(evChargingPlans)
    .where(and(eq(evChargingPlans.assetId, assetId), eq(evChargingPlans.userId, userId)));

  let inserted = 0;
  for (const r of qualifying) {
    const plan = plans.find(p => r.start >= new Date(p.createdAt) && r.start <= new Date(p.departureTime));
    await db.insert(evChargingSessions).values({
      planId: plan?.id ?? null,
      userId,
      assetId,
      startedAt: r.start,
      endedAt: r.end,
      startSocPct100: r.startSoc,
      endSocPct100: r.endSoc,
      capacityWh: asset.capacity,
      energyWh: Math.round(((r.endSoc - r.startSoc) / 10000) * asset.capacity),
      sampleCount: r.n,
      source: 'telemetry',
    });
    inserted += 1;
  }

  return { assetId, sessionsInserted: inserted, sessionsDetected: qualifying.length, samplesScanned: samples.length };
}

export async function listEvChargingSessions(assetId: number, userId: number, limit: number) {
  const { db } = await getOwnedAsset(assetId, userId);
  return db
    .select()
    .from(evChargingSessions)
    .where(and(eq(evChargingSessions.assetId, assetId), eq(evChargingSessions.userId, userId)))
    .orderBy(desc(evChargingSessions.startedAt))
    .limit(limit);
}
