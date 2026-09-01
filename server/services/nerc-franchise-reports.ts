/**
 * NERC Franchise / Regulatory Reporting Pack
 *
 * Compiles a date-ranged technical + commercial reporting pack for a licensed
 * Nigerian electricity franchise area (e.g. an IBEDC franchise, EKEDC estate
 * distribution) from REAL platform data only:
 *
 *  TECHNICAL
 *   - energy imported at boundary meters (kWh)  — telemetry deltas on assets
 *     of type 'meter' whose metadata JSON declares `"role": "boundary"`
 *     (also accepts "grid_import" / "import")
 *   - energy generated (kWh) — telemetry deltas on solar/generator/wind assets
 *   - energy distributed (kWh) — telemetry deltas on non-boundary 'meter' assets
 *   - distribution loss — computed ONLY when both boundary (import) and
 *     delivered energy exist in-period; otherwise null with reason
 *     'insufficient_meter_coverage'. Never an assumed percentage.
 *   - system availability % — hours with at least one telemetry reading over
 *     hours in the period (real coverage measurement; 0 means zero coverage)
 *   - peak demand (kW) — max power reading in period
 *   - supply interruptions — count of prepaid_supply_events 'disconnect'
 *     actions in period (the platform's real customer-supply event source),
 *     explicitly labelled as prepaid disconnections, not grid outage data.
 *
 *  COMMERCIAL
 *   - total billed (billings whose billing periodStart falls in the window;
 *     totalValue is in minor currency units → presented as NGN)
 *   - total collected (payments status 'completed' in window; NGN only for the
 *     headline figure, with a per-currency breakdown kept alongside)
 *   - collection efficiency = collected/billed, ONLY when billed > 0 — else
 *     null with reason 'no_billed_amount' (never NaN, never a silent 0)
 *   - active customer count — distinct userIds billed in the window
 *
 * Integrity: same pattern as compliance-reports.ts — the source data is
 * canonicalized (recursively key-sorted), SHA-256 checksummed, rendered to PDF
 * via the shared generatePDFReport helper, and persisted to the existing
 * `regulatorReports` table (the row shape fits: no schema change; the
 * reportType 'nerc_franchise' and franchiseAreaName live inside sourceJson,
 * and getReportChecksum verifies these rows unchanged).
 *
 * ANTI-MOCKWARE: every unknown is null + reason; every zero is a real
 * measurement. NERC categories the platform has no data source for are
 * omitted, not padded.
 */

import { createHash } from "crypto";
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "../db";
import { assets, billings, payments, telemetry } from "../../drizzle/schema";
import { prepaidSupplyEvents } from "../../drizzle/prepaid-schema";
import { regulatorReports } from "../../drizzle/trust-access-schema";
import { generatePDFReport } from "../_core/export";

/** Recursively sort object keys so identical data always serializes identically. */
function canonicalize(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc: Record<string, any>, key) => {
        acc[key] = canonicalize(value[key]);
        return acc;
      }, {});
  }
  return value;
}

/** A metric that is either a real measured value or null + machine-readable reason. */
export interface NullableMetric<T> {
  value: T | null;
  reason: string | null;
}

const measured = <T>(value: T): NullableMetric<T> => ({ value, reason: null });
const unknown = <T>(reason: string): NullableMetric<T> => ({ value: null, reason });

export const REASON_INSUFFICIENT_METER_COVERAGE = "insufficient_meter_coverage";
export const REASON_NO_BOUNDARY_METERS = "no_boundary_meters_configured";
export const REASON_NO_GENERATION_DATA = "no_metered_generation_data";
export const REASON_NO_POWER_READINGS = "no_power_readings";
export const REASON_NO_BILLED_AMOUNT = "no_billed_amount";
export const REASON_ZERO_IMPORT_ENERGY = "zero_import_energy";

export interface FranchiseSourceData {
  reportType: "nerc_franchise";
  franchiseAreaName: string;
  periodStart: string;
  periodEnd: string;
  technical: {
    energyImportedKwh: NullableMetric<number>;
    energyGeneratedKwh: NullableMetric<number>;
    energyDistributedKwh: NullableMetric<number>;
    distributionLossKwh: NullableMetric<number>;
    distributionLossPercent: NullableMetric<number>;
    systemAvailabilityPercent: number;
    availabilityEvidence: { hoursWithReadings: number; hoursInPeriod: number };
    peakDemandKw: NullableMetric<number>;
    supplyInterruptions: { count: number; source: string; note: string };
    metering: {
      assetsWithReadings: number;
      boundaryMeterAssetIds: number[];
      assetsWithInsufficientReadings: number[];
      assetsWithMeterReset: number[];
    };
  };
  commercial: {
    totalBilledNaira: number;
    billingCount: number;
    totalCollectedNaira: number;
    collectedPaymentCount: number;
    collectedByCurrencyNaira: Record<string, number>;
    collectionEfficiencyPercent: NullableMetric<number>;
    activeCustomerCount: number;
  };
  notes: string[];
}

const round = (v: number, dp: number): number => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

/** Asset metadata roles treated as boundary (grid import) meters. */
const BOUNDARY_ROLES = new Set(["boundary", "grid_import", "import"]);

function assetRole(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    const role = parsed?.role ?? parsed?.meterRole ?? null;
    return typeof role === "string" ? role.toLowerCase() : null;
  } catch {
    return null;
  }
}

interface TelemetryRow {
  assetId: number;
  timestamp: Date;
  power: number | null;
  energy: number | null;
  assetType: string;
  metadata: string | null;
}

async function collectSourceData(
  periodStart: Date,
  periodEnd: Date,
  franchiseAreaName: string
): Promise<FranchiseSourceData> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // 1a. Asset registry (classification comes from here, so a boundary meter
  //     with no in-window telemetry is still known to be configured).
  const assetRows = (await db
    .select({ id: assets.id, assetType: assets.assetType, metadata: assets.metadata })
    .from(assets)) as Array<{ id: number; assetType: string; metadata: string | null }>;

  const assetById = new Map(assetRows.map((a) => [a.id, a]));
  const isBoundaryAsset = (a: { assetType: string; metadata: string | null }) =>
    a.assetType === "meter" && BOUNDARY_ROLES.has(assetRole(a.metadata) ?? "");
  const configuredBoundaryIds = assetRows.filter(isBoundaryAsset).map((a) => a.id);

  // 1b. Telemetry in window, joined to assets for classification, in counter
  //     order per asset: meter-reset detection needs readings time-ordered.
  const rows = (await db
    .select({
      assetId: telemetry.assetId,
      timestamp: telemetry.timestamp,
      power: telemetry.power,
      energy: telemetry.energy,
      assetType: assets.assetType,
      metadata: assets.metadata,
    })
    .from(telemetry)
    .innerJoin(assets, eq(telemetry.assetId, assets.id))
    .where(and(gte(telemetry.timestamp, periodStart), lte(telemetry.timestamp, periodEnd)))
    .orderBy(asc(telemetry.assetId), asc(telemetry.timestamp))) as TelemetryRow[];

  // Per-asset cumulative-energy deltas (Wh): needs >= 2 non-null readings.
  // Readings are walked in time order; when the counter decreases, the meter
  // reset (or rolled over). The register's maximum is not recorded anywhere,
  // so the post-reset reading itself is counted as the delta across the reset
  // and the asset is flagged as reset-detected — honest accounting with the
  // rollover gap acknowledged, not a fabricated max-minus-min delta.
  const perAsset = new Map<
    number,
    { last: number | null; totalWh: number; readings: number; resets: number }
  >();
  const hoursWithReadings = new Set<number>();
  let peakPowerW: number | null = null;

  for (const r of rows) {
    const ts = new Date(r.timestamp);
    hoursWithReadings.add(Math.floor(ts.getTime() / 3_600_000));
    if (r.power != null && (peakPowerW == null || r.power > peakPowerW)) peakPowerW = r.power;
    if (r.energy == null) continue;
    const a = perAsset.get(r.assetId) ?? { last: null, totalWh: 0, readings: 0, resets: 0 };
    a.readings += 1;
    if (a.last !== null) {
      if (r.energy >= a.last) {
        a.totalWh += r.energy - a.last;
      } else {
        // Counter reset/rollover: the pre-reset tail (last -> register max) is
        // unknown, so count only what is evidenced — the post-reset reading.
        a.resets += 1;
        a.totalWh += r.energy;
      }
    }
    a.last = r.energy;
    perAsset.set(r.assetId, a);
  }

  const boundaryMeterAssetIds: number[] = [];
  const assetsWithInsufficientReadings: number[] = [];
  const assetsWithMeterReset: number[] = [];
  let importedWh = 0, generatedWh = 0, distributedWh = 0;
  let importOk = false, generatedOk = false, distributedOk = false;

  for (const [assetId, a] of perAsset) {
    const asset = assetById.get(assetId);
    if (!asset) continue; // join guarantees this; defensive only
    const isBoundary = isBoundaryAsset(asset);
    const isGeneration = asset.assetType === "solar" || asset.assetType === "generator" || asset.assetType === "wind";
    const isDeliveredMeter = asset.assetType === "meter" && !isBoundary;
    // Storage (battery) is bidirectional and excluded from energy accounting.
    if (!isBoundary && !isGeneration && !isDeliveredMeter) continue;
    if (isBoundary) boundaryMeterAssetIds.push(assetId);
    if (a.readings < 2) {
      assetsWithInsufficientReadings.push(assetId);
      continue;
    }
    if (a.resets > 0) {
      // Included in the totals with the evidenced post-reset energy; flagged
      // here so the reader knows the pre-reset tail is not in the figure.
      assetsWithMeterReset.push(assetId);
    }
    const delta = a.totalWh;
    if (isBoundary) { importedWh += delta; importOk = true; }
    else if (isGeneration) { generatedWh += delta; generatedOk = true; }
    else { distributedWh += delta; distributedOk = true; }
  }

  const energyImportedKwh = importOk
    ? measured(round(importedWh / 1000, 3))
    : unknown<number>(configuredBoundaryIds.length > 0 ? REASON_INSUFFICIENT_METER_COVERAGE : REASON_NO_BOUNDARY_METERS);
  const energyGeneratedKwh = generatedOk
    ? measured(round(generatedWh / 1000, 3))
    : unknown<number>(REASON_NO_GENERATION_DATA);
  const energyDistributedKwh = distributedOk
    ? measured(round(distributedWh / 1000, 3))
    : unknown<number>(REASON_INSUFFICIENT_METER_COVERAGE);

  let distributionLossKwh: NullableMetric<number>;
  let distributionLossPercent: NullableMetric<number>;
  if (energyImportedKwh.value == null || energyDistributedKwh.value == null) {
    distributionLossKwh = unknown<number>(REASON_INSUFFICIENT_METER_COVERAGE);
    distributionLossPercent = unknown<number>(REASON_INSUFFICIENT_METER_COVERAGE);
  } else {
    const lossKwh = round(energyImportedKwh.value - energyDistributedKwh.value, 3);
    distributionLossKwh = measured(lossKwh);
    distributionLossPercent = energyImportedKwh.value > 0
      ? measured(round((lossKwh / energyImportedKwh.value) * 100, 2))
      : unknown<number>(REASON_ZERO_IMPORT_ENERGY);
  }

  const hoursInPeriod = (periodEnd.getTime() - periodStart.getTime()) / 3_600_000;
  // Zero readings in the window is a real measurement: zero coverage.
  const systemAvailabilityPercent = hoursInPeriod > 0
    ? round(Math.min(100, (hoursWithReadings.size / hoursInPeriod) * 100), 2)
    : 0;

  const peakDemandKw = peakPowerW != null
    ? measured(round(peakPowerW / 1000, 3))
    : unknown<number>(REASON_NO_POWER_READINGS);

  // 2. Supply interruption events: prepaid disconnect actions are the
  //    platform's real customer-supply event source.
  const disconnectEvents = await db
    .select({ id: prepaidSupplyEvents.id })
    .from(prepaidSupplyEvents)
    .where(and(
      eq(prepaidSupplyEvents.action, "disconnect"),
      gte(prepaidSupplyEvents.createdAt, periodStart),
      lte(prepaidSupplyEvents.createdAt, periodEnd)
    ));

  // 3. Commercial: billings whose billing period starts inside the window.
  const billingRows = await db
    .select({ userId: billings.userId, totalValue: billings.totalValue })
    .from(billings)
    .where(and(gte(billings.periodStart, periodStart), lte(billings.periodStart, periodEnd)));

  let billedMinor = 0;
  const billedUsers = new Set<number>();
  for (const b of billingRows) {
    billedMinor += b.totalValue;
    billedUsers.add(b.userId);
  }
  const totalBilledNaira = round(billedMinor / 100, 2);

  const paymentRows = await db
    .select({ currency: payments.currency, amount: payments.amount })
    .from(payments)
    .where(and(
      eq(payments.status, "completed"),
      gte(payments.createdAt, periodStart),
      lte(payments.createdAt, periodEnd)
    ));

  let collectedNgnMinor = 0;
  let collectedNgnCount = 0;
  const byCurrencyMinor: Record<string, number> = {};
  for (const p of paymentRows) {
    byCurrencyMinor[p.currency] = (byCurrencyMinor[p.currency] ?? 0) + p.amount;
    if (p.currency === "NGN") {
      collectedNgnMinor += p.amount;
      collectedNgnCount += 1;
    }
  }
  const collectedByCurrencyNaira: Record<string, number> = {};
  for (const [cur, minor] of Object.entries(byCurrencyMinor)) {
    collectedByCurrencyNaira[cur] = round(minor / 100, 2);
  }
  const totalCollectedNaira = round(collectedNgnMinor / 100, 2);

  const collectionEfficiencyPercent = totalBilledNaira > 0
    ? measured(round((totalCollectedNaira / totalBilledNaira) * 100, 2))
    : unknown<number>(REASON_NO_BILLED_AMOUNT);

  return {
    reportType: "nerc_franchise",
    franchiseAreaName,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    technical: {
      energyImportedKwh,
      energyGeneratedKwh,
      energyDistributedKwh,
      distributionLossKwh,
      distributionLossPercent,
      systemAvailabilityPercent,
      availabilityEvidence: { hoursWithReadings: hoursWithReadings.size, hoursInPeriod },
      peakDemandKw,
      supplyInterruptions: {
        count: disconnectEvents.length,
        source: "prepaid_supply_events",
        note: "Count of prepaid account 'disconnect' supply events in the period. These are customer-level prepaid disconnections recorded by the platform, NOT grid outage/SAIFI measurements — no grid interruption event source exists on the platform.",
      },
      metering: {
        assetsWithReadings: perAsset.size,
        boundaryMeterAssetIds: boundaryMeterAssetIds.sort((a, b) => a - b),
        assetsWithInsufficientReadings: assetsWithInsufficientReadings.sort((a, b) => a - b),
        assetsWithMeterReset: assetsWithMeterReset.sort((a, b) => a - b),
      },
    },
    commercial: {
      totalBilledNaira,
      billingCount: billingRows.length,
      totalCollectedNaira,
      collectedPaymentCount: collectedNgnCount,
      collectedByCurrencyNaira,
      collectionEfficiencyPercent,
      activeCustomerCount: billedUsers.size,
    },
    notes: [
      "Billing rows carry no currency column; billed minor units are presented as NGN for this franchise pack.",
      "Headline collection figures cover NGN payments only; other currencies are itemised in collectedByCurrencyNaira and excluded from collection efficiency.",
      "Energy figures are cumulative-counter deltas summed per asset over the window in reading order; a counter decrease is treated as a meter reset/rollover, the post-reset reading is counted as the delta across the reset (the register maximum is not recorded, so the pre-reset tail is excluded), and the asset is flagged under technical.metering.assetsWithMeterReset. Assets with fewer than two energy readings are excluded and listed under technical.metering.",
    ],
  };
}

function fmtMetric(m: NullableMetric<number>, unit: string): string {
  return m.value == null ? `— (${m.reason})` : `${m.value} ${unit}`;
}

function renderSourceDataToPdf(source: FranchiseSourceData, checksum: string): Promise<Buffer> {
  const t = source.technical;
  const c = source.commercial;
  return generatePDFReport({
    title: "NERC Franchise Regulatory Report",
    subtitle: `Franchise Area: ${source.franchiseAreaName} — Period: ${source.periodStart.slice(0, 10)} to ${source.periodEnd.slice(0, 10)}`,
    sections: [
      {
        title: "1. Technical Performance",
        content: [
          `Energy imported (boundary meters): ${fmtMetric(t.energyImportedKwh, "kWh")}`,
          `Energy generated: ${fmtMetric(t.energyGeneratedKwh, "kWh")}`,
          `Energy distributed (metered delivery): ${fmtMetric(t.energyDistributedKwh, "kWh")}`,
          `Distribution loss: ${fmtMetric(t.distributionLossKwh, "kWh")} / ${fmtMetric(t.distributionLossPercent, "%")}`,
          `System availability: ${t.systemAvailabilityPercent}% (${t.availabilityEvidence.hoursWithReadings} of ${t.availabilityEvidence.hoursInPeriod} hours with telemetry)`,
          `Peak demand: ${fmtMetric(t.peakDemandKw, "kW")}`,
          `Supply interruptions (disconnect events): ${t.supplyInterruptions.count}`,
          `  ${t.supplyInterruptions.note}`,
        ],
      },
      {
        title: "2. Commercial Performance",
        content: [
          `Total billed: NGN ${c.totalBilledNaira.toLocaleString()} (${c.billingCount} billing rows)`,
          `Total collected (NGN, completed payments): NGN ${c.totalCollectedNaira.toLocaleString()} (${c.collectedPaymentCount} payments)`,
          `Collected by currency: ${Object.entries(c.collectedByCurrencyNaira).map(([cur, v]) => `${cur} ${v}`).join(", ") || "none"}`,
          `Collection efficiency: ${fmtMetric(c.collectionEfficiencyPercent, "%")}`,
          `Active customers (distinct billed accounts): ${c.activeCustomerCount}`,
        ],
      },
      {
        title: "3. Metering & Data Coverage Evidence",
        content: [
          `Assets with in-window readings: ${t.metering.assetsWithReadings}`,
          `Boundary meter asset ids: ${t.metering.boundaryMeterAssetIds.join(", ") || "none"}`,
          `Assets excluded (<2 energy readings): ${t.metering.assetsWithInsufficientReadings.join(", ") || "none"}`,
          `Assets with meter reset/rollover (post-reset reading counted, pre-reset tail unknown): ${t.metering.assetsWithMeterReset.join(", ") || "none"}`,
          ...source.notes.map((n) => `Note: ${n}`),
        ],
      },
      {
        title: "4. Data Integrity Checksum",
        content: [
          "SHA-256 of canonical JSON source data:",
          checksum,
          "Verify via the getReportChecksum endpoint: recompute SHA-256 over the stored canonical source JSON and compare with this value.",
        ],
      },
    ],
  });
}

/**
 * Generate a NERC franchise reporting pack: collect real data, checksum the
 * canonical JSON, render the PDF, persist the row, return the PDF as base64.
 */
export async function generateFranchiseReport(params: {
  generatedBy: number;
  periodStart: Date;
  periodEnd: Date;
  franchiseAreaName: string;
}): Promise<{ reportId: number; checksum: string; pdfBase64: string }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  if (!params.franchiseAreaName || params.franchiseAreaName.trim().length === 0) {
    throw new Error("franchiseAreaName is required");
  }
  if (params.periodEnd <= params.periodStart) {
    throw new Error("periodEnd must be after periodStart");
  }

  const source = await collectSourceData(params.periodStart, params.periodEnd, params.franchiseAreaName.trim());
  const sourceJson = JSON.stringify(canonicalize(source));
  const checksum = createHash("sha256").update(sourceJson).digest("hex");

  const pdfBuffer = await renderSourceDataToPdf(source, checksum);

  const insert = await db.insert(regulatorReports).values({
    generatedBy: params.generatedBy,
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
    checksum,
    sourceJson,
  }).returning({ id: regulatorReports.id });

  return {
    reportId: Number(insert[0].id),
    checksum,
    pdfBase64: pdfBuffer.toString("base64"),
  };
}

/**
 * List previously generated franchise reports (metadata only, newest first).
 * Franchise rows share the regulator_reports table with compliance reports;
 * they are distinguished by reportType inside the canonical sourceJson
 * (key-sorted, so the marker substring is stable).
 */
export async function listFranchiseReports(limit: number): Promise<
  Array<{
    id: number;
    generatedBy: number;
    periodStart: Date;
    periodEnd: Date;
    checksum: string;
    createdAt: Date;
    franchiseAreaName: string | null;
  }>
> {
  const db = await getDb();
  if (!db) return [];

  const rows = await db
    .select({
      id: regulatorReports.id,
      generatedBy: regulatorReports.generatedBy,
      periodStart: regulatorReports.periodStart,
      periodEnd: regulatorReports.periodEnd,
      checksum: regulatorReports.checksum,
      sourceJson: regulatorReports.sourceJson,
      createdAt: regulatorReports.createdAt,
    })
    .from(regulatorReports)
    .where(sql`${regulatorReports.sourceJson} LIKE '%"reportType":"nerc_franchise"%'`)
    .orderBy(desc(regulatorReports.createdAt))
    .limit(limit);

  return rows.map((r) => {
    let franchiseAreaName: string | null = null;
    try {
      const parsed = JSON.parse(r.sourceJson);
      if (typeof parsed?.franchiseAreaName === "string") franchiseAreaName = parsed.franchiseAreaName;
    } catch {
      franchiseAreaName = null;
    }
    return {
      id: r.id,
      generatedBy: r.generatedBy,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      checksum: r.checksum,
      createdAt: r.createdAt,
      franchiseAreaName,
    };
  });
}
