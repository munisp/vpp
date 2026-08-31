/**
 * Innovation wave 3 — field operations & portfolio tables.
 *
 * Five features share this file because they share one operational idea:
 * the platform records what a human or a device actually did, and refuses
 * to record what it does not know.
 *
 *  - `work_orders` / `work_order_events`: maintenance work on a real asset,
 *    optionally linked to a real grid_anomaly_scores row or ntl_flags row.
 *    The event log is append-only and actor-stamped; the work order row only
 *    ever holds the latest state, the history is in the events.
 *  - `firmware_campaigns` / `firmware_targets`: a campaign declares the
 *    version a set of devices SHOULD run. A target is only `applied` when
 *    the device's own reported `devices.firmwareVersion` equals the expected
 *    version — never assumed from the platform having offered it.
 *  - `savings_verifications`: IPMVP-style baseline-vs-reporting comparison
 *    computed from real telemetry, with coverage ratios for both periods.
 *    Rows with `verifiable = false` are kept, with the reason, rather than
 *    silently dropped or silently "verified".
 *  - `flex_load_programs` / `flex_load_enrollments`: admin-defined flexible
 *    load programs and per-user asset enrollments, linkable to real
 *    demandResponseEvents rows when dispatched. `incentiveCents` stays null
 *    until a real, recorded compensation exists — no invented payouts.
 *  - `portfolio_snapshots`: optional cache of multi-site rollups. The
 *    payload records per-site unavailable entries explicitly; a site with
 *    no data contributes nothing, not a fabricated zero.
 *
 * Integer-scaling conventions follow drizzle/schema.ts and
 * drizzle/grid-intel-schema.ts: energy in whole watt-hours, money in cents,
 * percentages * 100, rates per-day values * 1000 where fractional.
 */

import {
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
// Reuse the assets asset-type SQL enum WITHOUT importing './schema' (that
// would create a circular import: schema.ts re-exports this file for
// drizzle-kit). Declaring a local pgEnum with the same SQL name and values
// maps to the same database enum; drizzle-kit dedupes by SQL name.
export const assetsAssetTypeEnum = pgEnum("assets_asset_type", ["solar", "battery", "meter", "generator", "wind"]);

// ============================================================================
// 6. MAINTENANCE WORK ORDERS
// ============================================================================

export const workOrderStatusEnum = pgEnum('work_orders_status', [
  'open',
  'assigned',
  'in_progress',
  'done',
  'verified',
  'cancelled',
]);

export const workOrderPriorityEnum = pgEnum('work_orders_priority', [
  'low',
  'medium',
  'high',
  'critical',
]);

/**
 * What happened to a work order. `status_changed` carries from/to status;
 * `note` is a free-text actor-stamped comment that changes nothing.
 */
export const workOrderEventTypeEnum = pgEnum('work_order_events_type', [
  'created',
  'assigned',
  'status_changed',
  'note',
  'verified',
  'cancelled',
]);

export const workOrders = pgTable(
  'work_orders',
  {
    id: serial('id').primaryKey(),
    assetId: int('assetId').notNull(),
    /** The user who raised the order. */
    createdBy: int('createdBy').notNull(),
    /** Current assignee. Assignment itself is an admin/operator action. */
    assignedTo: int('assignedTo'),
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description'),
    priority: workOrderPriorityEnum('priority').default('medium').notNull(),
    status: workOrderStatusEnum('status').default('open').notNull(),
    /**
     * Optional links to the real detection rows that motivated this order.
     * Validated at creation: the referenced row must exist and, where it is
     * asset-scoped, must point at the same asset.
     */
    gridAnomalyScoreId: int('gridAnomalyScoreId'),
    ntlFlagId: int('ntlFlagId'),
    dueAt: timestamp('dueAt'),
    completedAt: timestamp('completedAt'),
    verifiedAt: timestamp('verifiedAt'),
    verifiedBy: int('verifiedBy'),
    createdAt: timestamp('createdAt').defaultNow().notNull(),
    updatedAt: timestamp('updatedAt').defaultNow().$onUpdate(() => new Date()).notNull(),
  },
  (t) => ({
    assetIdx: index('work_orders_asset_idx').on(t.assetId),
    statusIdx: index('work_orders_status_idx').on(t.status),
    assigneeIdx: index('work_orders_assignee_idx').on(t.assignedTo),
  })
);

export type WorkOrder = typeof workOrders.$inferSelect;
export type InsertWorkOrder = typeof workOrders.$inferInsert;

/**
 * Append-only event log. No updatedAt, no update path in the service:
 * history is never rewritten.
 */
export const workOrderEvents = pgTable(
  'work_order_events',
  {
    id: serial('id').primaryKey(),
    workOrderId: int('workOrderId').notNull(),
    actorUserId: int('actorUserId').notNull(),
    eventType: workOrderEventTypeEnum('eventType').notNull(),
    fromStatus: workOrderStatusEnum('fromStatus'),
    toStatus: workOrderStatusEnum('toStatus'),
    note: text('note'),
    createdAt: timestamp('createdAt').defaultNow().notNull(),
  },
  (t) => ({
    orderIdx: index('work_order_events_order_idx').on(t.workOrderId),
  })
);

export type WorkOrderEvent = typeof workOrderEvents.$inferSelect;
export type InsertWorkOrderEvent = typeof workOrderEvents.$inferInsert;

// ============================================================================
// 7. FIRMWARE CAMPAIGNS
// ============================================================================

export const firmwareCampaignStatusEnum = pgEnum('firmware_campaigns_status', [
  'draft',
  'active',
  'paused',
  'completed',
  'cancelled',
]);

/**
 * Per-target lifecycle. `applied` is reached ONLY when the device's own
 * reported firmwareVersion equals the campaign's expected version;
 * `failed` is only recorded by an operator with a reason (or by a device
 * error report, if one is ever integrated). Nothing auto-applies.
 */
export const firmwareTargetStatusEnum = pgEnum('firmware_targets_status', [
  'pending',
  'offered',
  'applied',
  'failed',
  'excluded',
]);

export const firmwareCampaigns = pgTable(
  'firmware_campaigns',
  {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    createdBy: int('createdBy').notNull(),
    /** Optional device-model filter used when targets are auto-selected. */
    model: varchar('model', { length: 255 }),
    /** Optional current-version filter used when targets are auto-selected. */
    fromVersion: varchar('fromVersion', { length: 50 }),
    /** The version every target is expected to reach. */
    targetVersion: varchar('targetVersion', { length: 50 }).notNull(),
    status: firmwareCampaignStatusEnum('status').default('draft').notNull(),
    notes: text('notes'),
    startedAt: timestamp('startedAt'),
    completedAt: timestamp('completedAt'),
    createdAt: timestamp('createdAt').defaultNow().notNull(),
    updatedAt: timestamp('updatedAt').defaultNow().$onUpdate(() => new Date()).notNull(),
  },
  (t) => ({
    statusIdx: index('firmware_campaigns_status_idx').on(t.status),
  })
);

export type FirmwareCampaign = typeof firmwareCampaigns.$inferSelect;
export type InsertFirmwareCampaign = typeof firmwareCampaigns.$inferInsert;

export const firmwareTargets = pgTable(
  'firmware_targets',
  {
    id: serial('id').primaryKey(),
    campaignId: int('campaignId').notNull(),
    /** Row in the real devices table. */
    deviceId: int('deviceId').notNull(),
    assetId: int('assetId').notNull(),
    /** Snapshot of the campaign's targetVersion at enrolment time. */
    expectedVersion: varchar('expectedVersion', { length: 50 }).notNull(),
    /**
     * The version the device itself last reported (devices.firmwareVersion
     * at observation time). Null means the device has never reported one;
     * the target stays pending — it is NOT treated as applied.
     */
    reportedVersion: varchar('reportedVersion', { length: 50 }),
    observedAt: timestamp('observedAt'),
    status: firmwareTargetStatusEnum('status').default('pending').notNull(),
    /** Operator-recorded reason for failed/excluded transitions. */
    statusReason: text('statusReason'),
    createdAt: timestamp('createdAt').defaultNow().notNull(),
    updatedAt: timestamp('updatedAt').defaultNow().$onUpdate(() => new Date()).notNull(),
  },
  (t) => ({
    campaignDeviceUnique: uniqueIndex('firmware_targets_campaign_device_unique').on(t.campaignId, t.deviceId),
    campaignIdx: index('firmware_targets_campaign_idx').on(t.campaignId),
  })
);

export type FirmwareTarget = typeof firmwareTargets.$inferSelect;
export type InsertFirmwareTarget = typeof firmwareTargets.$inferInsert;

// ============================================================================
// 8. M&V SAVINGS VERIFICATIONS
// ============================================================================

/**
 * One baseline-vs-reporting comparison for one asset. Both periods are
 * measured from real telemetry; coverage is the fraction of hourly buckets
 * in the period that contain at least one real sample. Rows where either
 * period falls below the minimum coverage are persisted with
 * `verifiable = false` and the reason, so a refused verification is as
 * auditable as an accepted one.
 */
export const savingsVerifications = pgTable(
  'savings_verifications',
  {
    id: serial('id').primaryKey(),
    assetId: int('assetId').notNull(),
    userId: int('userId').notNull(),

    /** e.g. 'ipmvp_option_c_unadjusted_wh_per_day' */
    method: varchar('method', { length: 64 }).notNull(),

    baselineStart: timestamp('baselineStart').notNull(),
    baselineEnd: timestamp('baselineEnd').notNull(),
    reportingStart: timestamp('reportingStart').notNull(),
    reportingEnd: timestamp('reportingEnd').notNull(),

    /** Coverage ratios, percent * 100. */
    baselineCoveragePct100: int('baselineCoveragePct100').notNull(),
    reportingCoveragePct100: int('reportingCoveragePct100').notNull(),

    baselineSampleCount: int('baselineSampleCount').notNull(),
    reportingSampleCount: int('reportingSampleCount').notNull(),

    /** Integrated energy per period (Wh); null when not computable. */
    baselineEnergyWh: int('baselineEnergyWh'),
    reportingEnergyWh: int('reportingEnergyWh'),
    /** Normalised daily energy, Wh/day * 1000, to compare unequal periods. */
    baselineWhPerDayMilli: int('baselineWhPerDayMilli'),
    reportingWhPerDayMilli: int('reportingWhPerDayMilli'),

    /**
     * Baseline-average power applied over the reporting period minus the
     * measured reporting energy. Null whenever verifiable is false.
     */
    savingsWh: int('savingsWh'),
    savingsWhPerDayMilli: int('savingsWhPerDayMilli'),

    verifiable: boolean('verifiable').notNull(),
    /** Why verification was refused (null when verifiable). */
    reason: text('reason'),

    createdAt: timestamp('createdAt').defaultNow().notNull(),
  },
  (t) => ({
    assetIdx: index('savings_verifications_asset_idx').on(t.assetId),
  })
);

export type SavingsVerification = typeof savingsVerifications.$inferSelect;
export type InsertSavingsVerification = typeof savingsVerifications.$inferInsert;

// ============================================================================
// 9. FLEXIBLE LOAD PROGRAMS
// ============================================================================

export const flexProgramStatusEnum = pgEnum('flex_load_programs_status', [
  'draft',
  'active',
  'retired',
]);

export const flexEnrollmentStatusEnum = pgEnum('flex_load_enrollments_status', [
  'active',
  'suspended',
  'withdrawn',
]);

export interface FlexEventWindowRules {
  /** Max dispatch events per UTC day for an enrolled asset. */
  maxEventsPerDay?: number;
  /** Allowed UTC hour window [startHour, endHour) for events, 0-23. */
  windowStartHour?: number;
  windowEndHour?: number;
  /** Max event duration in minutes. */
  maxEventMinutes?: number;
}

export const flexLoadPrograms = pgTable(
  'flex_load_programs',
  {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    createdBy: int('createdBy').notNull(),
    /** Which real asset type may enroll (reuses the core asset-type enum). */
    assetType: assetsAssetTypeEnum('assetType').notNull(),
    eventWindowRules: json('eventWindowRules').$type<FlexEventWindowRules>(),
    /**
     * Nullable on purpose: a program without a negotiated rate pays nothing
     * and says so (incentiveCents stays null on every enrollment).
     */
    incentiveRateCentsPerKwh: int('incentiveRateCentsPerKwh'),
    status: flexProgramStatusEnum('status').default('draft').notNull(),
    createdAt: timestamp('createdAt').defaultNow().notNull(),
    updatedAt: timestamp('updatedAt').defaultNow().$onUpdate(() => new Date()).notNull(),
  },
  (t) => ({
    statusIdx: index('flex_load_programs_status_idx').on(t.status),
  })
);

export type FlexLoadProgram = typeof flexLoadPrograms.$inferSelect;
export type InsertFlexLoadProgram = typeof flexLoadPrograms.$inferInsert;

export const flexLoadEnrollments = pgTable(
  'flex_load_enrollments',
  {
    id: serial('id').primaryKey(),
    programId: int('programId').notNull(),
    assetId: int('assetId').notNull(),
    userId: int('userId').notNull(),
    status: flexEnrollmentStatusEnum('status').default('active').notNull(),
    /**
     * The real demandResponseEvents row this enrollment was last dispatched
     * under. Null = never dispatched.
     */
    drEventId: int('drEventId'),
    dispatchedAt: timestamp('dispatchedAt'),
    /**
     * Incentive recorded for the last dispatch. Null until a real rate on
     * the program AND a real recorded compensation exist — never invented.
     */
    incentiveCents: int('incentiveCents'),
    createdAt: timestamp('createdAt').defaultNow().notNull(),
    updatedAt: timestamp('updatedAt').defaultNow().$onUpdate(() => new Date()).notNull(),
  },
  (t) => ({
    programAssetUnique: uniqueIndex('flex_load_enrollments_program_asset_unique').on(t.programId, t.assetId),
    userIdx: index('flex_load_enrollments_user_idx').on(t.userId),
  })
);

export type FlexLoadEnrollment = typeof flexLoadEnrollments.$inferSelect;
export type InsertFlexLoadEnrollment = typeof flexLoadEnrollments.$inferInsert;

// ============================================================================
// 10. PORTFOLIO SNAPSHOTS (optional cache)
// ============================================================================

/**
 * Cached rollup of one user's assets over one period. The payload keeps
 * per-site unavailable entries explicit (available:false + reason) so a
 * re-read never mistakes "no data" for "zero energy".
 */
export const portfolioSnapshots = pgTable(
  'portfolio_snapshots',
  {
    id: serial('id').primaryKey(),
    userId: int('userId').notNull(),
    periodStart: timestamp('periodStart').notNull(),
    periodEnd: timestamp('periodEnd').notNull(),
    periodLabel: varchar('periodLabel', { length: 32 }).notNull(),
    siteCount: int('siteCount').notNull(),
    unavailableSiteCount: int('unavailableSiteCount').notNull(),
    payload: json('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('createdAt').defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('portfolio_snapshots_user_idx').on(t.userId),
  })
);

export type PortfolioSnapshot = typeof portfolioSnapshots.$inferSelect;
export type InsertPortfolioSnapshot = typeof portfolioSnapshots.$inferInsert;
