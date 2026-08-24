/**
 * Stakeholder journey runs: what was exercised, when, and what it saw.
 *
 * A journey is not a test fixture — it is a stakeholder's path through the
 * platform, replayed on demand or on a schedule against the real services. That
 * only has value if each run is kept: a step that passed last week and fails
 * today names the service that changed, and a step that has been `blocked` for
 * a month names an integration nobody has provisioned.
 *
 * `journey_step_results.facts` holds the named values the step observed (ids,
 * counts, states) rather than a rendered message, so two runs can be compared
 * without re-reading prose. It is deliberately not the platform's own data: a
 * journey run is evidence about the platform, and deleting every run must not
 * change a single member's balance, control or settlement.
 */

import {
  index,
  integer as int,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from 'drizzle-orm/pg-core';

export const journeyRunStateEnum = pgEnum('journey_run_state', [
  'running',
  'passed',
  'failed',
  'blocked',
  'aborted',
]);

/**
 * Mirrors `StepOutcome` in `shared/journeys.ts`.
 *
 * `refused` exists so a platform that correctly declined to act on evidence it
 * does not have is not recorded as broken, and `blocked` so an absent external
 * provider is never recorded as a pass.
 */
export const journeyStepOutcomeEnum = pgEnum('journey_step_outcome', [
  'passed',
  'refused',
  'blocked',
  'failed',
]);

export const journeyRuns = pgTable(
  'journey_runs',
  {
    id: serial('id').primaryKey(),
    journeyId: varchar('journey_id', { length: 80 }).notNull(),
    /**
     * The Temporal workflow execution that drove the run. A run with no
     * workflow id was driven directly (a CLI or a test), which is worth being
     * able to tell apart when reading history.
     */
    workflowId: varchar('workflow_id', { length: 200 }),
    /** Set when this run is one journey of a suite run. */
    suiteRunKey: varchar('suite_run_key', { length: 120 }),
    /** Idempotency key: a retried workflow resumes its run instead of forking one. */
    runKey: varchar('run_key', { length: 160 }).notNull(),
    state: journeyRunStateEnum('state').notNull().default('running'),
    /** The member principal the journey acted as. */
    memberUserId: int('member_user_id').notNull(),
    /** The operator principal, for steps a member must not be able to perform. */
    adminUserId: int('admin_user_id'),
    startedAt: timestamp('started_at').notNull().defaultNow(),
    finishedAt: timestamp('finished_at'),
    /** Verbatim reason the run stopped early, when it did. */
    error: text('error'),
  },
  table => ({
    runKeyUnique: unique('journey_runs_run_key_unique').on(table.runKey),
    journeyIdx: index('journey_runs_journey_idx').on(table.journeyId, table.startedAt),
    suiteIdx: index('journey_runs_suite_idx').on(table.suiteRunKey),
  })
);

export const journeyStepResults = pgTable(
  'journey_step_results',
  {
    id: serial('id').primaryKey(),
    runId: int('run_id').notNull(),
    stepId: varchar('step_id', { length: 80 }).notNull(),
    outcome: journeyStepOutcomeEnum('outcome').notNull(),
    detail: text('detail').notNull(),
    facts: jsonb('facts').notNull().default({}),
    durationMs: int('duration_ms').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  table => ({
    stepUnique: unique('journey_step_results_run_step_unique').on(table.runId, table.stepId),
    runIdx: index('journey_step_results_run_idx').on(table.runId),
  })
);

export type JourneyRunRow = typeof journeyRuns.$inferSelect;
export type JourneyStepResultRow = typeof journeyStepResults.$inferSelect;
