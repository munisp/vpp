/**
 * Green Button data export (innovation 16)
 *
 * Exports the requesting user's OWN usage (telemetry across their assets)
 * and billing rows for a period, as CSV or as an ESPI-flavored XML
 * envelope. Every row in the document is a real `telemetry` or `billings`
 * row; nothing is interpolated, gap-filled or synthesized.
 *
 * Job lifecycle: a job is persisted as `queued`, assembled, then marked
 * `ready` with real row counts and a SHA-256 checksum of the content, or
 * `failed` with the reason. A period that contains no data completes as
 * `ready` with zero rows and `empty: true` — an honest empty answer, with
 * headers only, never fabricated readings.
 */

import { createHash } from 'crypto';
import { and, asc, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { getDb } from '../db';
import { assets, billings, telemetry } from '../../drizzle/schema';
import {
  exportJobs,
  type ExportJobFormat,
  type ExportJobRow,
  type ExportJobScope,
} from '../../drizzle/innov3-control-schema';

/** Hard cap on rows per section so one export cannot exhaust memory. */
const MAX_ROWS_PER_SECTION = 200_000;

export class ExportJobError extends Error {}

interface TelemetryRow {
  assetId: number;
  assetName: string;
  assetType: string;
  timestamp: Date;
  power: number | null;
  energy: number | null;
  stateOfCharge: number | null;
  voltage: number | null;
  frequency: number | null;
}

interface BillingRow {
  id: number;
  billingType: string;
  periodStart: Date;
  periodEnd: Date;
  consumptionKwh: number;
  generationKwh: number;
  exportKwh: number;
  totalValue: number;
  consumerShare: number;
  status: string;
}

async function collectTelemetryRows(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  userId: number,
  periodStart: Date,
  periodEnd: Date
): Promise<TelemetryRow[]> {
  const userAssets = await db
    .select({ id: assets.id, name: assets.name, assetType: assets.assetType })
    .from(assets)
    .where(eq(assets.userId, userId));
  if (userAssets.length === 0) return [];
  const byId = new Map(userAssets.map((a) => [a.id, a]));

  const rows = await db
    .select({
      assetId: telemetry.assetId,
      timestamp: telemetry.timestamp,
      power: telemetry.power,
      energy: telemetry.energy,
      stateOfCharge: telemetry.stateOfCharge,
      voltage: telemetry.voltage,
      frequency: telemetry.frequency,
    })
    .from(telemetry)
    .where(
      and(
        inArray(telemetry.assetId, userAssets.map((a) => a.id)),
        gte(telemetry.timestamp, periodStart),
        lte(telemetry.timestamp, periodEnd)
      )
    )
    .orderBy(asc(telemetry.timestamp))
    .limit(MAX_ROWS_PER_SECTION);

  return rows.map((r) => ({
    assetId: r.assetId,
    assetName: byId.get(r.assetId)?.name ?? '',
    assetType: byId.get(r.assetId)?.assetType ?? '',
    timestamp: r.timestamp,
    power: r.power,
    energy: r.energy,
    stateOfCharge: r.stateOfCharge,
    voltage: r.voltage,
    frequency: r.frequency,
  }));
}

async function collectBillingRows(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  userId: number,
  periodStart: Date,
  periodEnd: Date
): Promise<BillingRow[]> {
  // A billing row belongs to the export when its billing period overlaps the
  // requested period.
  const rows = await db
    .select()
    .from(billings)
    .where(
      and(
        eq(billings.userId, userId),
        lte(billings.periodStart, periodEnd),
        gte(billings.periodEnd, periodStart)
      )
    )
    .orderBy(asc(billings.periodStart))
    .limit(MAX_ROWS_PER_SECTION);
  return rows.map((r) => ({
    id: r.id,
    billingType: r.billingType,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    consumptionKwh: r.consumptionKwh,
    generationKwh: r.generationKwh,
    exportKwh: r.exportKwh,
    totalValue: r.totalValue,
    consumerShare: r.consumerShare,
    status: r.status,
  }));
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function renderCsv(params: {
  scope: ExportJobScope;
  periodStart: Date;
  periodEnd: Date;
  telemetryRows: TelemetryRow[];
  billingRows: BillingRow[];
}): string {
  const lines: string[] = [];
  lines.push(`# Green Button export, period ${params.periodStart.toISOString()} to ${params.periodEnd.toISOString()}`);
  lines.push('# Every row below is a real telemetry or billing record. No values are estimated or interpolated.');

  if (params.scope === 'usage' || params.scope === 'both') {
    lines.push('# section: telemetry (power in watts, energy in cumulative watt-hours, state_of_charge in percent x 100)');
    lines.push('asset_id,asset_name,asset_type,timestamp,power_w,energy_wh,state_of_charge_x100,voltage_mv,frequency_mhz');
    for (const r of params.telemetryRows) {
      lines.push(
        [
          String(r.assetId),
          csvEscape(r.assetName),
          r.assetType,
          r.timestamp.toISOString(),
          r.power ?? '',
          r.energy ?? '',
          r.stateOfCharge ?? '',
          r.voltage ?? '',
          r.frequency ?? '',
        ].join(',')
      );
    }
  }

  if (params.scope === 'billing' || params.scope === 'both') {
    lines.push('# section: billings (amounts in cents)');
    lines.push('billing_id,billing_type,period_start,period_end,consumption_kwh,generation_kwh,export_kwh,total_value_cents,consumer_share_cents,status');
    for (const r of params.billingRows) {
      lines.push(
        [
          String(r.id),
          r.billingType,
          r.periodStart.toISOString(),
          r.periodEnd.toISOString(),
          String(r.consumptionKwh),
          String(r.generationKwh),
          String(r.exportKwh),
          String(r.totalValue),
          String(r.consumerShare),
          r.status,
        ].join(',')
      );
    }
  }

  return lines.join('\n') + '\n';
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * An ESPI-flavored envelope: the espi namespace and the
 * IntervalBlock/IntervalReading/timePeriod structure (times as epoch
 * seconds, per the ESPI convention), with billing rows carried in a
 * clearly-marked extension element. It is not asserted to be a
 * schema-validated ESPI document — it is a portable envelope around the
 * same real rows the CSV carries.
 */
function renderEspiXml(params: {
  scope: ExportJobScope;
  periodStart: Date;
  periodEnd: Date;
  telemetryRows: TelemetryRow[];
  billingRows: BillingRow[];
}): string {
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(`<!-- Green Button export. Every reading is a real telemetry or billing row; nothing is estimated. -->`);
  out.push(`<espi:UsageData xmlns:espi="http://naesb.org/espi" generatedAt="${new Date().toISOString()}">`);
  out.push(`  <espi:ExportPeriod>`);
  out.push(`    <espi:start>${Math.floor(params.periodStart.getTime() / 1000)}</espi:start>`);
  out.push(`    <espi:end>${Math.floor(params.periodEnd.getTime() / 1000)}</espi:end>`);
  out.push(`  </espi:ExportPeriod>`);

  if (params.scope === 'usage' || params.scope === 'both') {
    const byAsset = new Map<number, TelemetryRow[]>();
    for (const r of params.telemetryRows) {
      const list = byAsset.get(r.assetId) ?? [];
      list.push(r);
      byAsset.set(r.assetId, list);
    }
    for (const [assetId, rows] of byAsset) {
      const first = rows[0];
      out.push(`  <espi:UsagePoint>`);
      out.push(`    <espi:ServiceCategory kind="0"/>`);
      out.push(`    <espi:Asset id="${assetId}" name="${xmlEscape(first?.assetName ?? '')}" type="${xmlEscape(first?.assetType ?? '')}"/>`);
      out.push(`    <espi:MeterReading>`);
      out.push(`      <espi:ReadingType accumulationBehaviour="3" uom="38"/>`); // delta-less readings, watts (uom 38)
      out.push(`      <espi:IntervalBlock>`);
      for (const r of rows) {
        out.push(`        <espi:IntervalReading>`);
        out.push(`          <espi:timePeriod><espi:start>${Math.floor(r.timestamp.getTime() / 1000)}</espi:start><espi:duration>0</espi:duration></espi:timePeriod>`);
        if (r.power !== null) out.push(`          <espi:value>${r.power}</espi:value>`);
        if (r.energy !== null) out.push(`          <espi:cumulativeWh>${r.energy}</espi:cumulativeWh>`);
        if (r.stateOfCharge !== null) out.push(`          <espi:stateOfChargeX100>${r.stateOfCharge}</espi:stateOfChargeX100>`);
        out.push(`        </espi:IntervalReading>`);
      }
      out.push(`      </espi:IntervalBlock>`);
      out.push(`    </espi:MeterReading>`);
      out.push(`  </espi:UsagePoint>`);
    }
  }

  if (params.scope === 'billing' || params.scope === 'both') {
    out.push(`  <espi:BillingSummaries>`);
    for (const r of params.billingRows) {
      out.push(`    <espi:BillingSummary id="${r.id}" status="${xmlEscape(r.status)}" billingType="${xmlEscape(r.billingType)}">`);
      out.push(`      <espi:billingPeriod>`);
      out.push(`        <espi:start>${Math.floor(r.periodStart.getTime() / 1000)}</espi:start>`);
      out.push(`        <espi:end>${Math.floor(r.periodEnd.getTime() / 1000)}</espi:end>`);
      out.push(`      </espi:billingPeriod>`);
      out.push(`      <espi:consumptionKwh>${r.consumptionKwh}</espi:consumptionKwh>`);
      out.push(`      <espi:generationKwh>${r.generationKwh}</espi:generationKwh>`);
      out.push(`      <espi:exportKwh>${r.exportKwh}</espi:exportKwh>`);
      out.push(`      <espi:totalValueCents>${r.totalValue}</espi:totalValueCents>`);
      out.push(`      <espi:consumerShareCents>${r.consumerShare}</espi:consumerShareCents>`);
      out.push(`    </espi:BillingSummary>`);
    }
    out.push(`  </espi:BillingSummaries>`);
  }

  out.push(`</espi:UsageData>`);
  return out.join('\n') + '\n';
}

/**
 * Create and run an export job. The job row is the durable record of the
 * lifecycle: queued first, then ready (with row counts, checksum and the
 * content) or failed (with the reason). Assembly runs inline, so the
 * returned job is already in its terminal state.
 */
export async function requestExport(
  userId: number,
  params: { periodStart: Date; periodEnd: Date; format: ExportJobFormat; scope: ExportJobScope }
): Promise<ExportJobRow> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  if (!(params.periodEnd > params.periodStart)) {
    throw new ExportJobError('periodEnd must be after periodStart');
  }

  const inserted = await db
    .insert(exportJobs)
    .values({
      userId,
      periodStart: params.periodStart,
      periodEnd: params.periodEnd,
      format: params.format,
      scope: params.scope,
      status: 'queued',
    })
    .returning();
  const job = inserted[0];

  try {
    const telemetryRows =
      params.scope === 'billing'
        ? []
        : await collectTelemetryRows(db, userId, params.periodStart, params.periodEnd);
    const billingRows =
      params.scope === 'usage'
        ? []
        : await collectBillingRows(db, userId, params.periodStart, params.periodEnd);

    const content =
      params.format === 'csv'
        ? renderCsv({ scope: params.scope, periodStart: params.periodStart, periodEnd: params.periodEnd, telemetryRows, billingRows })
        : renderEspiXml({ scope: params.scope, periodStart: params.periodStart, periodEnd: params.periodEnd, telemetryRows, billingRows });

    const checksum = createHash('sha256').update(content, 'utf8').digest('hex');
    const empty = telemetryRows.length + billingRows.length === 0;

    const updated = await db
      .update(exportJobs)
      .set({
        status: 'ready',
        telemetryRowCount: params.scope === 'billing' ? null : telemetryRows.length,
        billingRowCount: params.scope === 'usage' ? null : billingRows.length,
        empty,
        content,
        checksum,
        byteSize: Buffer.byteLength(content, 'utf8'),
        completedAt: new Date(),
      })
      .where(eq(exportJobs.id, job.id))
      .returning();
    return updated[0];
  } catch (error: any) {
    const reason = typeof error?.message === 'string' ? error.message.slice(0, 500) : 'assembly failed';
    await db
      .update(exportJobs)
      .set({ status: 'failed', failureReason: reason, completedAt: new Date() })
      .where(eq(exportJobs.id, job.id));
    throw new ExportJobError(`Export ${job.id} failed: ${reason}`);
  }
}

/** List the user's own export jobs, newest first (metadata only). */
export async function listExports(userId: number, limit: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({
      id: exportJobs.id,
      periodStart: exportJobs.periodStart,
      periodEnd: exportJobs.periodEnd,
      format: exportJobs.format,
      scope: exportJobs.scope,
      status: exportJobs.status,
      telemetryRowCount: exportJobs.telemetryRowCount,
      billingRowCount: exportJobs.billingRowCount,
      empty: exportJobs.empty,
      checksum: exportJobs.checksum,
      byteSize: exportJobs.byteSize,
      failureReason: exportJobs.failureReason,
      queuedAt: exportJobs.queuedAt,
      completedAt: exportJobs.completedAt,
    })
    .from(exportJobs)
    .where(eq(exportJobs.userId, userId))
    .orderBy(desc(exportJobs.createdAt))
    .limit(limit);
}

/**
 * Fetch a job the user owns. Ownership is enforced here: an export only
 * ever leaves the platform to the user whose rows it contains.
 */
export async function getExport(userId: number, jobId: number): Promise<ExportJobRow> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const rows = await db
    .select()
    .from(exportJobs)
    .where(and(eq(exportJobs.id, jobId), eq(exportJobs.userId, userId)))
    .limit(1);
  const job = rows[0];
  if (!job) throw new ExportJobError(`Export ${jobId} not found`);
  return job;
}

/** Download a ready job's content as base64 plus its checksum. */
export async function downloadExport(
  userId: number,
  jobId: number
): Promise<{ jobId: number; format: ExportJobFormat; checksum: string; byteSize: number; empty: boolean; contentBase64: string; filename: string }> {
  const job = await getExport(userId, jobId);
  if (job.status !== 'ready' || job.content === null || job.checksum === null) {
    throw new ExportJobError(
      job.status === 'failed'
        ? `Export ${jobId} failed: ${job.failureReason ?? 'unknown reason'}`
        : `Export ${jobId} is not ready (status: ${job.status})`
    );
  }
  const ext = job.format === 'csv' ? 'csv' : 'xml';
  return {
    jobId: job.id,
    format: job.format,
    checksum: job.checksum,
    byteSize: job.byteSize ?? Buffer.byteLength(job.content, 'utf8'),
    empty: job.empty ?? false,
    contentBase64: Buffer.from(job.content, 'utf8').toString('base64'),
    filename: `green-button-export-${job.id}.${ext}`,
  };
}
