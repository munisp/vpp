/**
 * TOU dispatch windows (innovation 19)
 *
 * Recommends charge/discharge windows for one flexible asset from the
 * PUBLISHED dynamic tariff for the user's country (real dynamic_tariffs
 * versions, built from real market price history) plus the asset's
 * registered constraints (der_capabilities import/export limits, SoC
 * bounds; assets.capacity for energy).
 *
 * Honest states — the recommendation row is persisted either way:
 *  - no published tariff for the user's country ->
 *    recommendationAvailable: false, reason 'no_tariff'
 *  - asset not flexible (not a battery) -> reason 'asset_not_flexible'
 *  - asset has no registered charge/discharge limits ->
 *    reason 'asset_constraints_unregistered'
 *  - the published tariff prices no hour cheap/dear enough to act on ->
 *    available with empty windows (a real answer: nothing to do)
 *
 * Windows are contiguous runs of published off-peak (charge) and peak
 * (discharge) hours, each carrying the real published price range of the
 * hours it was chosen from. Prices are never invented.
 */

import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../db';
import { assets, users } from '../../drizzle/schema';
import { derCapabilities } from '../../drizzle/nextgen-vpp-schema';
import { getPublishedTariff, type TariffPeriod } from './dynamic-tariffs';
import {
  dispatchWindowRecommendations,
  type DispatchWindowRecommendationRow,
} from '../../drizzle/innov3-control-schema';

export class DispatchWindowError extends Error {}

export type WindowUnavailableReason =
  | 'no_tariff'
  | 'asset_not_flexible'
  | 'asset_constraints_unregistered';

interface Window {
  action: 'charge' | 'discharge';
  startIso: string;
  endIso: string;
  band: 'off_peak' | 'shoulder' | 'peak';
  minPriceCentsPerKwh: number | null;
  maxPriceCentsPerKwh: number | null;
  hours: number;
}

/** Group contiguous periods of one band into windows, with the real price range. */
function runsOfBand(
  periods: TariffPeriod[],
  band: 'off_peak' | 'peak',
  action: 'charge' | 'discharge'
): Window[] {
  const sorted = [...periods].sort((a, b) => a.hourStart.localeCompare(b.hourStart));
  const windows: Window[] = [];
  let current: { startIso: string; endIso: string; prices: number[] } | null = null;

  const flush = () => {
    if (!current) return;
    windows.push({
      action,
      startIso: current.startIso,
      endIso: current.endIso,
      band,
      minPriceCentsPerKwh: current.prices.length > 0 ? Math.min(...current.prices) : null,
      maxPriceCentsPerKwh: current.prices.length > 0 ? Math.max(...current.prices) : null,
      hours: current.prices.length,
    });
    current = null;
  };

  for (const p of sorted) {
    const start = new Date(p.hourStart);
    const end = new Date(start.getTime() + 3600_000);
    if (p.band === band) {
      const price = p.finalPriceCentsPerKwh;
      if (current) {
        current.endIso = end.toISOString();
        if (price !== null) current.prices.push(price);
        else current.prices.push(...[]); // null-priced hour: window still real, price range from priced hours
      } else {
        current = { startIso: start.toISOString(), endIso: end.toISOString(), prices: price !== null ? [price] : [] };
      }
    } else {
      flush();
    }
  }
  flush();

  // A window spanning unpriced hours only would have an empty price list;
  // `hours` counts the hours in the run, not the priced hours. Recompute.
  return windows.map((w) => ({
    ...w,
    hours: Math.round((new Date(w.endIso).getTime() - new Date(w.startIso).getTime()) / 3600_000),
  }));
}

export interface DispatchWindowResult {
  row: DispatchWindowRecommendationRow;
}

/**
 * Compute and persist a recommendation for one asset the user owns.
 */
export async function computeWindows(userId: number, assetId: number): Promise<DispatchWindowRecommendationRow> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const assetRows = await db
    .select({
      id: assets.id,
      userId: assets.userId,
      assetType: assets.assetType,
      capacity: assets.capacity,
      maxPowerImport: derCapabilities.maxPowerImport,
      maxPowerExport: derCapabilities.maxPowerExport,
      minSoc: derCapabilities.minStateOfCharge,
      maxSoc: derCapabilities.maxStateOfCharge,
    })
    .from(assets)
    .leftJoin(derCapabilities, eq(derCapabilities.assetId, assets.id))
    .where(eq(assets.id, assetId))
    .limit(1);
  const asset = assetRows[0];
  if (!asset || asset.userId !== userId) {
    throw new DispatchWindowError(`Asset ${assetId} not found`);
  }

  const assetConstraints = {
    capacityWh: asset.assetType === 'battery' ? asset.capacity : null,
    maxPowerImportW: asset.maxPowerImport,
    maxPowerExportW: asset.maxPowerExport,
    minSocX100: asset.minSoc,
    maxSocX100: asset.maxSoc,
  };

  const persist = async (params: {
    available: boolean;
    reason: WindowUnavailableReason | null;
    windows: Window[] | null;
    tariffId: number | null;
    tariffVersion: number | null;
  }): Promise<DispatchWindowRecommendationRow> => {
    const inserted = await db
      .insert(dispatchWindowRecommendations)
      .values({
        userId,
        assetId,
        tariffId: params.tariffId,
        tariffVersion: params.tariffVersion,
        recommendationAvailable: params.available,
        reason: params.reason,
        windows: params.windows,
        assetConstraints,
        computedAt: new Date(),
      })
      .returning();
    return inserted[0];
  };

  if (asset.assetType !== 'battery') {
    return persist({
      available: false,
      reason: 'asset_not_flexible',
      windows: null,
      tariffId: null,
      tariffVersion: null,
    });
  }

  if (asset.maxPowerImport === null && asset.maxPowerExport === null) {
    return persist({
      available: false,
      reason: 'asset_constraints_unregistered',
      windows: null,
      tariffId: null,
      tariffVersion: null,
    });
  }

  const userRows = await db.select({ country: users.country }).from(users).where(eq(users.id, userId)).limit(1);
  const country = userRows[0]?.country;
  if (!country) throw new DispatchWindowError(`User ${userId} not found`);

  const tariff = await getPublishedTariff(country);
  if (!tariff) {
    return persist({
      available: false,
      reason: 'no_tariff',
      windows: null,
      tariffId: null,
      tariffVersion: null,
    });
  }

  const windows: Window[] = [];
  // Only recommend the direction the asset is registered to perform.
  if (asset.maxPowerImport !== null && asset.maxPowerImport > 0) {
    windows.push(...runsOfBand(tariff.periods, 'off_peak', 'charge'));
  }
  if (asset.maxPowerExport !== null && asset.maxPowerExport > 0) {
    windows.push(...runsOfBand(tariff.periods, 'peak', 'discharge'));
  }
  windows.sort((a, b) => a.startIso.localeCompare(b.startIso));

  return persist({
    available: true,
    reason: null,
    windows,
    tariffId: tariff.id,
    tariffVersion: tariff.version,
  });
}

export async function getRecommendation(
  userId: number,
  id: number
): Promise<DispatchWindowRecommendationRow> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const rows = await db
    .select()
    .from(dispatchWindowRecommendations)
    .where(and(eq(dispatchWindowRecommendations.id, id), eq(dispatchWindowRecommendations.userId, userId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new DispatchWindowError(`Recommendation ${id} not found`);
  return row;
}

export async function listRecommendations(
  userId: number,
  assetId: number | undefined,
  limit: number
): Promise<DispatchWindowRecommendationRow[]> {
  const db = await getDb();
  if (!db) return [];
  const conditions = [eq(dispatchWindowRecommendations.userId, userId)];
  if (assetId !== undefined) conditions.push(eq(dispatchWindowRecommendations.assetId, assetId));
  return db
    .select()
    .from(dispatchWindowRecommendations)
    .where(and(...conditions))
    .orderBy(desc(dispatchWindowRecommendations.computedAt))
    .limit(limit);
}
