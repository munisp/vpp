/**
 * Innovation wave 3 — customer control & transparency tables.
 *
 * Five features share this file because they share one idea: the platform
 * hands the customer an answer computed from their own registered and
 * measured data, and says so plainly when the data is not there.
 *
 *  - `export_jobs`: a Green Button export of the requesting user's OWN
 *    telemetry and billing rows for a period. The job lifecycle is
 *    queued -> ready (with row counts and a checksum) or failed (with the
 *    reason). An empty period completes as ready with zero rows and
 *    `empty = true` — a boundary with no data behind it is an honest
 *    answer, not an error, and never a reason to synthesize readings.
 *  - `capacity_bids`: a bid into a capacity program built from the sum of
 *    the user's registered flexible capacity (assets + der_capabilities)
 *    minus real, recorded commitments (service_enrollments, dispatch
 *    setpoints). When capacity cannot be established from registered data
 *    the bid row is kept with `bidAvailable = false` and the reason,
 *    rather than being built on an assumed nameplate.
 *  - `island_assessments`: a point-in-time island-mode autonomy assessment
 *    for one user, computed by the shared assessResilience logic from
 *    registered battery energy, registered usable floors, measured state
 *    of charge and measured demand — never from an assumed battery size.
 *  - `dispatch_window_recommendations`: recommended charge/discharge
 *    windows for a flexible asset, computed from the PUBLISHED dynamic
 *    tariff version recorded on the row plus the asset's registered
 *    constraints. No published tariff means `recommendationAvailable =
 *    false` with reason 'no_tariff' — windows are never priced from an
 *    invented rate.
 *  - `energy_budgets` / `budget_checkpoints`: a user's monthly kWh and/or
 *    cost target, with weekly checkpoints of real measured consumption
 *    pace. A month-end figure is a projection and is labelled as such; it
 *    is withheld (`projectionAvailable = false`) until at least three
 *    days of real data exist.
 *
 * Integer-scaling conventions follow drizzle/schema.ts: power in whole
 * watts, energy in whole watt-hours, money in whole cents, percentages
 * and hours stored scaled (noted per column). There is no floating-point
 * energy or money anywhere in this subsystem.
 */

import {
  bigint,
  boolean,
  index,
  integer as int,
  json,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// 16. Green Button data export
// ---------------------------------------------------------------------------

/** Wire format of an export. `espi_xml` is an ESPI-flavored XML envelope. */
export const exportJobFormatEnum = pgEnum('export_job_format', ['csv', 'espi_xml']);

/** Which of the user's own data the export covers. */
export const exportJobScopeEnum = pgEnum('export_job_scope', ['usage', 'billing', 'both']);

export const exportJobStatusEnum = pgEnum('export_job_status', [
  /** Accepted; not yet assembled. */
  'queued',
  /** Assembled; `content`, row counts and checksum are final. */
  'ready',
  /** Assembly failed; `failureReason` says why. */
  'failed',
]);

export const exportJobs = pgTable(
  'export_jobs',
  {
    id: serial('id').primaryKey(),
    /** The user whose data this is. Exports are only ever of the requester's own rows. */
    userId: int('user_id').notNull(),
    periodStart: timestamp('period_start').notNull(),
    periodEnd: timestamp('period_end').notNull(),
    format: exportJobFormatEnum('format').notNull(),
    scope: exportJobScopeEnum('scope').notNull(),
    status: exportJobStatusEnum('status').notNull().default('queued'),
    /** Real row counts, set when the job reaches `ready`. Null before that. */
    telemetryRowCount: int('telemetry_row_count'),
    billingRowCount: int('billing_row_count'),
    /**
     * True when the job is `ready` and the period contained no rows. A ready,
     * empty export is an honest answer; `content` then holds only headers.
     */
    empty: boolean('empty'),
    /** The assembled document (CSV text or ESPI-flavored XML). */
    content: text('content'),
    /** SHA-256 of `content`, hex. Lets a recipient verify the download. */
    checksum: varchar('checksum', { length: 64 }),
    byteSize: int('byte_size'),
    /** Why assembly failed, when status is `failed`. */
    failureReason: varchar('failure_reason', { length: 500 }),
    queuedAt: timestamp('queued_at').defaultNow().notNull(),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('export_jobs_user_idx').on(table.userId, table.createdAt)]
);

// ---------------------------------------------------------------------------
// 17. Capacity bid builder
// ---------------------------------------------------------------------------

export const capacityBidStatusEnum = pgEnum('capacity_bid_status', [
  /** Built and priced against known capacity; not yet offered. */
  'draft',
  /** Offered by the user. */
  'submitted',
  /** Awarded — recorded only when an operator records a real outcome. */
  'awarded',
  /** Not awarded — recorded only when an operator records a real outcome. */
  'rejected',
  /** Withdrawn by the user before an outcome. */
  'withdrawn',
]);

export const capacityBids = pgTable(
  'capacity_bids',
  {
    id: serial('id').primaryKey(),
    userId: int('user_id').notNull(),
    /** Delivery window the bid covers. */
    deliveryStart: timestamp('delivery_start').notNull(),
    deliveryEnd: timestamp('delivery_end').notNull(),
    status: capacityBidStatusEnum('status').notNull().default('draft'),
    /**
     * False when flexible capacity could not be established from registered
     * data (`unavailableReason` says why, e.g. 'unknown_capacity'). Such a
     * bid cannot be submitted: there is nothing real behind the number.
     */
    bidAvailable: boolean('bid_available').notNull(),
    unavailableReason: varchar('unavailable_reason', { length: 120 }),
    /** Registered flexible capacity found, watts. Null when unknown. */
    knownCapacityW: int('known_capacity_w'),
    /** Capacity already committed elsewhere in the window, watts. Null when unknown. */
    committedCapacityW: int('committed_capacity_w'),
    /** What the bid offers: known minus committed, watts. Null when unavailable. */
    offeredCapacityW: int('offered_capacity_w'),
    /** The user's ask, cents per kWh. Optional; null = no price stated. */
    priceCentsPerKwh: int('price_cents_per_kwh'),
    /**
     * Per-asset and per-commitment breakdown the totals were summed from.
     * The audit trail of the number: every watt traces to an assets row, a
     * der_capabilities row, a service_enrollments row or a dispatch_setpoints
     * row.
     */
    basisJson: json('basis_json'),
    submittedAt: timestamp('submitted_at'),
    /** Outcome recorded from real inputs only: who recorded it, and the note. */
    outcomeRecordedAt: timestamp('outcome_recorded_at'),
    outcomeRecordedBy: int('outcome_recorded_by'),
    outcomeNote: varchar('outcome_note', { length: 500 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('capacity_bids_user_idx').on(table.userId, table.createdAt)]
);

// ---------------------------------------------------------------------------
// 18. Island-mode monitor
// ---------------------------------------------------------------------------

export const islandAssessments = pgTable(
  'island_assessments',
  {
    id: serial('id').primaryKey(),
    userId: int('user_id').notNull(),
    assessedAt: timestamp('assessed_at').defaultNow().notNull(),
    /**
     * False when storage or consumption could not be established from
     * registered/measured data (`unavailableReason` says which). No figure
     * is reported in that case — an invented autonomy is a false promise.
     */
    assessmentAvailable: boolean('assessment_available').notNull(),
    unavailableReason: varchar('unavailable_reason', { length: 120 }),
    /** Hours of ride-through at the measured net drain, hours x 100. */
    autonomyHoursX100: int('autonomy_hours_x100'),
    /** `measured` when every battery contributed; `partial` otherwise. */
    autonomyBasis: varchar('autonomy_basis', { length: 16 }),
    /** Measured demand minus measured generation, watts (the drain on storage). */
    netDrainWatts: int('net_drain_watts'),
    /** Usable stored energy above registered floors, watt-hours. */
    usableEnergyWh: bigint('usable_energy_wh', { mode: 'number' }),
    registeredBatteries: int('registered_batteries'),
    assessedBatteries: int('assessed_batteries'),
    /** Staleness bound (minutes) applied to the SoC and power readings used. */
    telemetryStalenessMinutes: int('telemetry_staleness_minutes'),
    /**
     * Human-readable statements of what could not be assessed, and why,
     * from the shared assessResilience logic.
     */
    limitations: json('limitations').$type<string[]>().notNull(),
    /**
     * Whether island EVENTS (grid loss) can be detected for this user. The
     * platform has no per-site grid-status telemetry field, so this is
     * always recorded honestly as unavailable with the reason — this table
     * is an assessment record, not an outage detector.
     */
    eventDetection: varchar('event_detection', { length: 32 }).notNull(),
    eventDetectionReason: varchar('event_detection_reason', { length: 300 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('island_assessments_user_idx').on(table.userId, table.assessedAt)]
);

// ---------------------------------------------------------------------------
// 19. TOU dispatch windows
// ---------------------------------------------------------------------------

export const dispatchWindowRecommendations = pgTable(
  'dispatch_window_recommendations',
  {
    id: serial('id').primaryKey(),
    userId: int('user_id').notNull(),
    assetId: int('asset_id').notNull(),
    /** The published tariff version the windows were priced from. */
    tariffId: int('tariff_id'),
    tariffVersion: int('tariff_version'),
    recommendationAvailable: boolean('recommendation_available').notNull(),
    /** e.g. 'no_tariff', 'asset_constraints_unregistered', 'asset_not_flexible'. */
    reason: varchar('reason', { length: 120 }),
    /**
     * Recommended windows: contiguous runs of cheap (charge) and dear
     * (discharge) published-tariff hours, each carrying the real published
     * price range it was chosen from.
     */
    windows: json('windows').$type<Array<{
      action: 'charge' | 'discharge';
      startIso: string;
      endIso: string;
      band: 'off_peak' | 'shoulder' | 'peak';
      minPriceCentsPerKwh: number | null;
      maxPriceCentsPerKwh: number | null;
      hours: number;
    }>>(),
    /** The registered asset constraints the recommendation respected. */
    assetConstraints: json('asset_constraints').$type<{
      capacityWh: number | null;
      maxPowerImportW: number | null;
      maxPowerExportW: number | null;
      minSocX100: number | null;
      maxSocX100: number | null;
    }>(),
    computedAt: timestamp('computed_at').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('dispatch_window_recs_user_idx').on(table.userId, table.computedAt),
    index('dispatch_window_recs_asset_idx').on(table.assetId, table.computedAt),
  ]
);

// ---------------------------------------------------------------------------
// 20. Energy budget planner
// ---------------------------------------------------------------------------

export const energyBudgets = pgTable(
  'energy_budgets',
  {
    id: serial('id').primaryKey(),
    userId: int('user_id').notNull(),
    /** Calendar month the budget covers (UTC). */
    year: int('year').notNull(),
    month: int('month').notNull(), // 1-12
    /** kWh target; null when the budget is cost-only. At least one target required. */
    targetKwh: int('target_kwh'),
    /** Cost target in whole cents of `currency`; null when kWh-only. */
    targetCostCents: int('target_cost_cents'),
    /** The user's currency at creation (users.currency). */
    currency: varchar('currency', { length: 3 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('energy_budgets_user_month_key').on(table.userId, table.year, table.month),
  ]
);

export const budgetCheckpoints = pgTable(
  'budget_checkpoints',
  {
    id: serial('id').primaryKey(),
    budgetId: int('budget_id').notNull(),
    /** Monday (UTC) of the ISO week this checkpoint covers. One per week per budget. */
    weekStart: timestamp('week_start').notNull(),
    checkpointAt: timestamp('checkpoint_at').defaultNow().notNull(),
    daysElapsed: int('days_elapsed').notNull(),
    daysInMonth: int('days_in_month').notNull(),
    /** Real measured consumption month-to-date, watt-hours. */
    consumedWh: bigint('consumed_wh', { mode: 'number' }),
    /** Real billed cost month-to-date, cents. Null when no billing rows cover the month. */
    billedCostCents: int('billed_cost_cents'),
    /** Where consumedWh came from: meter telemetry deltas and/or billings. */
    basisJson: json('basis_json'),
    /**
     * False with `projectionUnavailableReason` (e.g. 'insufficient_days')
     * until at least 3 days of real data exist; the month-end figures are
     * then null rather than extrapolated from almost nothing.
     */
    projectionAvailable: boolean('projection_available').notNull(),
    projectionUnavailableReason: varchar('projection_unavailable_reason', { length: 120 }),
    /** Pace projection, watt-hours — a projection, not a measurement. */
    projectedMonthEndWh: bigint('projected_month_end_wh', { mode: 'number' }),
    /** Pace projection, cents — a projection, not a measurement. */
    projectedMonthEndCostCents: int('projected_month_end_cost_cents'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('budget_checkpoints_budget_week_key').on(table.budgetId, table.weekStart),
    index('budget_checkpoints_budget_idx').on(table.budgetId, table.checkpointAt),
  ]
);

export type ExportJobRow = typeof exportJobs.$inferSelect;
export type InsertExportJob = typeof exportJobs.$inferInsert;
export type ExportJobFormat = (typeof exportJobFormatEnum.enumValues)[number];
export type ExportJobScope = (typeof exportJobScopeEnum.enumValues)[number];
export type ExportJobStatus = (typeof exportJobStatusEnum.enumValues)[number];

export type CapacityBidRow = typeof capacityBids.$inferSelect;
export type InsertCapacityBid = typeof capacityBids.$inferInsert;
export type CapacityBidStatus = (typeof capacityBidStatusEnum.enumValues)[number];

export type IslandAssessmentRow = typeof islandAssessments.$inferSelect;
export type InsertIslandAssessment = typeof islandAssessments.$inferInsert;

export type DispatchWindowRecommendationRow = typeof dispatchWindowRecommendations.$inferSelect;
export type InsertDispatchWindowRecommendation = typeof dispatchWindowRecommendations.$inferInsert;

export type EnergyBudgetRow = typeof energyBudgets.$inferSelect;
export type InsertEnergyBudget = typeof energyBudgets.$inferInsert;
export type BudgetCheckpointRow = typeof budgetCheckpoints.$inferSelect;
export type InsertBudgetCheckpoint = typeof budgetCheckpoints.$inferInsert;
