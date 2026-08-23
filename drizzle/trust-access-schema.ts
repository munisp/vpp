import {
  boolean,
  integer as int,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const priceAlertDispatchLogPriceTypeEnum = pgEnum("price_alert_dispatch_log_price_type", ["off_peak", "shoulder", "peak", "super_peak"]);
export const priceAlertDispatchLogCountryEnum = pgEnum("price_alert_dispatch_log_country", ["nigeria", "tanzania"]);
export const priceAlertMarketScopesPriceTypeEnum = pgEnum("price_alert_market_scopes_price_type", ["off_peak", "shoulder", "peak", "super_peak"]);
export const priceAlertMarketScopesCountryEnum = pgEnum("price_alert_market_scopes_country", ["nigeria", "tanzania"]);
export const ntlFlagsStatusEnum = pgEnum("ntl_flags_status", ["suspected", "under_review", "confirmed", "cleared"]);
export const ntlFlagsFlagTypeEnum = pgEnum("ntl_flags_flag_type", ["divergence", "bypass_signature", "combined"]);
export const smsCommandLogDirectionEnum = pgEnum("sms_command_log_direction", ["inbound"]);
export const smsCommandLogResolvedViaEnum = pgEnum("sms_command_log_resolved_via", ["users_phone", "payments_phone", "unresolved"]);


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
export const smsCommandLog = pgTable("sms_command_log", {
  id: serial("id").primaryKey(),
  userId: int("userId"), // null when the phone number could not be resolved
  phoneNumber: varchar("phoneNumber", { length: 20 }).notNull(),
  resolvedVia: smsCommandLogResolvedViaEnum("resolvedVia").notNull(),
  direction: smsCommandLogDirectionEnum("direction").default("inbound").notNull(),
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
export const ntlFlags = pgTable("ntl_flags", {
  id: serial("id").primaryKey(),
  assetId: int("assetId").notNull(),
  userId: int("userId").notNull(),
  flagType: ntlFlagsFlagTypeEnum("flagType").notNull(),
  status: ntlFlagsStatusEnum("status").default("suspected").notNull(),
  riskScore: int("riskScore").notNull(), // 0-100 composite score
  evidence: text("evidence").notNull(), // JSON: z-scores, ratios, window stats, bypass-pattern details
  windowStart: timestamp("windowStart").notNull(),
  windowEnd: timestamp("windowEnd").notNull(),
  investigatedBy: int("investigatedBy"),
  investigatedAt: timestamp("investigatedAt"),
  resolutionNotes: text("resolutionNotes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type NtlFlag = typeof ntlFlags.$inferSelect;
export type InsertNtlFlag = typeof ntlFlags.$inferInsert;

/**
 * Price Alert Market Scopes - 1:1 companion to the existing price_alerts table,
 * adding the genuinely-missing market scope (country + priceType) without
 * modifying the existing schema file.
 */
export const priceAlertMarketScopes = pgTable("price_alert_market_scopes", {
  id: serial("id").primaryKey(),
  priceAlertId: int("priceAlertId").notNull().unique(),
  country: priceAlertMarketScopesCountryEnum("country").notNull(),
  priceType: priceAlertMarketScopesPriceTypeEnum("priceType").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type PriceAlertMarketScope = typeof priceAlertMarketScopes.$inferSelect;
export type InsertPriceAlertMarketScope = typeof priceAlertMarketScopes.$inferInsert;

/**
 * Price Alert Dispatch Log - one row per evaluation-cycle dispatch attempt,
 * recording the observed price and per-channel delivery results.
 */
export const priceAlertDispatchLog = pgTable("price_alert_dispatch_log", {
  id: serial("id").primaryKey(),
  priceAlertId: int("priceAlertId").notNull(),
  userId: int("userId").notNull(),
  country: priceAlertDispatchLogCountryEnum("country").notNull(),
  priceType: priceAlertDispatchLogPriceTypeEnum("priceType").notNull(),
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
export const regulatorReports = pgTable("regulator_reports", {
  id: serial("id").primaryKey(),
  generatedBy: int("generatedBy").notNull(),
  periodStart: timestamp("periodStart").notNull(),
  periodEnd: timestamp("periodEnd").notNull(),
  checksum: varchar("checksum", { length: 64 }).notNull(), // SHA-256 hex of sourceJson
  sourceJson: text("sourceJson").notNull(), // canonical JSON source data
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type RegulatorReport = typeof regulatorReports.$inferSelect;
export type InsertRegulatorReport = typeof regulatorReports.$inferInsert;
