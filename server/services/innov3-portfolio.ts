/**
 * Portfolio Dashboard Service
 *
 * Multi-site rollup across all of a user's assets over a selectable period.
 * Every number comes from a real table:
 *  - generation/consumption from the real `telemetry` table, either as an
 *    energy-register delta (preferred) or by integrating power samples with
 *    the same 1-hour gap cap as battery-health.ts;
 *  - battery state of health from the latest real `battery_health_snapshots`
 *    row for the asset (estimatedSohPct100), never recomputed differently here.
 *
 * Honesty rules:
 *  - A site with no usable data in the period appears with
 *    `available:false` and a reason — it never contributes a fabricated
 *    zero. Totals aggregate only available sites and say how many sites
 *    they cover.
 *  - An energy register that runs backwards (meter replacement/reset)
 *    makes register-delta unusable for that period; the service falls back
 *    to power integration, and if that is also impossible the site is
 *    unavailable. The fallback is labelled per site.
 */

import { and, asc, desc, eq, gte, lt } from 'drizzle-orm';
import { getDb } from '../db';
import { assets, telemetry } from '../../drizzle/schema';
import { batteryHealthSnapshots } from '../../drizzle/innovations-schema';
import { portfolioSnapshots } from '../../drizzle/innov3-fieldops-schema';

const GAP_CAP_MS = 60 * 60 * 1000;
const MAX_SAMPLES = 200000;

export type PortfolioPeriod = '24h' | '7d' | '30d' | '90d';

const PERIOD_MS: Record<PortfolioPeriod, number> = {
  '24h': 24 * 3600000,
  '7d': 7 * 86400000,
  '30d': 30 * 86400000,
  '90d': 90 * 86400000,
};

export interface SiteEntry {
  assetId: number;
  assetName: string;
  assetType: string;
  available: boolean;
  /** Why the site is unavailable (null when available). */
  reason: string | null;
  sampleCount: number;
  /** Wh measured in the period for generation asset types. */
  generationWh: number | null;
  /** Wh measured in the period for meter (consumption) assets. */
  consumptionWh: number | null;
  /** How the Wh figure was obtained. */
  measurementMethod: 'energy_register' | 'power_integration' | null;
  /** Latest real SoH estimate (percent) for batteries; null otherwise. */
  batterySohPct: number | null;
  batterySohAsOf: string | null;
}

export interface PortfolioResult {
  userId: number;
  period: PortfolioPeriod;
  periodStart: string;
  periodEnd: string;
  sites: SiteEntry[];
  totals: {
    siteCount: number;
    availableSiteCount: number;
    unavailableSiteCount: number;
    generationWh: number;
    consumptionWh: number;
    /** Mean of available battery SoH estimates; null when none. */
    meanBatterySohPct: number | null;
  };
  snapshotId: number | null;
  computedAt: string;
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error('DATABASE_UNAVAILABLE');
  return db;
}

const GENERATION_TYPES = new Set(['solar', 'wind', 'generator']);

async function measureSite(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  asset: { id: number; name: string; assetType: string },
  start: Date,
  end: Date
): Promise<SiteEntry> {
  const samples = await db
    .select({ timestamp: telemetry.timestamp, power: telemetry.power, energy: telemetry.energy })
    .from(telemetry)
    .where(and(eq(telemetry.assetId, asset.id), gte(telemetry.timestamp, start), lt(telemetry.timestamp, end)))
    .orderBy(asc(telemetry.timestamp))
    .limit(MAX_SAMPLES);

  // Latest real battery SoH snapshot, regardless of telemetry coverage.
  let batterySohPct: number | null = null;
  let batterySohAsOf: string | null = null;
  if (asset.assetType === 'battery') {
    const [snap] = await db
      .select({
        estimatedSohPct100: batteryHealthSnapshots.estimatedSohPct100,
        computedAt: batteryHealthSnapshots.computedAt,
      })
      .from(batteryHealthSnapshots)
      .where(eq(batteryHealthSnapshots.assetId, asset.id))
      .orderBy(desc(batteryHealthSnapshots.computedAt))
      .limit(1);
    if (snap && snap.estimatedSohPct100 !== null) {
      batterySohPct = snap.estimatedSohPct100 / 100;
      batterySohAsOf = new Date(snap.computedAt).toISOString();
    }
  }

  const base: SiteEntry = {
    assetId: asset.id,
    assetName: asset.name,
    assetType: asset.assetType,
    available: false,
    reason: null,
    sampleCount: samples.length,
    generationWh: null,
    consumptionWh: null,
    measurementMethod: null,
    batterySohPct,
    batterySohAsOf,
  };

  if (samples.length === 0) {
    return { ...base, reason: 'No telemetry in the selected period.' };
  }

  // Preferred: cumulative energy register delta.
  const registerSamples = samples.filter(s => s.energy !== null);
  let energyWh: number | null = null;
  let method: SiteEntry['measurementMethod'] = null;
  if (registerSamples.length >= 2) {
    const delta = registerSamples[registerSamples.length - 1].energy! - registerSamples[0].energy!;
    if (delta >= 0) {
      energyWh = delta;
      method = 'energy_register';
    }
  }

  // Fallback: integrate real power samples, capping gaps > 1h.
  if (energyWh === null) {
    const powerSamples = samples.filter(s => s.power !== null);
    if (powerSamples.length >= 2) {
      let ws = 0;
      for (let i = 1; i < powerSamples.length; i++) {
        const dtMs = new Date(powerSamples[i].timestamp).getTime() - new Date(powerSamples[i - 1].timestamp).getTime();
        if (dtMs <= 0 || dtMs > GAP_CAP_MS) continue;
        ws += ((powerSamples[i - 1].power! + powerSamples[i].power!) / 2) * (dtMs / 1000);
      }
      energyWh = Math.round(ws / 3600);
      method = 'power_integration';
    }
  }

  if (energyWh === null) {
    return {
      ...base,
      reason: 'Fewer than two usable power/energy samples in the period; energy is unknown, not zero.',
    };
  }

  const isGeneration = GENERATION_TYPES.has(asset.assetType);
  return {
    ...base,
    available: true,
    generationWh: isGeneration ? energyWh : null,
    consumptionWh: asset.assetType === 'meter' ? energyWh : null,
    measurementMethod: method,
  };
}

export async function getPortfolio(
  userId: number,
  period: PortfolioPeriod,
  opts: { persist?: boolean } = {}
): Promise<PortfolioResult> {
  const db = await requireDb();
  const end = new Date();
  const start = new Date(end.getTime() - PERIOD_MS[period]);

  const userAssets = await db
    .select({ id: assets.id, name: assets.name, assetType: assets.assetType })
    .from(assets)
    .where(eq(assets.userId, userId))
    .orderBy(asc(assets.id));

  const sites: SiteEntry[] = [];
  for (const asset of userAssets) {
    sites.push(await measureSite(db, asset, start, end));
  }

  const available = sites.filter(s => s.available);
  const sohValues = sites.filter(s => s.batterySohPct !== null).map(s => s.batterySohPct!);

  const result: PortfolioResult = {
    userId,
    period,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    sites,
    totals: {
      siteCount: sites.length,
      availableSiteCount: available.length,
      unavailableSiteCount: sites.length - available.length,
      generationWh: available.reduce((sum, s) => sum + (s.generationWh ?? 0), 0),
      consumptionWh: available.reduce((sum, s) => sum + (s.consumptionWh ?? 0), 0),
      meanBatterySohPct: sohValues.length > 0
        ? Math.round((sohValues.reduce((a, b) => a + b, 0) / sohValues.length) * 100) / 100
        : null,
    },
    snapshotId: null,
    computedAt: new Date().toISOString(),
  };

  if (opts.persist !== false) {
    try {
      const inserted = await db
        .insert(portfolioSnapshots)
        .values({
          userId,
          periodStart: start,
          periodEnd: end,
          periodLabel: period,
          siteCount: result.totals.siteCount,
          unavailableSiteCount: result.totals.unavailableSiteCount,
          payload: result as unknown as Record<string, unknown>,
        })
        .returning({ id: portfolioSnapshots.id });
      result.snapshotId = Number(inserted[0]?.id ?? 0) || null;
    } catch (error) {
      console.error('[Portfolio] Failed to persist snapshot:', error);
    }
  }

  return result;
}

export async function listPortfolioSnapshots(userId: number, limit = 10) {
  const db = await requireDb();
  return db
    .select({
      id: portfolioSnapshots.id,
      periodStart: portfolioSnapshots.periodStart,
      periodEnd: portfolioSnapshots.periodEnd,
      periodLabel: portfolioSnapshots.periodLabel,
      siteCount: portfolioSnapshots.siteCount,
      unavailableSiteCount: portfolioSnapshots.unavailableSiteCount,
      createdAt: portfolioSnapshots.createdAt,
    })
    .from(portfolioSnapshots)
    .where(eq(portfolioSnapshots.userId, userId))
    .orderBy(desc(portfolioSnapshots.createdAt))
    .limit(Math.min(limit, 50));
}
