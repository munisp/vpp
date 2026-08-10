/**
 * Weather-Aware Solar Yield Forecasting (feature 12)
 *
 * Per solar asset:
 *  - Historical daily yield is computed from real cumulative telemetry energy.
 *  - A per-asset derate factor (performance ratio) is LEARNED from the asset's
 *    own history: PR = actual daily yield / theoretical clear-sky daily yield,
 *    where the clear-sky model is a deterministic solar-geometry computation
 *    (no randomness, no fabricated numbers).
 *  - The next-3-days forecast = capacity x peak-sun-hours from the REAL
 *    OpenWeatherMap forecast (server/services/weather-api.ts, whose
 *    OPENWEATHER_API_KEY / ALLOW_MOCK_WEATHER gate is respected) x learned
 *    derate. When the weather service is unavailable the response is
 *    { forecastAvailable: false, reason } — never silent mock numbers.
 *  - Underperformance: recent PR below a threshold learned from the asset's
 *    own history (median - 2 x MAD).
 */

import { eq, and, gte, inArray, isNotNull } from "drizzle-orm";
import { getDb } from "../db";
import { assets, telemetry, type Asset } from "../../drizzle/schema";
import { getWeatherForecast } from "./weather-api";

const HISTORY_DAYS = 90;
const RECENT_WINDOW_DAYS = 14;
/** Platform default site location (Dar es Salaam) used only when the asset
 * carries no coordinates; always flagged via locationSource in the response. */
const DEFAULT_LATITUDE = -6.8;
const DEFAULT_LONGITUDE = 39.28;
/** Clear-sky atmospheric transmittance for the beam+diffuse model. */
const CLEAR_SKY_TRANSMITTANCE = 0.75;

export interface DailyYield {
  date: string; // YYYY-MM-DD (UTC)
  actualWh: number;
  clearSkyWh: number;
  performanceRatio: number | null;
}

export interface PerformanceRatioResult {
  assetId: number;
  historyDays: number;
  daysWithData: number;
  insufficientHistory: boolean;
  learnedDerate: number | null; // median historical PR
  learnedThreshold: number | null; // median - 2*MAD
  recentPerformanceRatio: number | null; // median PR over the recent window
  underperforming: boolean;
  locationSource: "asset" | "default_tanzania";
  daily: DailyYield[];
}

export interface YieldForecastResult {
  assetId: number;
  capacityKw: number;
  learnedDerate: number | null;
  forecastAvailable: boolean;
  reason?: string;
  mockData?: boolean; // true when the weather service returned opted-in mock data
  days: Array<{
    date: string;
    peakSunHours: number;
    expectedYieldWh: number | null; // null when no derate could be learned
  }>;
}

interface AssetLocation {
  latitude: number;
  longitude: number;
  source: "asset" | "default_tanzania";
}

function getAssetLocation(asset: Asset): AssetLocation {
  if (asset.metadata) {
    try {
      const meta = JSON.parse(asset.metadata);
      const lat = Number(meta.latitude ?? meta.lat);
      const lon = Number(meta.longitude ?? meta.lon ?? meta.lng);
      if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        return { latitude: lat, longitude: lon, source: "asset" };
      }
    } catch {
      // fall through to default location
    }
  }
  return { latitude: DEFAULT_LATITUDE, longitude: DEFAULT_LONGITUDE, source: "default_tanzania" };
}

/**
 * Theoretical clear-sky daily irradiation (kWh/m^2/day) from solar geometry.
 * Deterministic: depends only on latitude and day of year.
 */
function clearSkyDailyKwhPerM2(latitudeDeg: number, date: Date): number {
  const dayOfYear = Math.floor(
    (Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) -
      Date.UTC(date.getUTCFullYear(), 0, 0)) / 86400000
  );
  const lat = (latitudeDeg * Math.PI) / 180;
  // Solar declination (Cooper equation)
  const decl = ((23.45 * Math.PI) / 180) * Math.sin(((2 * Math.PI) / 365) * (284 + dayOfYear));
  // Sunset hour angle
  const cosWs = -Math.tan(lat) * Math.tan(decl);
  const ws = Math.acos(Math.min(1, Math.max(-1, cosWs)));
  // Eccentricity correction
  const e0 = 1 + 0.033 * Math.cos((2 * Math.PI * dayOfYear) / 365);
  // Extraterrestrial daily irradiation, kWh/m^2/day (Gsc = 1.367 kW/m^2)
  const h0 =
    ((24 / Math.PI) * 1.367 * e0 *
      (ws * Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.sin(ws)));
  return Math.max(0, h0 * CLEAR_SKY_TRANSMITTANCE);
}

function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Compute daily actual yields (Wh) from cumulative telemetry energy readings.
 * Day boundaries are UTC. Negative deltas (meter resets) are dropped.
 */
async function getDailyActualYields(assetId: number, days: number): Promise<Map<string, number>> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const since = new Date(Date.now() - days * 86400000);
  const rows = await db
    .select({ timestamp: telemetry.timestamp, energy: telemetry.energy })
    .from(telemetry)
    .where(and(eq(telemetry.assetId, assetId), gte(telemetry.timestamp, since), isNotNull(telemetry.energy)))
    .orderBy(telemetry.timestamp);

  // Last cumulative reading per UTC day
  const lastByDay = new Map<string, { energy: number }>();
  for (const row of rows) {
    if (row.energy == null) continue;
    lastByDay.set(utcDayKey(new Date(row.timestamp)), { energy: row.energy });
  }

  const dayKeys = [...lastByDay.keys()].sort();
  const yields = new Map<string, number>();
  for (let i = 1; i < dayKeys.length; i++) {
    const prev = lastByDay.get(dayKeys[i - 1])!.energy;
    const curr = lastByDay.get(dayKeys[i])!.energy;
    const delta = curr - prev;
    if (delta >= 0) yields.set(dayKeys[i], delta);
    // negative delta => counter reset; skip the day rather than inventing data
  }
  return yields;
}

async function getSolarAsset(assetId: number): Promise<Asset> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  const asset = rows[0];
  if (!asset) throw new Error(`Asset ${assetId} not found`);
  if (asset.assetType !== "solar") {
    throw new Error(`Asset ${assetId} is not a solar asset (type: ${asset.assetType})`);
  }
  return asset;
}

/**
 * Compute the performance-ratio analysis for a solar asset.
 */
export async function getPerformanceRatio(assetId: number): Promise<PerformanceRatioResult> {
  const asset = await getSolarAsset(assetId);
  const location = getAssetLocation(asset);
  const capacityKw = asset.capacity / 1000;

  const actualByDay = await getDailyActualYields(assetId, HISTORY_DAYS);

  const daily: DailyYield[] = [];
  for (const [date, actualWh] of [...actualByDay.entries()].sort()) {
    const clearSkyWh = clearSkyDailyKwhPerM2(location.latitude, new Date(`${date}T12:00:00Z`)) * capacityKw * 1000;
    daily.push({
      date,
      actualWh,
      clearSkyWh: Math.round(clearSkyWh),
      performanceRatio: clearSkyWh > 0 ? actualWh / clearSkyWh : null,
    });
  }

  const prs = daily.map((d) => d.performanceRatio).filter((v): v is number => v != null && v > 0);
  const learnedDerate = median(prs);
  const insufficientHistory = prs.length < 7;

  let learnedThreshold: number | null = null;
  if (learnedDerate != null) {
    const deviations = prs.map((v) => Math.abs(v - learnedDerate));
    const mad = median(deviations) ?? 0;
    learnedThreshold = Math.max(0, learnedDerate - 2 * mad);
  }

  const recentCutoff = utcDayKey(new Date(Date.now() - RECENT_WINDOW_DAYS * 86400000));
  const recentPrs = daily
    .filter((d) => d.date >= recentCutoff)
    .map((d) => d.performanceRatio)
    .filter((v): v is number => v != null && v > 0);
  const recentPerformanceRatio = median(recentPrs);

  const underperforming =
    !insufficientHistory &&
    learnedThreshold != null &&
    recentPerformanceRatio != null &&
    recentPerformanceRatio < learnedThreshold;

  return {
    assetId,
    historyDays: HISTORY_DAYS,
    daysWithData: daily.length,
    insufficientHistory,
    learnedDerate,
    learnedThreshold,
    recentPerformanceRatio,
    underperforming,
    locationSource: location.source,
    daily,
  };
}

/**
 * 3-day weather-aware yield forecast for a solar asset.
 * Respects the weather-api gate: unavailable forecast => forecastAvailable:false.
 */
export async function getYieldForecast(assetId: number): Promise<YieldForecastResult> {
  const asset = await getSolarAsset(assetId);
  const location = getAssetLocation(asset);
  const capacityKw = asset.capacity / 1000;

  const pr = await getPerformanceRatio(assetId);

  let forecast;
  try {
    forecast = await getWeatherForecast(location.latitude, location.longitude, 72);
  } catch (error: any) {
    console.warn(`[SolarYield] Weather forecast unavailable for asset ${assetId}:`, error?.message || error);
    return {
      assetId,
      capacityKw,
      learnedDerate: pr.learnedDerate,
      forecastAvailable: false,
      reason: error?.message || "Weather forecast unavailable",
      days: [],
    };
  }

  // Aggregate 3-hourly irradiance points into per-day peak sun hours:
  // PSH = sum(irradiance W/m^2 * 3h) / 1000 W/m^2.
  const pshByDay = new Map<string, number>();
  for (const point of forecast) {
    const key = utcDayKey(new Date(point.timestamp));
    pshByDay.set(key, (pshByDay.get(key) ?? 0) + (point.solarIrradiance * 3) / 1000);
  }

  const days = [...pshByDay.entries()]
    .sort()
    .slice(0, 3)
    .map(([date, peakSunHours]) => ({
      date,
      peakSunHours: Math.round(peakSunHours * 100) / 100,
      expectedYieldWh:
        pr.learnedDerate != null
          ? Math.round(capacityKw * peakSunHours * pr.learnedDerate * 1000)
          : null,
    }));

  return {
    assetId,
    capacityKw,
    learnedDerate: pr.learnedDerate,
    forecastAvailable: true,
    mockData: forecast.some((p) => p.mock === true) || undefined,
    days,
  };
}

/**
 * Evaluate a set of solar assets and return those flagged underperforming.
 */
export async function getUnderperformingAssets(assetIds?: number[]): Promise<
  Array<{
    assetId: number;
    userId: number;
    name: string;
    recentPerformanceRatio: number | null;
    learnedThreshold: number | null;
    insufficientHistory: boolean;
  }>
> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = assetIds && assetIds.length > 0
    ? await db.select().from(assets).where(and(eq(assets.assetType, "solar"), inArray(assets.id, assetIds)))
    : await db.select().from(assets).where(eq(assets.assetType, "solar"));

  const flagged: Array<{
    assetId: number;
    userId: number;
    name: string;
    recentPerformanceRatio: number | null;
    learnedThreshold: number | null;
    insufficientHistory: boolean;
  }> = [];

  for (const asset of rows) {
    const pr = await getPerformanceRatio(asset.id);
    if (pr.underperforming) {
      flagged.push({
        assetId: asset.id,
        userId: asset.userId,
        name: asset.name,
        recentPerformanceRatio: pr.recentPerformanceRatio,
        learnedThreshold: pr.learnedThreshold,
        insufficientHistory: pr.insufficientHistory,
      });
    }
  }
  return flagged;
}
