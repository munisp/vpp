/**
 * Regulator-Ready Compliance PDF Reports (feature 15)
 *
 * Compiles a date-ranged report from REAL platform data:
 *  - compliance_checks / compliance_rules (via the compliance-automation data model)
 *  - DR events + paid (verified) compensation (demandResponseEvents / drCompensation)
 *  - settlement ledger hash-chain verification (settlement-ledger.verifyChain)
 *  - blockchain anchor statuses (blockchain_anchors) with explicit honesty about
 *    `local_committed` anchors (local hash commitments, NOT real chain confirmations)
 *  - NTL detection summary (feature 13)
 *
 * The PDF is rendered with pdfkit through the existing shared helper
 * generatePDFReport (server/_core/export.ts) — the same generator the
 * scheduler's revenue/energy reports use. A deterministic SHA-256 checksum of
 * the canonical JSON source data is printed on the document and stored, so
 * regulators can verify integrity via getReportChecksum.
 */

import { createHash } from "crypto";
import { and, eq, gte, lte, desc, sql } from "drizzle-orm";
import { getDb } from "../db";
import { demandResponseEvents, drCompensation } from "../../drizzle/schema";
import { regulatorReports, type RegulatorReport } from "../../drizzle/trust-access-schema";
import { settlementLedger } from "./settlement-ledger";
import { getNtlSummaryForPeriod } from "./ntl-detection";
import { generatePDFReport } from "../_core/export";
import type { SqlRow } from '../sql-row';

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

export interface ReportSourceData {
  reportType: "regulator_compliance";
  periodStart: string;
  periodEnd: string;
  complianceChecks: {
    total: number;
    byStatus: Record<string, number>;
    byCategory: Record<string, number>;
    checks: Array<{
      ruleCode: string;
      ruleName: string;
      category: string;
      status: string;
      checkedAt: string;
      findingsCount: number;
    }>;
  };
  demandResponse: {
    eventsInPeriod: number;
    eventsByStatus: Record<string, number>;
    verifiedCompensation: {
      paidCount: number;
      totalPaidCents: number;
      byCurrency: Record<string, number>;
    };
  };
  settlementLedger: {
    chainValid: boolean;
    checkedCount: number;
    errorCount: number;
    errors: Array<{ sequenceNumber: number; error: string }>;
  };
  blockchainAnchors: {
    byStatus: Record<string, number>;
    localCommittedHonestyNote: string;
  };
  ntl: {
    totalFlags: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
  };
}

async function collectSourceData(periodStart: Date, periodEnd: Date): Promise<ReportSourceData> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // 1. Compliance checks in range (raw SQL per the compliance-automation data model)
  const checksResult = await db.execute<SqlRow>(sql`
    SELECT cc.id, cc.status, cc.checked_at, cc.findings,
           cr.rule_code, cr.rule_name, cr.rule_category
    FROM compliance_checks cc
    JOIN compliance_rules cr ON cr.id = cc.rule_id
    WHERE cc.checked_at >= ${periodStart} AND cc.checked_at <= ${periodEnd}
    ORDER BY cc.checked_at ASC
  `);
  const checkRows = (checksResult.rows || []) as Array<any>;

  const byStatus: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const checks: ReportSourceData["complianceChecks"]["checks"] = [];
  for (const row of checkRows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    byCategory[row.rule_category] = (byCategory[row.rule_category] ?? 0) + 1;
    let findingsCount = 0;
    try {
      findingsCount = Array.isArray(row.findings) ? row.findings.length : JSON.parse(row.findings || "[]").length;
    } catch {
      findingsCount = 0;
    }
    checks.push({
      ruleCode: row.rule_code,
      ruleName: row.rule_name,
      category: row.rule_category,
      status: row.status,
      checkedAt: new Date(row.checked_at).toISOString(),
      findingsCount,
    });
  }

  // 2. DR events + verified (paid) compensation
  const events = await db
    .select()
    .from(demandResponseEvents)
    .where(and(gte(demandResponseEvents.startTime, periodStart), lte(demandResponseEvents.startTime, periodEnd)));

  const eventsByStatus: Record<string, number> = {};
  for (const e of events) {
    eventsByStatus[e.status] = (eventsByStatus[e.status] ?? 0) + 1;
  }

  const compensation = await db
    .select()
    .from(drCompensation)
    .where(and(eq(drCompensation.status, "paid"), gte(drCompensation.createdAt, periodStart), lte(drCompensation.createdAt, periodEnd)));

  const byCurrency: Record<string, number> = {};
  let totalPaidCents = 0;
  for (const c of compensation) {
    totalPaidCents += c.amount;
    byCurrency[c.currency] = (byCurrency[c.currency] ?? 0) + c.amount;
  }

  // 3. Settlement ledger hash-chain verification (real verifyChain call)
  const chain = await settlementLedger.verifyChain();

  // 4. Blockchain anchor statuses (raw SQL per the blockchain-audit data model)
  const anchorsResult = await db.execute<SqlRow>(sql`
    SELECT status, COUNT(*) AS count
    FROM blockchain_anchors
    WHERE created_at >= ${periodStart} AND created_at <= ${periodEnd}
    GROUP BY status
  `);
  const anchorRows = (anchorsResult.rows || []) as Array<{ status: string; count: number }>;
  const anchorsByStatus: Record<string, number> = {};
  for (const row of anchorRows) {
    anchorsByStatus[row.status] = Number(row.count);
  }

  // 5. NTL detection summary (feature 13)
  const ntl = await getNtlSummaryForPeriod(periodStart, periodEnd);

  return {
    reportType: "regulator_compliance",
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    complianceChecks: {
      total: checkRows.length,
      byStatus,
      byCategory,
      checks,
    },
    demandResponse: {
      eventsInPeriod: events.length,
      eventsByStatus,
      verifiedCompensation: {
        paidCount: compensation.length,
        totalPaidCents,
        byCurrency,
      },
    },
    settlementLedger: {
      chainValid: chain.valid,
      checkedCount: chain.checkedCount,
      errorCount: chain.errors.length,
      errors: chain.errors,
    },
    blockchainAnchors: {
      byStatus: anchorsByStatus,
      localCommittedHonestyNote:
        "Anchors with status 'local_committed' were committed by the local hash provider only and are NOT independently confirmed on an external blockchain.",
    },
    ntl,
  };
}

function renderSourceDataToPdf(source: ReportSourceData, checksum: string): Promise<Buffer> {
  const fmtCents = (cents: number, currency: string) => `${currency} ${(cents / 100).toFixed(2)}`;
  const currencies = Object.entries(source.demandResponse.verifiedCompensation.byCurrency);
  const compLine = currencies.length > 0
    ? currencies.map(([cur, cents]) => fmtCents(cents, cur)).join(", ")
    : "none";

  return generatePDFReport({
    title: "Regulator Compliance Report",
    subtitle: `Period: ${source.periodStart.slice(0, 10)} to ${source.periodEnd.slice(0, 10)}`,
    sections: [
      {
        title: "1. Compliance Checks",
        content: [
          `Total checks in period: ${source.complianceChecks.total}`,
          `By status: ${Object.entries(source.complianceChecks.byStatus).map(([k, v]) => `${k}: ${v}`).join(", ") || "none"}`,
          `By category: ${Object.entries(source.complianceChecks.byCategory).map(([k, v]) => `${k}: ${v}`).join(", ") || "none"}`,
        ],
        table: source.complianceChecks.checks.length > 0
          ? {
              headers: ["Rule", "Category", "Status", "Findings", "Checked At"],
              rows: source.complianceChecks.checks.slice(0, 50).map((c) => [
                c.ruleCode,
                c.category,
                c.status,
                String(c.findingsCount),
                c.checkedAt.slice(0, 10),
              ]),
            }
          : undefined,
      },
      {
        title: "2. Demand Response Events & Verified Compensation",
        content: [
          `Events in period: ${source.demandResponse.eventsInPeriod}`,
          `Events by status: ${Object.entries(source.demandResponse.eventsByStatus).map(([k, v]) => `${k}: ${v}`).join(", ") || "none"}`,
          `Verified (paid) compensation records: ${source.demandResponse.verifiedCompensation.paidCount}`,
          `Total paid: ${compLine}`,
        ],
      },
      {
        title: "3. Settlement Ledger Integrity",
        content: [
          `Hash-chain verification result: ${source.settlementLedger.chainValid ? "VALID" : "INVALID"}`,
          `Events checked: ${source.settlementLedger.checkedCount}`,
          `Chain errors: ${source.settlementLedger.errorCount}`,
          ...source.settlementLedger.errors.slice(0, 10).map((e) => `  seq ${e.sequenceNumber}: ${e.error}`),
        ],
      },
      {
        title: "4. Blockchain Anchor Records",
        content: [
          `Anchors by status: ${Object.entries(source.blockchainAnchors.byStatus).map(([k, v]) => `${k}: ${v}`).join(", ") || "none"}`,
          source.blockchainAnchors.localCommittedHonestyNote,
        ],
      },
      {
        title: "5. Non-Technical Loss Summary",
        content: [
          `Flags raised in period: ${source.ntl.totalFlags}`,
          `By status: ${Object.entries(source.ntl.byStatus).map(([k, v]) => `${k}: ${v}`).join(", ") || "none"}`,
          `By type: ${Object.entries(source.ntl.byType).map(([k, v]) => `${k}: ${v}`).join(", ") || "none"}`,
        ],
      },
      {
        title: "6. Data Integrity Checksum",
        content: [
          `SHA-256 of canonical JSON source data:`,
          checksum,
          "Verify via the getReportChecksum endpoint: recompute SHA-256 over the stored canonical source JSON and compare with this value.",
        ],
      },
    ],
  });
}

/**
 * Generate a regulator compliance report: collect real data, checksum the
 * canonical JSON, render the PDF (pdfkit via the shared generator), persist
 * the report row, and return the PDF as base64.
 */
export async function generateReport(params: {
  generatedBy: number;
  periodStart: Date;
  periodEnd: Date;
}): Promise<{ reportId: number; checksum: string; pdfBase64: string }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  if (params.periodEnd <= params.periodStart) {
    throw new Error("periodEnd must be after periodStart");
  }

  const source = await collectSourceData(params.periodStart, params.periodEnd);
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

/** List previously generated reports (metadata only, newest first). */
export async function listReports(limit: number): Promise<
  Array<Pick<RegulatorReport, "id" | "generatedBy" | "periodStart" | "periodEnd" | "checksum" | "createdAt">>
> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({
      id: regulatorReports.id,
      generatedBy: regulatorReports.generatedBy,
      periodStart: regulatorReports.periodStart,
      periodEnd: regulatorReports.periodEnd,
      checksum: regulatorReports.checksum,
      createdAt: regulatorReports.createdAt,
    })
    .from(regulatorReports)
    .orderBy(desc(regulatorReports.createdAt))
    .limit(limit);
}

/**
 * Verify a stored report: recompute SHA-256 over the stored canonical source
 * JSON and compare with the recorded checksum.
 */
export async function getReportChecksum(reportId: number): Promise<{
  reportId: number;
  storedChecksum: string;
  recomputedChecksum: string;
  valid: boolean;
}> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = await db.select().from(regulatorReports).where(eq(regulatorReports.id, reportId)).limit(1);
  const report = rows[0];
  if (!report) throw new Error(`Report ${reportId} not found`);

  const recomputedChecksum = createHash("sha256").update(report.sourceJson).digest("hex");
  return {
    reportId,
    storedChecksum: report.checksum,
    recomputedChecksum,
    valid: recomputedChecksum === report.checksum,
  };
}
