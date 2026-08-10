/**
 * AI Energy Advisor Service
 *
 * Assembles the user's REAL energy context (telemetry sums over a trailing
 * window, trade/payment/billing aggregates) and asks the platform LLM
 * (server/_core/llm.ts invokeLLM) for personalized saving recommendations
 * and a weekly digest. When the LLM is unavailable or errors, the computed
 * facts are returned with `llmAvailable: false` plus rule-based tips that
 * are derived strictly from the real numbers. No figure is ever invented.
 *
 * Responses are cached per user for 1 hour: Redis when reachable via
 * server/integration/redis-cache.ts, otherwise an in-memory Map with TTL.
 */

import { and, asc, desc, eq, gte, inArray } from 'drizzle-orm';
import { getDb } from '../db';
import { assets, billings, payments, telemetry, trades } from '../../drizzle/schema';
import { energyAdvisorReports } from '../../drizzle/innovations-schema';
import { invokeLLM } from '../_core/llm';
import { redisCache } from '../integration/redis-cache';

const CACHE_TTL_SECONDS = 3600; // 1 hour
const MAX_SAMPLES_PER_ASSET = 50000; // guard against unbounded scans
const GAP_CAP_MS = 60 * 60 * 1000; // ignore energy accrual across telemetry gaps > 1h

export type AdvisorKind = 'recommendations' | 'weekly_digest';

export interface AdvisorFacts {
  windowDays: number;
  periodStart: string;
  periodEnd: string;
  assets: {
    total: number;
    solar: number;
    battery: number;
    meter: number;
    solarCapacityW: number;
    batteryCapacityWh: number;
  };
  solarGenerationWh: number | null;
  solarSamples: number;
  meterImportWh: number | null;
  batteryThroughputWh: number | null;
  energyMethod: 'cumulative_delta' | 'power_integral' | 'mixed' | 'unavailable';
  trades30d: {
    executedExportWh: number;
    executedImportWh: number;
    p2pSoldWh: number;
    p2pBoughtWh: number;
    exportRevenueCents: number;
    importCostCents: number;
    executedCount: number;
  };
  selfConsumptionRatio: number | null; // (generation - export) / generation
  payments30d: {
    completedCount: number;
    completedAmountCents: number;
    failedCount: number;
  };
  latestBilling: {
    periodStart: string;
    periodEnd: string;
    generationKwh: number;
    consumptionKwh: number;
    exportKwh: number;
    totalValueCents: number;
    status: string;
  } | null;
}

export interface AdvisorResult {
  kind: AdvisorKind;
  facts: AdvisorFacts;
  llmAvailable: boolean;
  llmModel: string | null;
  llmError: string | null;
  recommendations: string[];
  ruleBasedTips: string[];
  digest: string | null;
  reportId: number | null;
  cached: boolean;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// In-memory fallback cache (per-process), used when Redis is unreachable.
// ---------------------------------------------------------------------------
const memoryCache = new Map<string, { value: AdvisorResult; expiresAt: number }>();

async function cacheGet(key: string): Promise<AdvisorResult | null> {
  try {
    const fromRedis = await redisCache.get<AdvisorResult>(key);
    if (fromRedis) return { ...fromRedis, cached: true };
  } catch {
    // Redis unreachable — fall through to in-memory cache
  }
  const hit = memoryCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return { ...hit.value, cached: true };
  if (hit) memoryCache.delete(key);
  return null;
}

async function cacheSet(key: string, value: AdvisorResult): Promise<void> {
  memoryCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 });
  try {
    await redisCache.set(key, value, CACHE_TTL_SECONDS);
  } catch {
    // Redis unreachable — in-memory copy already stored
  }
}

// ---------------------------------------------------------------------------
// Real energy computation from telemetry.
// Prefers the cumulative `energy` counter (Wh); falls back to integrating
// instantaneous `power` over actual sample intervals (gaps > 1h excluded).
// ---------------------------------------------------------------------------
interface TelemetrySample {
  timestamp: Date;
  power: number | null;
  energy: number | null;
}

function computeEnergyWh(samples: TelemetrySample[]): { wh: number | null; method: 'cumulative_delta' | 'power_integral' | 'unavailable' } {
  if (samples.length === 0) return { wh: null, method: 'unavailable' };

  const withEnergy = samples.filter(s => s.energy !== null);
  if (withEnergy.length >= 2) {
    const first = withEnergy[0].energy!;
    const last = withEnergy[withEnergy.length - 1].energy!;
    if (last >= first) return { wh: last - first, method: 'cumulative_delta' };
    // Counter reset detected — fall through to power integration.
  }

  let wh = 0;
  let used = 0;
  for (let i = 0; i < samples.length - 1; i++) {
    const p = samples[i].power;
    if (p === null) continue;
    const dtMs = new Date(samples[i + 1].timestamp).getTime() - new Date(samples[i].timestamp).getTime();
    if (dtMs <= 0 || dtMs > GAP_CAP_MS) continue;
    wh += (p * dtMs) / 3600000;
    used++;
  }
  if (used === 0) return { wh: null, method: 'unavailable' };
  return { wh: Math.round(wh), method: 'power_integral' };
}

function computeSignedEnergyWh(samples: TelemetrySample[]): { importWh: number | null; exportWh: number | null; throughputWh: number | null } {
  let importWh = 0;
  let exportWh = 0;
  let used = 0;
  for (let i = 0; i < samples.length - 1; i++) {
    const p = samples[i].power;
    if (p === null) continue;
    const dtMs = new Date(samples[i + 1].timestamp).getTime() - new Date(samples[i].timestamp).getTime();
    if (dtMs <= 0 || dtMs > GAP_CAP_MS) continue;
    const wh = (p * dtMs) / 3600000;
    if (wh >= 0) importWh += wh; else exportWh += -wh;
    used++;
  }
  if (used === 0) return { importWh: null, exportWh: null, throughputWh: null };
  return { importWh: Math.round(importWh), exportWh: Math.round(exportWh), throughputWh: Math.round(importWh + exportWh) };
}

// ---------------------------------------------------------------------------
// Context assembly — every number below comes from a real query.
// ---------------------------------------------------------------------------
export async function gatherAdvisorFacts(userId: number, windowDays: number): Promise<AdvisorFacts> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - windowDays * 86400000);

  const userAssets = await db.select().from(assets).where(eq(assets.userId, userId));
  const solarAssets = userAssets.filter(a => a.assetType === 'solar');
  const batteryAssets = userAssets.filter(a => a.assetType === 'battery');
  const meterAssets = userAssets.filter(a => a.assetType === 'meter');

  const methods = new Set<string>();
  let solarGenerationWh: number | null = null;
  let solarSamples = 0;
  for (const asset of solarAssets) {
    const samples = await db
      .select({ timestamp: telemetry.timestamp, power: telemetry.power, energy: telemetry.energy })
      .from(telemetry)
      .where(and(eq(telemetry.assetId, asset.id), gte(telemetry.timestamp, periodStart)))
      .orderBy(asc(telemetry.timestamp))
      .limit(MAX_SAMPLES_PER_ASSET);
    solarSamples += samples.length;
    const r = computeEnergyWh(samples);
    if (r.wh !== null) {
      solarGenerationWh = (solarGenerationWh ?? 0) + r.wh;
      methods.add(r.method);
    }
  }

  let meterImportWh: number | null = null;
  for (const asset of meterAssets) {
    const samples = await db
      .select({ timestamp: telemetry.timestamp, power: telemetry.power, energy: telemetry.energy })
      .from(telemetry)
      .where(and(eq(telemetry.assetId, asset.id), gte(telemetry.timestamp, periodStart)))
      .orderBy(asc(telemetry.timestamp))
      .limit(MAX_SAMPLES_PER_ASSET);
    const r = computeEnergyWh(samples);
    if (r.wh !== null) {
      meterImportWh = (meterImportWh ?? 0) + r.wh;
      methods.add(r.method);
    }
  }

  let batteryThroughputWh: number | null = null;
  for (const asset of batteryAssets) {
    const samples = await db
      .select({ timestamp: telemetry.timestamp, power: telemetry.power, energy: telemetry.energy })
      .from(telemetry)
      .where(and(eq(telemetry.assetId, asset.id), gte(telemetry.timestamp, periodStart)))
      .orderBy(asc(telemetry.timestamp))
      .limit(MAX_SAMPLES_PER_ASSET);
    const r = computeSignedEnergyWh(samples);
    if (r.throughputWh !== null) {
      batteryThroughputWh = (batteryThroughputWh ?? 0) + r.throughputWh;
      methods.add('power_integral');
    }
  }

  // Trade aggregates over the window (executed only).
  const windowTrades = await db
    .select({
      tradeType: trades.tradeType,
      energy: trades.energy,
      totalAmount: trades.totalAmount,
    })
    .from(trades)
    .where(and(eq(trades.userId, userId), eq(trades.status, 'executed'), gte(trades.timestamp, periodStart)));

  const tradeAgg = {
    executedExportWh: 0,
    executedImportWh: 0,
    p2pSoldWh: 0,
    p2pBoughtWh: 0,
    exportRevenueCents: 0,
    importCostCents: 0,
    executedCount: windowTrades.length,
  };
  for (const t of windowTrades) {
    if (t.tradeType === 'export') {
      tradeAgg.executedExportWh += t.energy;
      tradeAgg.exportRevenueCents += t.totalAmount;
    } else if (t.tradeType === 'import') {
      tradeAgg.executedImportWh += t.energy;
      tradeAgg.importCostCents += t.totalAmount;
    } else if (t.tradeType === 'p2p_sell') {
      tradeAgg.p2pSoldWh += t.energy;
      tradeAgg.exportRevenueCents += t.totalAmount;
    } else if (t.tradeType === 'p2p_buy') {
      tradeAgg.p2pBoughtWh += t.energy;
      tradeAgg.importCostCents += t.totalAmount;
    }
  }

  // Self-consumption ratio from real generation and real measured export.
  let selfConsumptionRatio: number | null = null;
  if (solarGenerationWh !== null && solarGenerationWh > 0) {
    const ratio = (solarGenerationWh - tradeAgg.executedExportWh) / solarGenerationWh;
    // If trades imply more export than generation, data sources disagree —
    // report null rather than a misleading number.
    selfConsumptionRatio = ratio >= 0 && ratio <= 1 ? Math.round(ratio * 1000) / 1000 : null;
  }

  // Payment aggregates over the window.
  const windowPayments = await db
    .select({ status: payments.status, amount: payments.amount })
    .from(payments)
    .where(and(eq(payments.userId, userId), gte(payments.createdAt, periodStart)));
  const paymentAgg = { completedCount: 0, completedAmountCents: 0, failedCount: 0 };
  for (const p of windowPayments) {
    if (p.status === 'completed') {
      paymentAgg.completedCount++;
      paymentAgg.completedAmountCents += p.amount;
    } else if (p.status === 'failed') {
      paymentAgg.failedCount++;
    }
  }

  // Most recent billing record.
  const [latestBill] = await db
    .select()
    .from(billings)
    .where(eq(billings.userId, userId))
    .orderBy(desc(billings.periodEnd))
    .limit(1);

  return {
    windowDays,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    assets: {
      total: userAssets.length,
      solar: solarAssets.length,
      battery: batteryAssets.length,
      meter: meterAssets.length,
      solarCapacityW: solarAssets.reduce((s, a) => s + a.capacity, 0),
      batteryCapacityWh: batteryAssets.reduce((s, a) => s + a.capacity, 0),
    },
    solarGenerationWh,
    solarSamples,
    meterImportWh,
    batteryThroughputWh,
    energyMethod: methods.size === 0 ? 'unavailable' : methods.size === 1 ? ([...methods][0] as AdvisorFacts['energyMethod']) : 'mixed',
    trades30d: tradeAgg,
    selfConsumptionRatio,
    payments30d: paymentAgg,
    latestBilling: latestBill
      ? {
          periodStart: latestBill.periodStart.toISOString(),
          periodEnd: latestBill.periodEnd.toISOString(),
          generationKwh: latestBill.generationKwh,
          consumptionKwh: latestBill.consumptionKwh,
          exportKwh: latestBill.exportKwh,
          totalValueCents: latestBill.totalValue,
          status: latestBill.status,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Rule-based tips — every tip embeds the real computed numbers it derives
// from; thresholds are heuristic triggers, not fabricated data.
// ---------------------------------------------------------------------------
export function buildRuleBasedTips(facts: AdvisorFacts): string[] {
  const tips: string[] = [];
  const kwh = (wh: number) => (wh / 1000).toFixed(1);

  if (facts.assets.total === 0) {
    tips.push('No energy assets are registered on your account yet, so no personalized energy advice can be computed. Register a solar, battery or meter asset to unlock telemetry-based recommendations.');
    return tips;
  }

  if (facts.solarGenerationWh === null && facts.assets.solar > 0) {
    tips.push(`Your ${facts.assets.solar} solar asset(s) reported no usable telemetry in the last ${facts.windowDays} days — check device connectivity so generation can be tracked.`);
  }

  if (facts.selfConsumptionRatio !== null && facts.solarGenerationWh !== null) {
    const pct = Math.round(facts.selfConsumptionRatio * 100);
    if (facts.selfConsumptionRatio < 0.5) {
      tips.push(`Only ${pct}% of your ${kwh(facts.solarGenerationWh)} kWh solar generation was self-consumed this period (${kwh(facts.trades30d.executedExportWh)} kWh was exported). Shifting flexible loads (water heating, charging) into daylight hours would raise self-consumption.`);
    } else {
      tips.push(`You self-consumed ${pct}% of your ${kwh(facts.solarGenerationWh)} kWh solar generation this period — a strong ratio.`);
    }
  }

  if (facts.assets.battery > 0 && facts.batteryThroughputWh === 0) {
    tips.push('Your battery recorded no charge/discharge activity in this window — verify it is enabled in your trading preferences so it can arbitrage peak/off-peak prices.');
  } else if (facts.assets.battery > 0 && facts.batteryThroughputWh !== null && facts.batteryThroughputWh > 0) {
    tips.push(`Your battery cycled ${kwh(facts.batteryThroughputWh)} kWh of throughput this period. Charging during off-peak tariffs and discharging at peak maximizes its value.`);
  }

  if (facts.trades30d.exportRevenueCents > 0) {
    tips.push(`Executed energy sales earned you ${(facts.trades30d.exportRevenueCents / 100).toFixed(2)} in your account currency across ${facts.trades30d.executedCount} executed trades this window.`);
  }

  if (facts.trades30d.p2pSoldWh === 0 && facts.trades30d.p2pBoughtWh === 0 && facts.solarGenerationWh !== null && facts.solarGenerationWh > 0) {
    tips.push('You have not used peer-to-peer trading this period — listing surplus solar on the P2P market can earn more than grid export when peer demand is high.');
  }

  if (facts.payments30d.failedCount > 0) {
    tips.push(`${facts.payments30d.failedCount} payment(s) failed in the last ${facts.windowDays} days — resolving them avoids service interruption.`);
  }

  if (tips.length === 0) {
    tips.push('Telemetry coverage is too thin for specific advice yet; keep devices online and check back once more data has accumulated.');
  }
  return tips;
}

// ---------------------------------------------------------------------------
// LLM generation with honest fallback.
// ---------------------------------------------------------------------------
async function generateWithLLM(kind: AdvisorKind, facts: AdvisorFacts): Promise<{
  llmAvailable: boolean;
  llmModel: string | null;
  llmError: string | null;
  recommendations: string[] | null;
  digest: string | null;
}> {
  const instruction =
    kind === 'weekly_digest'
      ? 'You are an energy advisor for a solar/battery prosumer in East Africa on a virtual power plant platform. Given the user\'s REAL measured data for the last 7 days (JSON below), write a short weekly digest: a 2-4 sentence narrative summary plus up to 5 concrete, numbered recommendations. Use ONLY the numbers provided — never invent figures. Respond as JSON: {"digest": string, "recommendations": string[]}.'
      : 'You are an energy advisor for a solar/battery prosumer in East Africa on a virtual power plant platform. Given the user\'s REAL measured data (JSON below), produce up to 5 concrete, personalized saving recommendations. Every recommendation must reference the actual numbers provided — never invent figures. Respond as JSON: {"recommendations": string[], "digest": string}.';

  try {
    const result = await invokeLLM({
      messages: [
        { role: 'system', content: instruction },
        { role: 'user', content: JSON.stringify(facts) },
      ],
      responseFormat: { type: 'json_object' },
    });

    const content = result.choices?.[0]?.message?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(c => (c.type === 'text' ? c.text : '')).join('') : '';
    const parsed = JSON.parse(text) as { recommendations?: unknown; digest?: unknown };
    const recommendations = Array.isArray(parsed.recommendations)
      ? parsed.recommendations.filter((r): r is string => typeof r === 'string')
      : null;
    const digest = typeof parsed.digest === 'string' ? parsed.digest : null;

    if (!recommendations || recommendations.length === 0) {
      return { llmAvailable: false, llmModel: result.model ?? null, llmError: 'LLM returned no usable recommendations', recommendations: null, digest };
    }
    return { llmAvailable: true, llmModel: result.model ?? null, llmError: null, recommendations, digest };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[EnergyAdvisor] LLM unavailable, falling back to rule-based tips:', message);
    return { llmAvailable: false, llmModel: null, llmError: message, recommendations: null, digest: null };
  }
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------
export async function getAdvice(userId: number, kind: AdvisorKind, opts?: { bypassCache?: boolean }): Promise<AdvisorResult> {
  const windowDays = kind === 'weekly_digest' ? 7 : 30;
  const cacheKey = `energy-advisor:${userId}:${kind}`;

  if (!opts?.bypassCache) {
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;
  }

  const facts = await gatherAdvisorFacts(userId, windowDays);
  const ruleBasedTips = buildRuleBasedTips(facts);
  const llm = await generateWithLLM(kind, facts);

  const recommendations = llm.llmAvailable && llm.recommendations ? llm.recommendations : ruleBasedTips;
  const digest = llm.digest ?? (kind === 'weekly_digest'
    ? `Last 7 days: solar generation ${facts.solarGenerationWh !== null ? (facts.solarGenerationWh / 1000).toFixed(1) + ' kWh' : 'unavailable'}, self-consumption ${facts.selfConsumptionRatio !== null ? Math.round(facts.selfConsumptionRatio * 100) + '%' : 'unavailable'}, ${facts.trades30d.executedCount} executed trades, ${facts.payments30d.failedCount} failed payments.`
    : null);

  // Persist the report; failure to persist does not fail the request.
  let reportId: number | null = null;
  try {
    const db = await getDb();
    if (db) {
      const insert = await db.insert(energyAdvisorReports).values({
        userId,
        kind,
        periodStart: new Date(facts.periodStart),
        periodEnd: new Date(facts.periodEnd),
        facts: facts as unknown as Record<string, unknown>,
        llmAvailable: llm.llmAvailable,
        llmModel: llm.llmModel,
        llmError: llm.llmError,
        recommendations,
        ruleBasedTips,
        digest,
      });
      reportId = Number((insert as any)[0]?.insertId ?? (insert as any).insertId ?? 0) || null;
    }
  } catch (error) {
    console.error('[EnergyAdvisor] Failed to persist report:', error);
  }

  const result: AdvisorResult = {
    kind,
    facts,
    llmAvailable: llm.llmAvailable,
    llmModel: llm.llmModel,
    llmError: llm.llmError,
    recommendations,
    ruleBasedTips,
    digest,
    reportId,
    cached: false,
    generatedAt: new Date().toISOString(),
  };

  await cacheSet(cacheKey, result);
  return result;
}

export async function listReports(userId: number, limit: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  return db
    .select()
    .from(energyAdvisorReports)
    .where(eq(energyAdvisorReports.userId, userId))
    .orderBy(desc(energyAdvisorReports.createdAt))
    .limit(limit);
}
