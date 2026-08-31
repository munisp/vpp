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
import { dynamicTariffsCountryEnum } from "./innovations-schema";

/**
 * Innov3 planning schema — tables backing the five planning/intelligence
 * features (2026-08-11 wave, second tranche):
 *
 *  1. EV smart charging planner      -> ev_charging_plans, ev_charging_sessions
 *  2. Outage risk forecast           -> outage_risk_scores
 *  3. Load disaggregation (NILM-lite)-> appliance_estimates
 *  4. Tariff switch advisor          -> tariff_comparisons
 *  5. Demand-charge guardian         -> demand_charge_alerts
 *
 * Follows the multi-file schema pattern (see innovations-schema.ts).
 * Scaling conventions follow drizzle/schema.ts: percentages * 100, continuous
 * scores * 1000, money in cents, energy in whole watt-hours. There is no
 * floating-point money, energy or probability anywhere here.
 *
 * Honesty contract shared by all five features: a row with
 * `insufficientData`/`scheduleAvailable`/`available` false records *that the
 * computation was refused and why* — it never carries fabricated values.
 * Nullable metric columns are null exactly when the underlying real data was
 * missing.
 */

// ============================================================================
// 1. EV SMART CHARGING PLANNER
// ============================================================================

export const evChargingPlanStatusEnum = pgEnum("ev_charging_plans_status", [
  /** Cost-optimal windows were computed and the plan is waiting to run. */
  "scheduled",
  /** Departure window is open; actual sessions are being tracked. */
  "active",
  /** Departure time passed with the plan's target reached or attempted. */
  "completed",
  "cancelled",
  /**
   * No feasible/honest schedule could be produced (no published tariff, no
   * SoC telemetry, or not enough time before departure). `unavailableReason`
   * says which.
   */
  "infeasible",
]);

/** Where a recorded charging session's numbers came from. */
export const evChargingSessionSourceEnum = pgEnum("ev_charging_sessions_source", [
  /** Derived from the asset's own SoC/power telemetry — never estimated. */
  "telemetry",
]);

/**
 * One user's intent to have an EV (modelled as a battery asset, matching the
 * platform's v2g_schedules convention) at `targetSocPct100` by `departureTime`.
 *
 * The charge windows are computed from the currently *published* dynamic tariff
 * (`tariffId` records exactly which version priced this plan). When no tariff
 * is published, no SoC telemetry exists, or the remaining time cannot deliver
 * the required energy at `maxChargePowerW`, the plan is persisted with
 * `scheduleAvailable = false` and a machine-readable `unavailableReason`
 * rather than a made-up schedule.
 */
export const evChargingPlans = pgTable("ev_charging_plans", {
  id: serial("id").primaryKey(),
  userId: int("userId").notNull(),
  assetId: int("assetId").notNull(),
  country: dynamicTariffsCountryEnum("country").notNull(),

  departureTime: timestamp("departureTime").notNull(),
  targetSocPct100: int("targetSocPct100").notNull(), // percent * 100
  /** SoC at planning time, percent * 100. Null = no SoC telemetry existed. */
  startSocPct100: int("startSocPct100"),
  /** Snapshot of asset.capacity (Wh) at planning time. */
  capacityWh: int("capacityWh").notNull(),
  /** Charger power cap (W) the plan was computed against. */
  maxChargePowerW: int("maxChargePowerW").notNull(),

  /** dynamic_tariffs.id of the version that priced this plan; null = none. */
  tariffId: int("tariffId"),

  scheduleAvailable: boolean("scheduleAvailable").default(false).notNull(),
  /** 'no_tariff' | 'no_soc_telemetry' | 'insufficient_time' | null */
  unavailableReason: varchar("unavailableReason", { length: 40 }),

  /** Energy the battery must take in, derived from SoC gap * capacity. */
  energyNeededWh: int("energyNeededWh"),

  /**
   * Computed charge windows, cheapest-first allocation:
   * [{startTime, endTime, priceCentsPerKwh, energyWh, costCents}]
   */
  windows: json("windows").$type<Array<{
    startTime: string;
    endTime: string;
    priceCentsPerKwh: number;
    energyWh: number;
    costCents: number;
  }>>(),

  expectedCostCents: int("expectedCostCents"),
  /** Cost of charging the same energy immediately at the current-hour price. */
  naiveImmediateCostCents: int("naiveImmediateCostCents"),

  status: evChargingPlanStatusEnum("status").default("scheduled").notNull(),

  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type EvChargingPlan = typeof evChargingPlans.$inferSelect;
export type InsertEvChargingPlan = typeof evChargingPlans.$inferInsert;

/**
 * One actual charging session observed in telemetry: a contiguous run of
 * rising state-of-charge. Energy is the SoC delta applied to the asset's
 * capacity — elapsed time is never treated as energy.
 */
export const evChargingSessions = pgTable("ev_charging_sessions", {
  id: serial("id").primaryKey(),
  /** Set when the session overlaps a plan's window; null = unplanned charge. */
  planId: int("planId"),
  userId: int("userId").notNull(),
  assetId: int("assetId").notNull(),

  startedAt: timestamp("startedAt").notNull(),
  endedAt: timestamp("endedAt").notNull(),

  startSocPct100: int("startSocPct100").notNull(),
  endSocPct100: int("endSocPct100").notNull(),
  capacityWh: int("capacityWh").notNull(), // snapshot used for the energy math
  energyWh: int("energyWh").notNull(),
  sampleCount: int("sampleCount").notNull(),

  source: evChargingSessionSourceEnum("source").default("telemetry").notNull(),

  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type EvChargingSession = typeof evChargingSessions.$inferSelect;
export type InsertEvChargingSession = typeof evChargingSessions.$inferInsert;

// ============================================================================
// 2. OUTAGE RISK FORECAST
// ============================================================================

/**
 * Point-in-time outage-risk assessment for one asset, computed from three
 * real signals, each stored both raw and as a 0-100 component:
 *
 *  - anomaly:     severity/magnitude of the asset's own grid_anomaly_scores
 *  - telemetryGap: fraction of the window with no telemetry (a dark site is
 *                  the strongest observed precursor of an outage)
 *  - gridQuality: fraction of voltage/frequency samples outside tolerance of
 *                  the asset's own observed nominal
 *
 * `scoreMilli` is the equal-weight mean of the available components (* 1000).
 * Components with no underlying data are null and excluded; when no component
 * is available at all the row records `insufficientData = true` with a reason
 * and a null score — no probability is invented.
 */
export const outageRiskScores = pgTable("outage_risk_scores", {
  id: serial("id").primaryKey(),
  assetId: int("assetId").notNull(),
  userId: int("userId").notNull(),

  windowStart: timestamp("windowStart").notNull(),
  windowEnd: timestamp("windowEnd").notNull(),
  spanDays10: int("spanDays10").notNull(), // days * 10
  telemetrySampleCount: int("telemetrySampleCount").notNull(),

  // Component scores, 0-100 * 1000; null = that signal had no data.
  anomalyComponentMilli: int("anomalyComponentMilli"),
  telemetryGapComponentMilli: int("telemetryGapComponentMilli"),
  gridQualityComponentMilli: int("gridQualityComponentMilli"),
  /** Equal-weight composite, 0-100 * 1000; null when insufficientData. */
  scoreMilli: int("scoreMilli"),

  // Raw evidence behind the components.
  anomalyScoreCount: int("anomalyScoreCount").notNull(),
  severeAnomalyCount: int("severeAnomalyCount").notNull(), // severity high/critical
  gapRatioMilli: int("gapRatioMilli"), // gap time / window time * 1000
  voltageSampleCount: int("voltageSampleCount").notNull(),
  voltageViolationCount: int("voltageViolationCount"),
  frequencySampleCount: int("frequencySampleCount").notNull(),
  frequencyViolationCount: int("frequencyViolationCount"),

  insufficientData: boolean("insufficientData").default(false).notNull(),
  reason: text("reason"),

  computedAt: timestamp("computedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type OutageRiskScore = typeof outageRiskScores.$inferSelect;
export type InsertOutageRiskScore = typeof outageRiskScores.$inferInsert;

// ============================================================================
// 3. LOAD DISAGGREGATION (NILM-LITE)
// ============================================================================

/**
 * One appliance-class energy estimate for an asset over a window.
 *
 * These are *estimates* derived from interval-shape heuristics over the
 * asset's real power telemetry — not metered sub-circuit measurements — so
 * every row names its method and carries a confidence in `confidenceMilli`
 * (0-1000). The service refuses to write any row when the asset has less than
 * the minimum interval history, rather than guessing.
 */
export const applianceEstimates = pgTable("appliance_estimates", {
  id: serial("id").primaryKey(),
  userId: int("userId").notNull(),
  assetId: int("assetId").notNull(),

  windowStart: timestamp("windowStart").notNull(),
  windowEnd: timestamp("windowEnd").notNull(),
  spanDays10: int("spanDays10").notNull(), // days * 10

  /** e.g. 'always_on_base' | 'evening_peak_block' | 'daytime_variable_above_base' */
  applianceClass: varchar("applianceClass", { length: 40 }).notNull(),

  estimatedWh: int("estimatedWh").notNull(),
  /** Share of the window's total measured energy, percent * 1000. */
  shareMilliPct: int("shareMilliPct").notNull(),
  /** 0-1000; derived from data coverage and day-to-day stability. */
  confidenceMilli: int("confidenceMilli").notNull(),
  /** Algorithm label, e.g. 'interval_shape_heuristic_v1'. */
  method: varchar("method", { length: 60 }).notNull(),

  sampleCount: int("sampleCount").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type ApplianceEstimate = typeof applianceEstimates.$inferSelect;
export type InsertApplianceEstimate = typeof applianceEstimates.$inferInsert;

// ============================================================================
// 4. TARIFF SWITCH ADVISOR
// ============================================================================

/**
 * One comparison run: the user's real interval usage profile priced against
 * every published dynamic tariff version, ranked cheapest-first.
 *
 * When no tariff is published or the usage history is too thin, a row is still
 * written with `available = false` and a machine-readable reason, so the
 * refusal is auditable and `results` is an empty array — never a synthetic
 * comparison.
 */
export const tariffComparisons = pgTable("tariff_comparisons", {
  id: serial("id").primaryKey(),
  userId: int("userId").notNull(),
  country: dynamicTariffsCountryEnum("country").notNull(), // user's country

  windowStart: timestamp("windowStart"),
  windowEnd: timestamp("windowEnd"),
  spanDays10: int("spanDays10"),
  usageWh: int("usageWh"),
  /** Hour-of-day usage profile (24 whole-Wh entries) the costs were priced on. */
  hourlyUsageWh: json("hourlyUsageWh").$type<number[]>(),

  available: boolean("available").default(false).notNull(),
  /** 'no_published_tariffs' | 'insufficient_usage' | null */
  unavailableReason: varchar("unavailableReason", { length: 40 }),

  /**
   * Ranked cheapest-first:
   * [{tariffId, version, country, computedCostCents, unpricedWh, complete, rank}]
   * `complete:false` marks tariffs whose null-priced hours left some usage
   * unpriced; `computedCostCents` then covers the priced hours only.
   */
  results: json("results").$type<Array<{
    tariffId: number;
    version: number;
    country: string;
    computedCostCents: number;
    unpricedWh: number;
    complete: boolean;
    rank: number;
  }>>().notNull(),

  cheapestTariffId: int("cheapestTariffId"),
  cheapestCostCents: int("cheapestCostCents"),
  /** The published tariff of the user's own country, when present. */
  currentTariffId: int("currentTariffId"),
  /** currentCost - cheapestCost; null when either could not be fully priced. */
  savingsVsCurrentCents: int("savingsVsCurrentCents"),

  computedAt: timestamp("computedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type TariffComparison = typeof tariffComparisons.$inferSelect;
export type InsertTariffComparison = typeof tariffComparisons.$inferInsert;

// ============================================================================
// 5. DEMAND-CHARGE GUARDIAN
// ============================================================================

export const demandChargeAlertStatusEnum = pgEnum("demand_charge_alerts_status", [
  /** Projected peak exceeded the contracted threshold at computation time. */
  "alert",
  /** A later computation found the projection back under threshold. */
  "resolved",
]);

/**
 * A demand-charge exceedance warning for a C&I site.
 *
 * Rows are written only when the rolling 15/30-minute window computed from
 * real telemetry is *projected* to exceed the contracted threshold. The
 * threshold is a user setting: it is supplied on first check and persisted
 * here, so later checks can reuse the most recent contracted value. The
 * projection method is named on the row; nothing here is a probability —
 * `projectedPeakKw10` is a deterministic linear extrapolation of observed
 * window averages.
 */
export const demandChargeAlerts = pgTable("demand_charge_alerts", {
  id: serial("id").primaryKey(),
  userId: int("userId").notNull(),
  assetId: int("assetId").notNull(),

  windowMinutes: int("windowMinutes").notNull(), // 15 or 30
  /** Contracted demand threshold, kW * 10. */
  thresholdKw10: int("thresholdKw10").notNull(),

  /** The trailing window this alert was computed from. */
  windowStart: timestamp("windowStart").notNull(),
  windowEnd: timestamp("windowEnd").notNull(),
  sampleCount: int("sampleCount").notNull(),

  /** Observed average over the trailing window, kW * 10. */
  observedWindowAvgKw10: int("observedWindowAvgKw10").notNull(),
  /** Linear one-window extrapolation, kW * 10. */
  projectedPeakKw10: int("projectedPeakKw10").notNull(),
  /** projectedPeak - threshold, kW * 10 (always > 0 on an alert row). */
  projectedExcessKw10: int("projectedExcessKw10").notNull(),
  /** e.g. 'rolling_window_linear_trend' */
  projectionMethod: varchar("projectionMethod", { length: 60 }).notNull(),

  status: demandChargeAlertStatusEnum("status").default("alert").notNull(),

  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type DemandChargeAlert = typeof demandChargeAlerts.$inferSelect;
export type InsertDemandChargeAlert = typeof demandChargeAlerts.$inferInsert;
