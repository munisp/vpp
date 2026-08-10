import { int, mysqlEnum, mysqlTable, text, timestamp, boolean, json, varchar } from "drizzle-orm/mysql-core";

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
export const energyAdvisorReports = mysqlTable("energy_advisor_reports", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  kind: mysqlEnum("kind", ["recommendations", "weekly_digest"]).notNull(),
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
export const dynamicTariffs = mysqlTable("dynamic_tariffs", {
  id: int("id").autoincrement().primaryKey(),
  country: mysqlEnum("country", ["nigeria", "tanzania"]).notNull(),
  version: int("version").notNull(),
  status: mysqlEnum("status", ["published", "superseded"]).default("published").notNull(),
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
export const batteryHealthSnapshots = mysqlTable("battery_health_snapshots", {
  id: int("id").autoincrement().primaryKey(),
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
export const p2pMatches = mysqlTable("p2p_matches", {
  id: int("id").autoincrement().primaryKey(),
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

/**
 * Carbon certificates — one certificate minted per 100 kWh of verified
 * solar generation. certificateHash is a deterministic SHA-256 over the
 * certificate's factual fields, enabling public verification.
 */
export const carbonCertificates = mysqlTable("carbon_certificates", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  sequence: int("sequence").notNull(), // per-user mint sequence (1-based)
  certificateHash: varchar("certificateHash", { length: 64 }).notNull().unique(),

  region: varchar("region", { length: 50 }).notNull(),
  energyWh: int("energyWh").notNull(), // always 100_000 (100 kWh) per certificate
  emissionFactorGramsPerKwh: int("emissionFactorGramsPerKwh").notNull(), // DB-backed factor used
  emissionFactorSource: mysqlEnum("emissionFactorSource", ["live"]).notNull(), // only DB-backed factors are used
  co2AvoidedGrams: int("co2AvoidedGrams").notNull(),

  periodStart: timestamp("periodStart").notNull(), // start of generation window covered
  periodEnd: timestamp("periodEnd").notNull(),     // timestamp when the 100 kWh threshold was crossed

  status: mysqlEnum("status", ["minted", "retired"]).default("minted").notNull(),
  metadata: text("metadata"),
  mintedAt: timestamp("mintedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type CarbonCertificate = typeof carbonCertificates.$inferSelect;
export type InsertCarbonCertificate = typeof carbonCertificates.$inferInsert;
