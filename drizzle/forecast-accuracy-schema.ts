/**
 * Forecast accuracy scoring.
 *
 * A forecast the platform never scores against what actually happened is a
 * claim, not a measurement — and utilities discount VPP capacity precisely
 * because that claim is usually unbacked. Every forecast run is therefore
 * scored after its horizon elapses, against the same actuals the model was
 * trained on, and the score is stored here with the sample count and the
 * source of the actuals so a reader can see what the number is made of.
 *
 * A run with too few actuals is recorded as `insufficient_actuals` rather than
 * scored on a handful of points: a MAPE over two samples reads as accuracy
 * while measuring nothing.
 */

import {
  index,
  integer as int,
  pgEnum,
  pgTable,
  serial,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

/** Where the actual values a run was scored against came from. */
export const forecastAccuracyActualSourceEnum = pgEnum(
  "forecast_accuracy_actual_source",
  ["telemetry", "grid_monitoring", "market_prices", "emissions_factors"],
);

export const forecastAccuracyStatusEnum = pgEnum("forecast_accuracy_status", [
  "scored",
  "insufficient_actuals",
]);

export const forecastAccuracy = pgTable(
  "forecast_accuracy",
  {
    id: serial("id").primaryKey(),

    /** `forecast_runs.run_id`, not the surrogate id, so scores survive re-imports. */
    runId: varchar("run_id", { length: 64 }).notNull().unique(),

    forecastType: varchar("forecast_type", { length: 32 }).notNull(),
    scopeType: varchar("scope_type", { length: 32 }).notNull(),
    scopeId: int("scope_id"),
    region: varchar("region", { length: 50 }),

    /** Copied from the run so a score stays attributable after the model moves on. */
    modelVersion: varchar("model_version", { length: 50 }).notNull(),

    actualSource: forecastAccuracyActualSourceEnum("actual_source").notNull(),
    status: forecastAccuracyStatusEnum("status").notNull(),

    /** Forecast points that found a matching actual. Zero means nothing was measured. */
    sampleCount: int("sample_count").notNull(),

    /** Errors of the P50 against actuals, in the forecast's own unit * 100. */
    maeValue: int("mae_value"),
    rmseValue: int("rmse_value"),
    /** Mean absolute percentage error in basis points (100 = 1%). */
    mapeBp: int("mape_bp"),
    /** Signed mean error * 100: positive means the forecast ran high. */
    biasValue: int("bias_value"),

    /**
     * Share of actuals that fell inside the P10-P90 band, in basis points.
     * A calibrated 80% band should sit near 8000; far below means the stated
     * uncertainty is too narrow to trust, far above means it is padded.
     */
    coverageBp: int("coverage_bp"),
    /** Mean P90-P10 width * 100: coverage bought with a wide band is not skill. */
    intervalWidthValue: int("interval_width_value"),

    /** Last forecast time included in the score. */
    scoredThrough: timestamp("scored_through").notNull(),
    scoredAt: timestamp("scored_at").defaultNow().notNull(),
  },
  (table) => ({
    typeScopeIdx: index("forecast_accuracy_type_scope_idx").on(
      table.forecastType,
      table.scopeType,
      table.scopeId,
    ),
    scoredAtIdx: index("forecast_accuracy_scored_at_idx").on(table.scoredAt),
  }),
);

export type ForecastAccuracy = typeof forecastAccuracy.$inferSelect;
export type InsertForecastAccuracy = typeof forecastAccuracy.$inferInsert;
