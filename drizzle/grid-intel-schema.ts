import { boolean, int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

/**
 * Grid Intelligence Schema
 *
 * Tables backing the five grid-intelligence features:
 *  1. Grid anomaly early-warning (rolling per-asset statistical scoring)
 *  2. V2G departure-aware charge/discharge schedules
 *  3. Energy wallet + auto top-up (balance snapshots, settings, top-up attempts)
 *  4. Community energy pool allocation rules + allocation runs
 *  5. DR event forecasting + participant recommendations
 *
 * Integer-scaling conventions follow drizzle/schema.ts: percentages are
 * stored * 100, continuous scores * 1000, money in cents, energy in Wh.
 *
 * NOTE: anomaly early-warning EVENTS are persisted to the existing
 * `anomaly_events` table (drizzle/nextgen-vpp-schema.ts) — this file only
 * holds the new statistical scoring layer.
 */

// ============================================================================
// 1. GRID ANOMALY EARLY-WARNING
// ============================================================================

/**
 * Rolling statistical score snapshots per asset / metric / hour-of-day.
 * Each row records one scoring window compared against the asset's own
 * trailing 7-day baseline for the same hour-of-day.
 */
export const gridAnomalyScores = mysqlTable("grid_anomaly_scores", {
  id: int("id").autoincrement().primaryKey(),
  assetId: int("asset_id").notNull(),

  metric: mysqlEnum("metric", ["power", "voltage", "frequency"]).notNull(),
  hourOfDay: int("hour_of_day").notNull(), // 0-23 (UTC, matching telemetry timestamps)

  // Scoring window that was evaluated
  windowStart: timestamp("window_start").notNull(),
  windowEnd: timestamp("window_end").notNull(),
  sampleCount: int("sample_count").notNull(),

  // Baseline statistics from the asset's own trailing 7 days, same hour-of-day
  baselineMeanMilli: int("baseline_mean_milli"), // mean * 1000 (null = insufficient baseline)
  baselineStdMilli: int("baseline_std_milli"), // stddev * 1000
  baselineSamples: int("baseline_samples").notNull(),

  // Observed window statistics
  observedMeanMilli: int("observed_mean_milli").notNull(), // mean * 1000

  // Scores (* 1000); null when a baseline was unavailable
  zScoreMilli: int("z_score_milli"),
  combinedScoreMilli: int("combined_score_milli"),

  severity: mysqlEnum("severity", ["low", "medium", "high", "critical"]),
  // Link to the persisted anomaly_events row when the score crossed threshold
  anomalyEventId: int("anomaly_event_id"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type GridAnomalyScore = typeof gridAnomalyScores.$inferSelect;
export type InsertGridAnomalyScore = typeof gridAnomalyScores.$inferInsert;

// ============================================================================
// 2. V2G DEPARTURE-AWARE OPTIMIZER
// ============================================================================

/**
 * Persisted departure-aware charging/discharging schedules.
 * Costs are cents computed from the same real price series recorded in
 * priceSource — expected and naive-baseline costs are always comparable.
 */
export const v2gSchedules = mysqlTable("v2g_schedules", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull(),
  evId: int("ev_id").notNull(),

  // Trip requirements
  departureTime: timestamp("departure_time").notNull(),
  targetSocPercent: int("target_soc_percent").notNull(), // percent * 100
  minSocReservePercent: int("min_soc_reserve_percent").notNull(), // percent * 100
  startSocPercent: int("start_soc_percent").notNull(), // percent * 100 at planning time
  batteryCapacityKwh10: int("battery_capacity_kwh10").notNull(), // kWh * 10

  allowV2g: boolean("allow_v2g").default(false).notNull(),

  // Which real price series the economics were computed from
  priceSource: mysqlEnum("price_source", ["market_prices", "ml_forecast"]).notNull(),

  // Full interval plan: [{startTime, endTime, powerKw, priceCentsPerKwh, costCents, revenueCents, socAfterPercent}]
  scheduleJson: text("schedule_json").notNull(),

  energyToChargeKwh10: int("energy_to_charge_kwh10").notNull(), // kWh * 10
  expectedCostCents: int("expected_cost_cents").notNull(),
  naiveBaselineCostCents: int("naive_baseline_cost_cents").notNull(),
  expectedRevenueCents: int("expected_revenue_cents").default(0).notNull(),

  status: mysqlEnum("status", ["draft", "active", "completed", "cancelled"]).default("draft").notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type V2gSchedule = typeof v2gSchedules.$inferSelect;
export type InsertV2gSchedule = typeof v2gSchedules.$inferInsert;

// ============================================================================
// 3. ENERGY WALLET + AUTO TOP-UP
// ============================================================================

/**
 * Per-user wallet settings and latest computed balance.
 * The balance here is a cache of the most recent wallet_balance_snapshots row;
 * the ledger (payments/billings) remains the source of truth.
 */
export const energyWallets = mysqlTable("energy_wallets", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull().unique(),

  balanceCents: int("balance_cents"), // null until first snapshot is computed
  lowBalanceThresholdCents: int("low_balance_threshold_cents"),

  autoTopUp: boolean("auto_top_up").default(false).notNull(),
  topUpAmountCents: int("top_up_amount_cents"),
  preferredMethod: mysqlEnum("preferred_method", ["mpesa", "airtel_money", "tigo_pesa"]),
  phoneNumber: varchar("phone_number", { length: 20 }),

  lastComputedAt: timestamp("last_computed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type EnergyWallet = typeof energyWallets.$inferSelect;
export type InsertEnergyWallet = typeof energyWallets.$inferInsert;

/**
 * Append-only audit trail of wallet balance computations.
 * Every row is derived from the real payments/billings ledger at computedAt.
 */
export const walletBalanceSnapshots = mysqlTable("wallet_balance_snapshots", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull(),

  balanceCents: int("balance_cents").notNull(),
  paymentsCompletedCents: int("payments_completed_cents").notNull(),
  billingsIssuedCents: int("billings_issued_cents").notNull(),
  tokenPurchasesCents: int("token_purchases_cents").notNull(),

  reason: varchar("reason", { length: 50 }).notNull(), // e.g. 'manual', 'top_up_check', 'reconciliation'
  computedAt: timestamp("computed_at").defaultNow().notNull(),
});

export type WalletBalanceSnapshot = typeof walletBalanceSnapshots.$inferSelect;
export type InsertWalletBalanceSnapshot = typeof walletBalanceSnapshots.$inferInsert;

/**
 * Top-up attempts. Status is 'initiated' only after the real gateway accepted
 * the request, and becomes 'completed' only via webhook reconciliation —
 * never optimistically.
 */
export const walletTopUpAttempts = mysqlTable("wallet_top_up_attempts", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull(),

  amountCents: int("amount_cents").notNull(),
  method: mysqlEnum("method", ["mpesa", "airtel_money", "tigo_pesa"]).notNull(),
  phoneNumber: varchar("phone_number", { length: 20 }).notNull(),
  triggerType: mysqlEnum("trigger_type", ["auto", "manual"]).notNull(),

  status: mysqlEnum("status", ["initiated", "failed", "completed"]).notNull(),
  gatewayTransactionId: varchar("gateway_transaction_id", { length: 255 }),
  gatewayCheckoutId: varchar("gateway_checkout_id", { length: 255 }),
  errorMessage: text("error_message"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
});

export type WalletTopUpAttempt = typeof walletTopUpAttempts.$inferSelect;
export type InsertWalletTopUpAttempt = typeof walletTopUpAttempts.$inferInsert;

// ============================================================================
// 4. COMMUNITY ENERGY POOLS (ALLOCATION RULES ENGINE)
// ============================================================================

/**
 * Per-community allocation rule configured by a pool admin.
 */
export const poolAllocationRules = mysqlTable("pool_allocation_rules", {
  id: int("id").autoincrement().primaryKey(),
  communityId: int("community_id").notNull().unique(),

  ruleType: mysqlEnum("rule_type", [
    "proportional_consumption",
    "equal",
    "proportional_generation",
    "custom_weights",
  ]).notNull(),

  // JSON object { "<userId>": <weight> } — required iff ruleType = custom_weights
  customWeights: text("custom_weights"),

  updatedBy: int("updated_by").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type PoolAllocationRule = typeof poolAllocationRules.$inferSelect;
export type InsertPoolAllocationRule = typeof poolAllocationRules.$inferInsert;

/**
 * One allocation run over a period for a community pool.
 */
export const allocationRuns = mysqlTable("allocation_runs", {
  id: int("id").autoincrement().primaryKey(),
  communityId: int("community_id").notNull(),

  periodStart: timestamp("period_start").notNull(),
  periodEnd: timestamp("period_end").notNull(),
  ruleType: varchar("rule_type", { length: 40 }).notNull(), // rule applied for this run

  // Pool totals from real telemetry over the period
  totalGenerationWh: int("total_generation_wh").notNull(),
  totalConsumptionWh: int("total_consumption_wh").notNull(),
  surplusWh: int("surplus_wh").notNull(),
  deficitWh: int("deficit_wh").notNull(),

  // Real prices used (cents/kWh) — from community-energy getPeriodPrices
  exportPriceCents: int("export_price_cents").notNull(),
  importPriceCents: int("import_price_cents").notNull(),
  netValueCents: int("net_value_cents").notNull(),

  status: mysqlEnum("status", ["computed", "finalized"]).default("computed").notNull(),
  runBy: int("run_by").notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type AllocationRun = typeof allocationRuns.$inferSelect;
export type InsertAllocationRun = typeof allocationRuns.$inferInsert;

/**
 * Per-member result rows for an allocation run (member statements).
 */
export const allocationEntries = mysqlTable("allocation_entries", {
  id: int("id").autoincrement().primaryKey(),
  runId: int("run_id").notNull(),
  communityId: int("community_id").notNull(),
  userId: int("user_id").notNull(),

  shareBps: int("share_bps").notNull(), // share of pool value in basis points (0-10000)
  generationWh: int("generation_wh").notNull(),
  consumptionWh: int("consumption_wh").notNull(),
  allocatedValueCents: int("allocated_value_cents").notNull(), // signed: credit (+) / debit (-)

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type AllocationEntry = typeof allocationEntries.$inferSelect;
export type InsertAllocationEntry = typeof allocationEntries.$inferInsert;

// ============================================================================
// 5. DR EVENT FORECASTING + PARTICIPANT RECOMMENDATION
// ============================================================================

/**
 * Daily DR-event likelihood forecast computed from real signals:
 * demandResponseEvents history frequency, telemetry demand trend, and
 * weather forecast heat (when available — see weatherUsed).
 */
export const drEventForecasts = mysqlTable("dr_event_forecasts", {
  id: int("id").autoincrement().primaryKey(),

  forecastDate: timestamp("forecast_date").notNull(), // day being forecast (UTC midnight)
  weekday: int("weekday").notNull(), // 0-6

  likelihoodPercent: int("likelihood_percent").notNull(), // 0-100

  // Component signals (0-100); null when the underlying data was unavailable
  historyFrequencyPercent: int("history_frequency_percent").notNull(),
  demandTrendPercent: int("demand_trend_percent"),
  heatFactorPercent: int("heat_factor_percent"),

  weatherUsed: boolean("weather_used").default(false).notNull(),
  historyEventCount: int("history_event_count").notNull(), // real sample size behind historyFrequency

  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type DrEventForecastRow = typeof drEventForecasts.$inferSelect;
export type InsertDrEventForecastRow = typeof drEventForecasts.$inferInsert;

/**
 * Recommended participants for a forecast/planned DR event, with an outcome
 * feedback loop (outcome is recorded after the event).
 */
export const drParticipantRecommendations = mysqlTable("dr_participant_recommendations", {
  id: int("id").autoincrement().primaryKey(),

  forecastId: int("forecast_id"), // link to dr_event_forecasts when driven by a forecast
  eventId: int("event_id"), // link to demandResponseEvents when attached to a real event
  recommendedForDate: timestamp("recommended_for_date"),

  userId: int("user_id").notNull(),
  rankPosition: int("rank_position").notNull(),

  // Ranking evidence — all derived from real history / assets
  scoreMilli: int("score_milli").notNull(), // composite score * 1000
  compliancePercent: int("compliance_percent"), // historical actual/target reduction * 100; null = no history
  flexibilityKw10: int("flexibility_kw10").notNull(), // battery-backed flexibility, kW * 10
  noShowCount: int("no_show_count").notNull(),

  outcome: mysqlEnum("outcome", ["pending", "participated", "no_show", "declined"]).default("pending").notNull(),
  outcomeRecordedAt: timestamp("outcome_recorded_at"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type DrParticipantRecommendation = typeof drParticipantRecommendations.$inferSelect;
export type InsertDrParticipantRecommendation = typeof drParticipantRecommendations.$inferInsert;
