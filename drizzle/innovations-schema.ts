import {
  boolean,
  integer as int,
  json,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const carbonCertificatesStatusEnum = pgEnum("carbon_certificates_status", ["minted", "retired"]);
export const carbonCertificatesEmissionFactorSourceEnum = pgEnum("carbon_certificates_emission_factor_source", ["live"]);
export const dynamicTariffsStatusEnum = pgEnum("dynamic_tariffs_status", ["published", "superseded"]);
export const dynamicTariffsCountryEnum = pgEnum("dynamic_tariffs_country", ["nigeria", "tanzania"]);
export const energyAdvisorReportsKindEnum = pgEnum("energy_advisor_reports_kind", ["recommendations", "weekly_digest"]);


/**
 * Innovations schema — tables backing the five innovation features:
 *  1. AI Energy Advisor        -> energy_advisor_reports
 *  2. Dynamic tariff engine    -> dynamic_tariffs
 *  3. Battery health analytics -> battery_health_snapshots
 *  4. P2P order-book matching  -> p2p_matches
 *  5. Carbon credit tracking   -> carbon_certificates
 *
 * Follows the multi-file schema pattern (see trading-strategies-schema.ts).
 * Column names are camelCase to match drizzle/schema.ts core tables.
 */

/**
 * AI Energy Advisor reports — persisted record of every generated
 * recommendation set / weekly digest, including the exact computed facts
 * the advice was derived from and whether the LLM was available.
 */
export const energyAdvisorReports = pgTable("energy_advisor_reports", {
  id: serial("id").primaryKey(),
  userId: int("userId").notNull(),
  kind: energyAdvisorReportsKindEnum("kind").notNull(),
  periodStart: timestamp("periodStart").notNull(),
  periodEnd: timestamp("periodEnd").notNull(),

  // The real computed context the advice is based on (telemetry sums,
  // trade/payment aggregates). Null-valued fields mean "no data".
  facts: json("facts").$type<Record<string, unknown>>().notNull(),

  llmAvailable: boolean("llmAvailable").notNull(),
  llmModel: varchar("llmModel", { length: 100 }),
  llmError: text("llmError"),

  // Final recommendations shown to the user (LLM-generated when
  // llmAvailable=true, otherwise the rule-based tips).
  recommendations: json("recommendations").$type<string[]>().notNull(),
  ruleBasedTips: json("ruleBasedTips").$type<string[]>().notNull(),
  digest: text("digest"), // narrative text (weekly digest or LLM summary)

  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type EnergyAdvisorReport = typeof energyAdvisorReports.$inferSelect;
export type InsertEnergyAdvisorReport = typeof energyAdvisorReports.$inferInsert;

/**
 * Dynamic tariffs — versioned, append-only publication of computed
 * time-of-use tariffs. History is never overwritten: publishing a new
 * version supersedes the previous one.
 */
export const dynamicTariffs = pgTable("dynamic_tariffs", {
  id: serial("id").primaryKey(),
  country: dynamicTariffsCountryEnum("country").notNull(),
  version: int("version").notNull(),
  status: dynamicTariffsStatusEnum("status").default("published").notNull(),
  effectiveFrom: timestamp("effectiveFrom").notNull(),

  // 24 hourly entries computed from real marketPrices history +
  // demandResponseEvents grid stress.
  periods: json("periods").$type<Array<{
    hourStart: string; // ISO timestamp
    band: "off_peak" | "shoulder" | "peak";
    basePriceCentsPerKwh: number | null; // null = no market data for that hour
    interpolated: boolean;
    gridStressMultiplier: number;
    finalPriceCentsPerKwh: number | null; // null when base is null
    overlappingDrEvents: number;
  }>>().notNull(),

  // Provenance of the learned price profile.
  learnedFrom: json("learnedFrom").$type<{
    windowDays: number;
    sampleCount: number;
    hoursCovered: number;
    p33CentsPerKwh: number | null;
    p67CentsPerKwh: number | null;
  }>().notNull(),

  publishedBy: int("publishedBy").notNull(), // admin user id
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type DynamicTariff = typeof dynamicTariffs.$inferSelect;
export type InsertDynamicTariff = typeof dynamicTariffs.$inferInsert;

/**
 * Battery health snapshots — point-in-time analytics computed from real
 * SoC/power telemetry for a battery asset.
 */
export const batteryHealthSnapshots = pgTable("battery_health_snapshots", {
  id: serial("id").primaryKey(),
  assetId: int("assetId").notNull(),
  userId: int("userId").notNull(),

  windowStart: timestamp("windowStart"), // first telemetry sample used
  windowEnd: timestamp("windowEnd"),     // last telemetry sample used
  sampleCount: int("sampleCount").notNull(),

  // Full-cycle equivalents * 1000 (milli-cycles), from cumulative |dSoC|/20000.
  fullCycleEquivalentsMilli: int("fullCycleEquivalentsMilli"),

  // Measured round-trip efficiency, percent * 100 (null when no charge or
  // discharge energy was observed).
  roundTripEfficiencyPct100: int("roundTripEfficiencyPct100"),

  // Estimated state of health, percent * 100, relative to the battery's own
  // best observed weekly efficiency (null when not estimable).
  estimatedSohPct100: int("estimatedSohPct100"),

  // Weekly degradation slope of round-trip efficiency, percent-points per
  // week * 100 (negative = degrading). Null when <2 usable weeks.
  weeklyDegradationSlopePct100: int("weeklyDegradationSlopePct100"),

  chargeEnergyWh: int("chargeEnergyWh"),
  dischargeEnergyWh: int("dischargeEnergyWh"),

  warrantyRisk: boolean("warrantyRisk").default(false).notNull(),
  warrantyRiskReasons: json("warrantyRiskReasons").$type<string[]>().notNull(),

  insufficientData: boolean("insufficientData").default(false).notNull(),
  computedAt: timestamp("computedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type BatteryHealthSnapshot = typeof batteryHealthSnapshots.$inferSelect;
export type InsertBatteryHealthSnapshot = typeof batteryHealthSnapshots.$inferInsert;

/**
 * P2P matches — execution records produced by the order-book matcher.
 * Each row links a p2p_buy and a p2p_sell row from the trades table for a
 * (possibly partial) fill.
 */
export const p2pMatches = pgTable("p2p_matches", {
  id: serial("id").primaryKey(),
  buyOrderId: int("buyOrderId").notNull(),  // trades.id of the p2p_buy leg
  sellOrderId: int("sellOrderId").notNull(), // trades.id of the p2p_sell leg
  buyerId: int("buyerId").notNull(),
  sellerId: int("sellerId").notNull(),
  energyWh: int("energyWh").notNull(),
  priceCentsPerKwh: int("priceCentsPerKwh").notNull(), // maker (resting order) price
  totalAmountCents: int("totalAmountCents").notNull(),
  executedAt: timestamp("executedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type P2pMatch = typeof p2pMatches.$inferSelect;
export type InsertP2pMatch = typeof p2pMatches.$inferInsert;

export const p2pSettlementsStateEnum = pgEnum("p2p_settlements_state", [
  "buyer_paid_seller_unpaid",
  "delivery_evidenced",
  "complete",
  "unresolved",
]);

export const p2pSettlementsDeliveryEnum = pgEnum("p2p_settlements_delivery", [
  "unmeasured",
  "unverified",
  "measured",
  "not_delivered",
]);

export const p2pSettlementsPayoutEnum = pgEnum("p2p_settlements_payout", [
  "unavailable_no_provider",
  "requested",
  "evidenced",
]);

export const p2pSettlementsReconciliationEnum = pgEnum("p2p_settlements_reconciliation", [
  "pending",
  "matched",
  "mismatch",
]);

/**
 * P2P settlement records — the independent evidence trail for a trade, kept
 * outside the trade rows it settles so that reconciliation never compares a
 * record against itself.
 *
 * Every money and energy claim here names the evidence behind it: a payment
 * confirmed by the provider, energy measured from telemetry, a payout the
 * platform can prove it made. A settlement reaches 'complete' only when all
 * three exist; until then its state says which one is missing.
 */
export const p2pSettlements = pgTable("p2p_settlements", {
  id: serial("id").primaryKey(),
  buyTradeId: int("buyTradeId").notNull().unique(), // trades.id of the p2p_buy leg
  sellTradeId: int("sellTradeId"),
  buyerId: int("buyerId").notNull(),
  sellerId: int("sellerId").notNull(),
  energyWh: int("energyWh").notNull(),
  amountCents: int("amountCents").notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),

  // Buyer payment evidence: the provider's own reference, not our row id.
  buyerPaymentId: int("buyerPaymentId"),
  buyerPaymentReference: varchar("buyerPaymentReference", { length: 191 }),
  buyerPaidAt: timestamp("buyerPaidAt"),

  // Energy delivery evidence, measured from telemetry.
  delivery: p2pSettlementsDeliveryEnum("delivery").default("unmeasured").notNull(),
  deliveredEnergyWh: int("deliveredEnergyWh"),
  deliverySamples: int("deliverySamples"),
  deliveryMeasuredAt: timestamp("deliveryMeasuredAt"),
  deliveryNote: text("deliveryNote"),

  // Seller payout evidence.
  sellerPayout: p2pSettlementsPayoutEnum("sellerPayout")
    .default("unavailable_no_provider")
    .notNull(),
  sellerPayoutReference: varchar("sellerPayoutReference", { length: 191 }),
  sellerPaidAt: timestamp("sellerPaidAt"),

  state: p2pSettlementsStateEnum("state").notNull(),
  reconciliation: p2pSettlementsReconciliationEnum("reconciliation")
    .default("pending")
    .notNull(),
  reconciliationNote: text("reconciliationNote"),
  reconciledAt: timestamp("reconciledAt"),

  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

export type P2pSettlement = typeof p2pSettlements.$inferSelect;
export type InsertP2pSettlement = typeof p2pSettlements.$inferInsert;

/**
 * Carbon certificates — one certificate minted per 100 kWh of verified
 * solar generation. certificateHash is a deterministic SHA-256 over the
 * certificate's factual fields, enabling public verification.
 */
export const carbonCertificates = pgTable("carbon_certificates", {
  id: serial("id").primaryKey(),
  userId: int("userId").notNull(),
  sequence: int("sequence").notNull(), // per-user mint sequence (1-based)
  certificateHash: varchar("certificateHash", { length: 64 }).notNull().unique(),

  region: varchar("region", { length: 50 }).notNull(),
  energyWh: int("energyWh").notNull(), // always 100_000 (100 kWh) per certificate
  emissionFactorGramsPerKwh: int("emissionFactorGramsPerKwh").notNull(), // DB-backed factor used
  emissionFactorSource: carbonCertificatesEmissionFactorSourceEnum("emissionFactorSource").notNull(), // only DB-backed factors are used
  co2AvoidedGrams: int("co2AvoidedGrams").notNull(),

  periodStart: timestamp("periodStart").notNull(), // start of generation window covered
  periodEnd: timestamp("periodEnd").notNull(),     // timestamp when the 100 kWh threshold was crossed

  status: carbonCertificatesStatusEnum("status").default("minted").notNull(),
  metadata: text("metadata"),
  mintedAt: timestamp("mintedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type CarbonCertificate = typeof carbonCertificates.$inferSelect;
export type InsertCarbonCertificate = typeof carbonCertificates.$inferInsert;
