/**
 * Degraded-operation tables.
 *
 * A VPP that only works while every dependency is reachable is a VPP that stops
 * being a grid resource the moment a broker restarts. The platform therefore has
 * to keep running with parts of itself missing — and, far more important, has to
 * be honest about it: a dispatch decided without a live optimizer, a settlement
 * computed without the meter path, or a market bid placed without the broker are
 * all still decisions, but they are not decisions with the usual evidence.
 *
 * Nothing here is inferred:
 *   - a dependency is only "reachable" because a real call to it succeeded; the
 *     absence of failures is not health, so an observation older than the
 *     dependency's staleness bound reads as `unknown`, never as up;
 *   - an outage row is opened from consecutive observed failures and closed by
 *     an observed success, so the audit trail says who saw what and when;
 *   - anything the platform allows itself to do while degraded is recorded with
 *     the evidence it could not obtain, so a later reader cannot mistake it for
 *     a normally-evidenced action.
 */

import { sql } from 'drizzle-orm';
import {
  index,
  integer as int,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * The external things this platform cannot do its job without. Each one is named
 * rather than lumped into a single "backend healthy" flag, because losing the
 * market broker and losing the MQTT broker forbid completely different actions.
 */
export const dependencyEnum = pgEnum('dependency_name', [
  'optimizer',
  'mqtt_broker',
  'grid_protocols',
  'matter_controller',
  'payment_gateway',
  'market_broker',
  'meter_telemetry',
]);

/** What a real interaction with the dependency showed. */
export const observationEnum = pgEnum('dependency_observation', [
  /** The call completed and the dependency answered as expected. */
  'reachable',
  /** The call did not complete: connection refused, timeout, transport error. */
  'unreachable',
  /** The dependency answered, but refused or answered unusably. */
  'faulted',
]);

/**
 * One observation of one dependency, produced by real traffic rather than by a
 * synthetic ping wherever possible: a health endpoint that answers while the
 * work path fails is exactly the kind of plausible-looking signal this platform
 * is not allowed to rely on.
 */
export const dependencyObservations = pgTable(
  'dependency_observations',
  {
    id: serial('id').primaryKey(),
    dependency: dependencyEnum('dependency').notNull(),
    observation: observationEnum('observation').notNull(),
    /** Which process saw it, e.g. `server`, `gridd`, `modbus-poller`. */
    observedBy: varchar('observed_by', { length: 64 }).notNull(),
    /** The operation that produced the observation, e.g. `POST /optimize`. */
    operation: varchar('operation', { length: 128 }).notNull(),
    latencyMs: int('latency_ms'),
    /** Transport or protocol error text, kept verbatim for diagnosis. */
    detail: varchar('detail', { length: 512 }),
    observedAt: timestamp('observed_at').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  table => ({
    dependencyIdx: index('dependency_observations_dependency_idx').on(
      table.dependency,
      table.observedAt
    ),
  })
);

export type DependencyObservation = typeof dependencyObservations.$inferSelect;
export type InsertDependencyObservation = typeof dependencyObservations.$inferInsert;

/**
 * An open or closed outage of one dependency.
 *
 * Opened when consecutive failures reach the threshold — one timeout is not an
 * outage — and closed by an observed success. `restoredAt` being null is the
 * only statement that a dependency is currently down; readers never derive that
 * from the absence of recent traffic.
 */
export const dependencyOutages = pgTable(
  'dependency_outages',
  {
    id: serial('id').primaryKey(),
    dependency: dependencyEnum('dependency').notNull(),
    startedAt: timestamp('started_at').notNull(),
    restoredAt: timestamp('restored_at'),
    /** The observation that opened the outage. */
    openedBy: int('opened_by')
      .notNull()
      .references(() => dependencyObservations.id, { onDelete: 'restrict' }),
    /** The observation that closed it, null while the outage is open. */
    closedBy: int('closed_by').references(() => dependencyObservations.id, {
      onDelete: 'restrict',
    }),
    failureCount: int('failure_count').notNull(),
    lastDetail: varchar('last_detail', { length: 512 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => ({
    openIdx: index('dependency_outages_open_idx').on(table.dependency, table.restoredAt),
    /**
     * One open outage per dependency, enforced by the database: two concurrent
     * failure reports must not open two outages, or restoring one would leave
     * the dependency reading as down forever.
     */
    oneOpen: uniqueIndex('dependency_outages_one_open_per_dependency')
      .on(table.dependency)
      .where(sql`${table.restoredAt} IS NULL`),
  })
);

export type DependencyOutage = typeof dependencyOutages.$inferSelect;
export type InsertDependencyOutage = typeof dependencyOutages.$inferInsert;

/**
 * An action the platform took while a dependency it normally relies on was
 * unavailable, together with the evidence it therefore does not have.
 *
 * This is the point of the whole layer. Running degraded is acceptable; running
 * degraded and reporting the result as if nothing was missing is the silent
 * mockware this codebase exists to avoid.
 */
export const degradedActions = pgTable(
  'degraded_actions',
  {
    id: serial('id').primaryKey(),
    /** The guarded capability that was exercised, e.g. `control_dispatch`. */
    capability: varchar('capability', { length: 64 }).notNull(),
    /** Free-form reference to the thing produced, e.g. `control_assignment:41`. */
    subject: varchar('subject', { length: 128 }).notNull(),
    /** Dependencies that were down or unknown at the time. */
    missingDependencies: jsonb('missing_dependencies').notNull(),
    /** Plain statement of what cannot be proven about this action. */
    evidenceLimit: varchar('evidence_limit', { length: 512 }).notNull(),
    actedAt: timestamp('acted_at').notNull(),
    /** Set when the missing evidence was later obtained and the action reconciled. */
    reconciledAt: timestamp('reconciled_at'),
    reconciliationNote: varchar('reconciliation_note', { length: 512 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => ({
    capabilityIdx: index('degraded_actions_capability_idx').on(table.capability, table.actedAt),
    openIdx: index('degraded_actions_open_idx').on(table.reconciledAt),
  })
);

export type DegradedAction = typeof degradedActions.$inferSelect;
export type InsertDegradedAction = typeof degradedActions.$inferInsert;
