/**
 * DR Event Forecasting + Participant Recommendation Service
 *
 * Forecasts the likelihood of demand-response event need per day from REAL
 * signals only:
 *   1. demandResponseEvents history — event frequency by weekday and season
 *      (same weekday ± same calendar month over the trailing 180 days)
 *   2. Telemetry aggregate demand trend — recent 7-day mean demand vs the
 *      prior 21 days, across all metered assets
 *   3. Weather forecast heat — OpenWeather via server/services/weather-api.ts
 *      (which throws unless a real API key is configured or mock weather is
 *      explicitly allowed via ALLOW_MOCK_WEATHER=true). When weather is
 *      unavailable the forecast is history/trend-only and the row is marked
 *      weatherUsed=false.
 *
 * Participant recommendations rank users by historical verified compliance
 * (drResponses actualReduction vs targetReduction), asset flexibility
 * (battery capacity), and past no-shows. Outcomes are recorded back for the
 * feedback loop.
 */

import { getDb } from '../db';
import { sql, desc, eq } from 'drizzle-orm';
import {
  drEventForecasts,
  drParticipantRecommendations,
  DrEventForecastRow,
} from '../../drizzle/grid-intel-schema';
import { getWeatherForecast } from './weather-api';
import type { SqlRow } from '../sql-row';

export interface DayForecast {
  date: Date;
  weekday: number;
  likelihoodPercent: number;
  historyFrequencyPercent: number;
  demandTrendPercent: number | null;
  heatFactorPercent: number | null;
  weatherUsed: boolean;
  historyEventCount: number;
  forecastId: number;
}

export interface ParticipantRecommendationView {
  recommendationId: number;
  userId: number;
  rankPosition: number;
  score: number;
  compliancePercent: number | null; // null = no verified response history
  flexibilityKw: number;
  noShowCount: number;
  eventsResponded: number;
}

// Heat mapping constants: likelihood contribution ramps from 0 at 28°C to
// 100 at 40°C forecast daily-max temperature.
const HEAT_RAMP_MIN_C = 28;
const HEAT_RAMP_MAX_C = 40;
// History window for event-frequency statistics.
const HISTORY_DAYS = 180;
// Default forecast location (Dar es Salaam), consistent with
// server/ml/price-prediction.ts. Callers may override.
const DEFAULT_LAT = -6.7924;
const DEFAULT_LON = 39.2083;

export class DrForecastService {
  /**
   * Forecast DR-event likelihood for each of the next `days` days.
   * Persists one dr_event_forecasts row per day (audit trail of forecasts).
   */
  async getEventForecast(days: number = 7, location?: { lat: number; lon: number }): Promise<DayForecast[]> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // ---- Signal 1: event history by weekday + season (real query) ----
    const historyResult = await db.execute<SqlRow>(sql`
      SELECT (EXTRACT(ISODOW FROM "startTime") - 1) as weekday, EXTRACT(MONTH FROM "startTime") as month, COUNT(*) as count
      FROM "demandResponseEvents"
      WHERE "startTime" > (NOW() - (${HISTORY_DAYS} * INTERVAL '1 day'))
        AND status != 'cancelled'
      GROUP BY EXTRACT(ISODOW FROM "startTime"), EXTRACT(MONTH FROM "startTime")
    `);
    const historyRows: Array<{ weekday: number; month: number; count: number }> =
      (historyResult.rows || []).map((r: any) => ({
        weekday: Number(r.weekday), // ISODOW - 1: 0=Monday..6=Sunday
        month: Number(r.month),
        count: Number(r.count),
      }));

    // ---- Signal 2: aggregate demand trend from telemetry (real query) ----
    const trendResult = await db.execute<SqlRow>(sql`
      SELECT
        AVG(CASE WHEN t.timestamp > (NOW() - INTERVAL '7 day') THEN ABS(t.power) END) as recent_avg,
        AVG(CASE WHEN t.timestamp BETWEEN (NOW() - INTERVAL '28 day') AND (NOW() - INTERVAL '7 day') THEN ABS(t.power) END) as older_avg
      FROM telemetry t
      JOIN assets a ON a.id = t."assetId"
      WHERE t.power IS NOT NULL AND a."assetType" = 'meter'
        AND t.timestamp > (NOW() - INTERVAL '28 day')
    `);
    const trendRow = trendResult.rows[0] || {};
    let demandTrendPercent: number | null = null;
    if (trendRow.recent_avg !== null && trendRow.older_avg !== null && Number(trendRow.older_avg) > 0) {
      const trend = (Number(trendRow.recent_avg) - Number(trendRow.older_avg)) / Number(trendRow.older_avg);
      // Map ±20% trend to 0..100 with 50 = flat
      demandTrendPercent = Math.round(Math.max(0, Math.min(100, 50 + trend * 250)));
    }

    // ---- Signal 3: weather forecast heat (respects ALLOW_MOCK_WEATHER gate) ----
    const lat = location?.lat ?? DEFAULT_LAT;
    const lon = location?.lon ?? DEFAULT_LON;
    let dailyMaxTemp: Map<string, number> | null = null;
    try {
      const forecasts = await getWeatherForecast(lat, lon, days * 24);
      dailyMaxTemp = new Map();
      for (const f of forecasts) {
        const key = f.timestamp.toISOString().slice(0, 10);
        dailyMaxTemp.set(key, Math.max(dailyMaxTemp.get(key) ?? -Infinity, f.temperature));
      }
    } catch (error) {
      console.warn('[DrForecast] Weather forecast unavailable; using history/trend-only signals:', (error as any)?.message || error);
      dailyMaxTemp = null;
    }

    // ---- Combine per day ----
    const results: DayForecast[] = [];
    const now = new Date();

    for (let d = 1; d <= days; d++) {
      const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + d));
      const dateKey = date.toISOString().slice(0, 10);
      const month = date.getUTCMonth() + 1;
      // Convert JS getUTCDay (0=Sunday) to the 0=Monday weekday used above
      const isoWeekday = (date.getUTCDay() + 6) % 7;

      // Weekday frequency: events on this weekday / occurrences of this weekday in window
      const weekdayOccurrences = Math.floor(HISTORY_DAYS / 7);
      const weekdayEvents = historyRows.filter(r => r.weekday === isoWeekday).reduce((s, r) => s + r.count, 0);
      const weekdayRate = weekdayEvents / weekdayOccurrences;

      // Seasonal frequency: same weekday in the same calendar month across history
      const seasonalEvents = historyRows
        .filter(r => r.weekday === isoWeekday && r.month === month)
        .reduce((s, r) => s + r.count, 0);
      const seasonalOccurrences = Math.max(1, Math.floor(HISTORY_DAYS / 365));
      const seasonalRate = seasonalEvents / seasonalOccurrences;

      const historyEventCount = weekdayEvents;
      const rawFreq = seasonalEvents > 0
        ? 0.6 * weekdayRate + 0.4 * Math.min(1, seasonalRate)
        : weekdayRate;
      const historyFrequencyPercent = Math.round(Math.max(0, Math.min(100, rawFreq * 100)));

      // Heat factor for this day
      let heatFactorPercent: number | null = null;
      const weatherUsed = dailyMaxTemp !== null && dailyMaxTemp.has(dateKey);
      if (weatherUsed) {
        const maxTemp = dailyMaxTemp!.get(dateKey)!;
        heatFactorPercent = Math.round(
          Math.max(0, Math.min(100, ((maxTemp - HEAT_RAMP_MIN_C) / (HEAT_RAMP_MAX_C - HEAT_RAMP_MIN_C)) * 100))
        );
      }

      // Weighted combination across available signals only
      const signals: Array<{ value: number; weight: number }> = [{ value: historyFrequencyPercent, weight: 0.5 }];
      if (demandTrendPercent !== null) signals.push({ value: demandTrendPercent, weight: 0.25 });
      if (heatFactorPercent !== null) signals.push({ value: heatFactorPercent, weight: 0.25 });
      const totalWeight = signals.reduce((s, x) => s + x.weight, 0);
      const likelihoodPercent = Math.round(signals.reduce((s, x) => s + x.value * x.weight, 0) / totalWeight);

      const insertResult = await db.insert(drEventForecasts).values({
        forecastDate: date,
        weekday: isoWeekday,
        likelihoodPercent,
        historyFrequencyPercent,
        demandTrendPercent,
        heatFactorPercent,
        weatherUsed,
        historyEventCount,
        metadata: JSON.stringify({ location: { lat, lon }, historyDays: HISTORY_DAYS }),
      }).returning({ id: drEventForecasts.id });

      results.push({
        date,
        weekday: isoWeekday,
        likelihoodPercent,
        historyFrequencyPercent,
        demandTrendPercent,
        heatFactorPercent,
        weatherUsed,
        historyEventCount,
        forecastId: Number(insertResult[0].id),
      });
    }

    return results;
  }

  /**
   * Rank and persist an optimal participant set for a forecast/planned event.
   */
  async recommendParticipants(params: {
    targetReductionKw: number;
    eventId?: number;
    forecastId?: number;
    eventDate?: Date;
    maxParticipants?: number;
  }): Promise<{ recommendations: ParticipantRecommendationView[]; coverageKw: number; targetReductionKw: number; targetMet: boolean }> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');
    if (params.targetReductionKw <= 0) throw new Error('targetReductionKw must be positive');

    // Historical performance per user from real DR responses
    const perfResult = await db.execute<SqlRow>(sql`
      SELECT
        "userId",
        COUNT(*) as events_responded,
        SUM(CASE WHEN "targetReduction" > 0 AND "actualReduction" IS NOT NULL THEN "actualReduction" ELSE 0 END) as total_actual,
        SUM(CASE WHEN "targetReduction" > 0 AND "actualReduction" IS NOT NULL THEN "targetReduction" ELSE 0 END) as total_target,
        SUM(CASE WHEN "participationStatus" IN ('opted_in', 'auto_enrolled')
                  AND "completedAt" IS NOT NULL
                  AND ("actualReduction" IS NULL OR "actualReduction" < "targetReduction" * 0.25)
                 THEN 1 ELSE 0 END) as no_shows
      FROM "drResponses"
      GROUP BY "userId"
    `);
    const perfRows = (perfResult.rows || []) as any[];

    // Active DR enrollees (so users without history can still be considered)
    const enrolledResult = await db.execute<SqlRow>(sql`
      SELECT "userId", "maxReduction" FROM "drParticipants" WHERE status = 'active'
    `);
    const enrolledRows = (enrolledResult.rows || []) as any[];

    // Battery-backed flexibility per user from real assets
    const flexResult = await db.execute<SqlRow>(sql`
      SELECT "userId", COALESCE(SUM(capacity), 0) as battery_wh
      FROM assets
      WHERE "assetType" = 'battery' AND status = 'active'
      GROUP BY "userId"
    `);
    const batteryWhByUser = new Map<number, number>(
      (flexResult.rows || []).map((r: any) => [Number(r.userId), Number(r.battery_wh)])
    );

    const candidates = new Map<number, {
      userId: number;
      compliancePercent: number | null;
      noShowCount: number;
      eventsResponded: number;
      flexibilityKw: number;
      score: number;
    }>();

    const enrolledCap = new Map<number, number>();
    for (const r of enrolledRows) {
      enrolledCap.set(Number(r.userId), r.maxReduction !== null ? Number(r.maxReduction) : 0);
      if (!candidates.has(Number(r.userId))) {
        candidates.set(Number(r.userId), {
          userId: Number(r.userId),
          compliancePercent: null,
          noShowCount: 0,
          eventsResponded: 0,
          flexibilityKw: 0,
          score: 0,
        });
      }
    }

    for (const r of perfRows) {
      const userId = Number(r.userId);
      const eventsResponded = Number(r.events_responded);
      const totalTarget = Number(r.total_target || 0);
      const compliancePercent = totalTarget > 0
        ? Math.round((Number(r.total_actual || 0) / totalTarget) * 100)
        : null;
      candidates.set(userId, {
        userId,
        compliancePercent,
        noShowCount: Number(r.no_shows || 0),
        eventsResponded,
        flexibilityKw: 0,
        score: 0,
      });
    }

    for (const c of candidates.values()) {
      const batteryWh = batteryWhByUser.get(c.userId) ?? 0;
      // Flexibility: battery energy discharged over 2h, capped by enrolled max
      let flexKw = batteryWh / 1000 / 2;
      const cap = enrolledCap.get(c.userId);
      if (cap !== undefined && cap > 0) flexKw = Math.min(flexKw, cap);
      c.flexibilityKw = Math.round(flexKw * 10) / 10;

      const complianceScore = c.compliancePercent !== null ? c.compliancePercent : 25; // unproven ranks below verified
      const flexScore = Math.min(100, (c.flexibilityKw / params.targetReductionKw) * 100);
      const noShowRate = c.eventsResponded > 0 ? c.noShowCount / c.eventsResponded : 0;
      c.score = 0.5 * complianceScore + 0.3 * flexScore + 0.2 * (1 - noShowRate) * 100;
    }

    const ranked = [...candidates.values()]
      .filter(c => c.flexibilityKw > 0 || c.eventsResponded > 0)
      .sort((a, b) => b.score - a.score);

    const maxParticipants = params.maxParticipants ?? 50;
    const selected: typeof ranked = [];
    let coverageKw = 0;
    for (const c of ranked) {
      if (selected.length >= maxParticipants) break;
      if (coverageKw >= params.targetReductionKw) break;
      selected.push(c);
      coverageKw += c.flexibilityKw;
    }

    // Persist recommendations (feedback loop target)
    const views: ParticipantRecommendationView[] = [];
    for (let i = 0; i < selected.length; i++) {
      const c = selected[i];
      const insertResult = await db.insert(drParticipantRecommendations).values({
        forecastId: params.forecastId ?? null,
        eventId: params.eventId ?? null,
        recommendedForDate: params.eventDate ?? null,
        userId: c.userId,
        rankPosition: i + 1,
        scoreMilli: Math.round(c.score * 1000),
        compliancePercent: c.compliancePercent,
        flexibilityKw10: Math.round(c.flexibilityKw * 10),
        noShowCount: c.noShowCount,
        outcome: 'pending',
      }).returning({ id: drParticipantRecommendations.id });
      views.push({
        recommendationId: Number(insertResult[0].id),
        userId: c.userId,
        rankPosition: i + 1,
        score: Math.round(c.score * 100) / 100,
        compliancePercent: c.compliancePercent,
        flexibilityKw: c.flexibilityKw,
        noShowCount: c.noShowCount,
        eventsResponded: c.eventsResponded,
      });
    }

    console.log(`[DrForecast] Recommended ${views.length} participants covering ${coverageKw.toFixed(1)}kW of ${params.targetReductionKw}kW target`);

    return {
      recommendations: views,
      coverageKw: Math.round(coverageKw * 10) / 10,
      targetReductionKw: params.targetReductionKw,
      targetMet: coverageKw >= params.targetReductionKw,
    };
  }

  /**
   * Record the observed outcome for a recommendation (feedback loop).
   */
  async recordRecommendationOutcome(
    recommendationId: number,
    outcome: 'participated' | 'no_show' | 'declined'
  ) {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const rows = await db
      .select()
      .from(drParticipantRecommendations)
      .where(eq(drParticipantRecommendations.id, recommendationId))
      .limit(1);
    const rec = rows[0];
    if (!rec) throw new Error(`Recommendation ${recommendationId} not found`);
    if (rec.outcome !== 'pending') {
      throw new Error(`Recommendation ${recommendationId} outcome already recorded as '${rec.outcome}'`);
    }

    await db.execute<SqlRow>(sql`
      UPDATE dr_participant_recommendations SET
        outcome = ${outcome},
        outcome_recorded_at = NOW()
      WHERE id = ${recommendationId}
    `);

    const updated = await db
      .select()
      .from(drParticipantRecommendations)
      .where(eq(drParticipantRecommendations.id, recommendationId))
      .limit(1);
    return updated[0];
  }

  /** List recent forecasts (newest first). */
  async listForecasts(limit: number = 14): Promise<DrEventForecastRow[]> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');
    return db
      .select()
      .from(drEventForecasts)
      .orderBy(desc(drEventForecasts.createdAt))
      .limit(limit);
  }

  /** List recommendations, optionally for a specific event/forecast. */
  async listRecommendations(filter: { eventId?: number; forecastId?: number }, limit: number = 100) {
    const db = await getDb();
    if (!db) throw new Error('Database not available');
    let query = db.select().from(drParticipantRecommendations).$dynamic();
    if (filter.eventId !== undefined) {
      query = query.where(eq(drParticipantRecommendations.eventId, filter.eventId));
    } else if (filter.forecastId !== undefined) {
      query = query.where(eq(drParticipantRecommendations.forecastId, filter.forecastId));
    }
    return query.orderBy(desc(drParticipantRecommendations.createdAt)).limit(limit);
  }
}

export const drForecast = new DrForecastService();
