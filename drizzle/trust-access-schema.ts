import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, boolean } from "drizzle-orm/mysql-core";

/**
 * Trust & Access Schema
 *
 * Tables backing five platform features:
 *  1. sms_command_log       - inbound SMS command channel audit (feature 11)
 *  2. ntl_flags             - non-technical-loss (theft/bypass) flags (feature 13)
 *  3. price_alert_market_scopes - country/priceType extension for the EXISTING
 *     price_alerts table (which lacks market scope columns; companion table so
 *     the existing schema file stays untouched) (feature 14)
 *  4. price_alert_dispatch_log  - per-dispatch audit of the price alert engine (feature 14)
 *  5. regulator_reports     - regulator-ready compliance PDF reports + checksums (feature 15)
 *
 * NOTE: `compliance_reports` already exists (used by compliance-automation.ts),
 * so the PDF report table is deliberately named `regulator_reports`.
 */

/**
 * SMS Command Log - every inbound SMS command and its reply.
 * Phone -> user resolution is recorded via `resolvedVia` for auditability.
 */
export const smsCommandLog = mysqlTable("sms_command_log", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId"), // null when the phone number could not be resolved
  phoneNumber: varchar("phoneNumber", { length: 20 }).notNull(),
  resolvedVia: mysqlEnum("resolvedVia", ["users_phone", "payments_phone", "unresolved"]).notNull(),
  direction: mysqlEnum("direction", ["inbound"]).default("inbound").notNull(),
  rawText: text("rawText").notNull(),
  parsedCommand: varchar("parsedCommand", { length: 32 }).notNull(), // BALANCE|STATUS|TOKEN_LAST|OUTAGE|HELP|UNKNOWN
  replyText: text("replyText"),
  replySent: boolean("replySent").default(false).notNull(),
  replyError: text("replyError"),
  providerMessageId: varchar("providerMessageId", { length: 100 }), // Africa's Talking message id when present
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type SmsCommandLog = typeof smsCommandLog.$inferSelect;
export type InsertSmsCommandLog = typeof smsCommandLog.$inferInsert;

/**
 * NTL Flags - non-technical-loss (theft/bypass) detection results.
 * Status workflow is deliberately human-in-the-loop: suspected ->
 * under_review -> confirmed | cleared. The engine never auto-accuses users.
 */
export const ntlFlags = mysqlTable("ntl_flags", {
  id: int("id").autoincrement().primaryKey(),
  assetId: int("assetId").notNull(),
  userId: int("userId").notNull(),
  flagType: mysqlEnum("flagType", ["divergence", "bypass_signature", "combined"]).notNull(),
  status: mysqlEnum("status", ["suspected", "under_review", "confirmed", "cleared"]).default("suspected").notNull(),
  riskScore: int("riskScore").notNull(), // 0-100 composite score
  evidence: text("evidence").notNull(), // JSON: z-scores, ratios, window stats, bypass-pattern details
  windowStart: timestamp("windowStart").notNull(),
  windowEnd: timestamp("windowEnd").notNull(),
  investigatedBy: int("investigatedBy"),
  investigatedAt: timestamp("investigatedAt"),
  resolutionNotes: text("resolutionNotes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type NtlFlag = typeof ntlFlags.$inferSelect;
export type InsertNtlFlag = typeof ntlFlags.$inferInsert;

/**
 * Price Alert Market Scopes - 1:1 companion to the existing price_alerts table,
 * adding the genuinely-missing market scope (country + priceType) without
 * modifying the existing schema file.
 */
export const priceAlertMarketScopes = mysqlTable("price_alert_market_scopes", {
  id: int("id").autoincrement().primaryKey(),
  priceAlertId: int("priceAlertId").notNull().unique(),
  country: mysqlEnum("country", ["nigeria", "tanzania"]).notNull(),
  priceType: mysqlEnum("priceType", ["off_peak", "shoulder", "peak", "super_peak"]).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type PriceAlertMarketScope = typeof priceAlertMarketScopes.$inferSelect;
export type InsertPriceAlertMarketScope = typeof priceAlertMarketScopes.$inferInsert;

/**
 * Price Alert Dispatch Log - one row per evaluation-cycle dispatch attempt,
 * recording the observed price and per-channel delivery results.
 */
export const priceAlertDispatchLog = mysqlTable("price_alert_dispatch_log", {
  id: int("id").autoincrement().primaryKey(),
  priceAlertId: int("priceAlertId").notNull(),
  userId: int("userId").notNull(),
  country: mysqlEnum("country", ["nigeria", "tanzania"]).notNull(),
  priceType: mysqlEnum("priceType", ["off_peak", "shoulder", "peak", "super_peak"]).notNull(),
  observedPrice: int("observedPrice").notNull(), // cents per kWh that triggered the alert
  pushSent: boolean("pushSent").default(false).notNull(),
  smsSent: boolean("smsSent").default(false).notNull(),
  smsTo: varchar("smsTo", { length: 20 }),
  error: text("error"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type PriceAlertDispatchLog = typeof priceAlertDispatchLog.$inferSelect;
export type InsertPriceAlertDispatchLog = typeof priceAlertDispatchLog.$inferInsert;

/**
 * Regulator Reports - compiled, date-ranged compliance PDF reports.
 * `sourceJson` is the canonical JSON the PDF was rendered from; `checksum` is
 * its deterministic SHA-256 (also printed on the document) so regulators can
 * verify integrity via getReportChecksum.
 */
export const regulatorReports = mysqlTable("regulator_reports", {
  id: int("id").autoincrement().primaryKey(),
  generatedBy: int("generatedBy").notNull(),
  periodStart: timestamp("periodStart").notNull(),
  periodEnd: timestamp("periodEnd").notNull(),
  checksum: varchar("checksum", { length: 64 }).notNull(), // SHA-256 hex of sourceJson
  sourceJson: text("sourceJson").notNull(), // canonical JSON source data
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type RegulatorReport = typeof regulatorReports.$inferSelect;
export type InsertRegulatorReport = typeof regulatorReports.$inferInsert;
