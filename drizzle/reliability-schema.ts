/**
 * Customer-side supply reliability tables.
 *
 * A regulator, a lender and a customer all ask the same question — "how often
 * does the power go off here, and for how long?" — and the platform had no way
 * to answer it. The only figure resembling an answer was in the compliance
 * checker, which read the consumer-protection "service availability" rule
 * against the `health_checks` table: API uptime. A reader sees a supply
 * availability figure; the number describes whether the server answered.
 *
 * These two tables hold the evidence the real metrics (IEEE 1366 SAIFI, SAIDI,
 * CAIDI, ASAI, MAIFI) are computed from:
 *
 *  - `service_points` is the population. A metric per customer needs a count of
 *    customers, and that count has to exist before any average over it means
 *    anything. A service point also declares whether it is *monitored* — if
 *    nothing watches a connection, "no interruptions recorded" is unknown, not
 *    zero, and the metrics must say so rather than reporting perfect supply.
 *
 *  - `service_interruptions` is one loss of supply at one service point, with
 *    where the knowledge came from (`detection_source`) and a reference to that
 *    evidence. An open row (`ended_at IS NULL`) is an interruption still in
 *    progress, not a closed one of zero length.
 *
 * Deliberately not stored here: any derived index. SAIDI for a period is
 * recomputed from these rows so that a late-arriving restoration or a corrected
 * customer count changes the reported figure instead of leaving a stale one on
 * record.
 */

import {
  boolean,
  index,
  integer as int,
  pgEnum,
  pgTable,
  serial,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * Customer class, because reliability duty differs by what is connected: a
 * health facility losing supply is not the same event as a household doing so,
 * and reports are read that way.
 */
export const servicePointClassEnum = pgEnum('service_point_class', [
  'residential',
  'commercial',
  'industrial',
  'institutional',
  'public_service',
]);

/**
 * How this connection's supply is observed. `unmonitored` is a first-class
 * answer: it makes the connection count towards the customer population while
 * excluding it from any claim that it had no interruptions.
 */
export const servicePointMonitoringEnum = pgEnum('service_point_monitoring', [
  /** A meter or device reports on a known interval; gaps are detectable. */
  'metered_telemetry',
  /** Interruptions arrive only when an operator or the customer reports one. */
  'reported_only',
  /** Nothing observes this connection. Its silence carries no information. */
  'unmonitored',
]);

/** Why supply was lost, as far as it is known. `unknown` stays unknown. */
export const interruptionCauseEnum = pgEnum('interruption_cause', [
  'utility_grid_outage',
  'generation_shortfall',
  'storage_depleted',
  'equipment_fault',
  'planned_maintenance',
  'load_shedding',
  'payment_disconnection',
  'unknown',
]);

/**
 * Where the knowledge of this interruption came from. A telemetry gap is weaker
 * evidence than a meter's own last-gasp event, and a customer report is weaker
 * still; a report that mixes them has to be able to say so.
 */
export const interruptionDetectionEnum = pgEnum('interruption_detection_source', [
  'meter_event',
  'telemetry_gap',
  'device_offline_event',
  'operator_declared',
  'customer_reported',
]);

export const servicePoints = pgTable(
  'service_points',
  {
    id: serial('id').primaryKey(),
    /** The customer this connection serves. */
    userId: int('user_id').notNull(),
    /** The mini-grid or community it belongs to, when it belongs to one. */
    communityId: int('community_id'),
    /** Utility/operator reference for the connection, unique per deployment. */
    code: varchar('code', { length: 64 }).notNull(),
    pointClass: servicePointClassEnum('point_class').notNull(),
    monitoring: servicePointMonitoringEnum('monitoring').notNull(),
    /**
     * The meter or device whose reports stand for this connection's supply.
     * Required for `metered_telemetry`, enforced in the service.
     */
    meterAssetId: int('meter_asset_id'),
    /**
     * Expected reporting interval in seconds. Gap detection needs to know what
     * "late" means for this meter; without it no gap can be called an outage.
     */
    expectedReportIntervalSeconds: int('expected_report_interval_seconds'),
    /** When supply started here. Periods before this date do not count it. */
    connectedAt: timestamp('connected_at').notNull(),
    /** When it was permanently disconnected, if it was. */
    disconnectedAt: timestamp('disconnected_at'),
    registeredBy: int('registered_by').notNull(),
    notes: varchar('notes', { length: 500 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('service_points_code_key').on(table.code),
    index('service_points_community_idx').on(table.communityId),
    index('service_points_user_idx').on(table.userId),
  ]
);

export const serviceInterruptions = pgTable(
  'service_interruptions',
  {
    id: serial('id').primaryKey(),
    servicePointId: int('service_point_id').notNull(),
    startedAt: timestamp('started_at').notNull(),
    /** Null while supply has not been observed to return. */
    endedAt: timestamp('ended_at'),
    cause: interruptionCauseEnum('cause').notNull(),
    detectionSource: interruptionDetectionEnum('detection_source').notNull(),
    /**
     * What the claim rests on: a telemetry row id, a meter event id, an operator
     * user id, a ticket reference. Free text because the sources differ, but
     * never empty — an interruption nobody can trace is not evidence.
     */
    evidenceRef: varchar('evidence_ref', { length: 200 }).notNull(),
    /** Evidence that supply returned, recorded when the row is closed. */
    restoredEvidenceRef: varchar('restored_evidence_ref', { length: 200 }),
    /**
     * IEEE 1366 allows exceptional days to be reported separately so that one
     * storm does not hide a year of ordinary performance. Excluded rows are
     * still counted and reported, just under their own heading.
     */
    excludeFromIndices: boolean('exclude_from_indices').notNull().default(false),
    exclusionReason: varchar('exclusion_reason', { length: 200 }),
    recordedBy: int('recorded_by'),
    notes: varchar('notes', { length: 500 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('service_interruptions_point_start_key').on(table.servicePointId, table.startedAt),
    index('service_interruptions_started_idx').on(table.startedAt),
    index('service_interruptions_open_idx').on(table.servicePointId, table.endedAt),
  ]
);

export type ServicePointRow = typeof servicePoints.$inferSelect;
export type InsertServicePoint = typeof servicePoints.$inferInsert;
export type ServiceInterruptionRow = typeof serviceInterruptions.$inferSelect;
export type InsertServiceInterruption = typeof serviceInterruptions.$inferInsert;
