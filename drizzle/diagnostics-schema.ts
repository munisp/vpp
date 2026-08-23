/**
 * What a local model was asked, what it was shown, and what it answered.
 *
 * The danger with an LLM in an operational tool is not that it is wrong; it is
 * that a wrong answer is indistinguishable from a right one. So a diagnostic run
 * stores the exact evidence it was given (`evidence` plus its digest) alongside
 * the answer, and a finding cannot exist without naming the observations it rests
 * on — `diagnostic_findings.observation_ids` is `NOT NULL` with a cardinality
 * check, and the service drops any citation that was not in the evidence before
 * inserting. A run that could not reach the model, or had no evidence to send, is
 * stored as `refused` with the reason, never as an answer.
 */

import {
  doublePrecision,
  index,
  integer as int,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
  bigint,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * `refused` is the important one: no model was consulted, or it was consulted and
 * its answer was unusable, and the platform says so instead of composing
 * something plausible from templates.
 */
export const diagnosticRunStateEnum = pgEnum('diagnostic_run_state', [
  'succeeded',
  'refused',
  'failed',
]);

export const diagnosticRuns = pgTable(
  'diagnostic_runs',
  {
    id: serial('id').primaryKey(),
    state: diagnosticRunStateEnum('state').notNull(),
    question: varchar('question', { length: 2000 }).notNull(),
    /** The model as the server reported it, not as it was requested. */
    model: varchar('model', { length: 160 }),
    endpoint: varchar('endpoint', { length: 300 }),
    requestedBy: int('requested_by').notNull(),
    startedAt: timestamp('started_at').notNull().defaultNow(),
    finishedAt: timestamp('finished_at'),
    latencyMs: int('latency_ms'),
    /** Exactly what the model was shown, so the answer can be re-read against it. */
    evidence: jsonb('evidence').notNull(),
    evidenceDigest: varchar('evidence_digest', { length: 64 }).notNull(),
    /** The model's own text, unedited. */
    answer: text('answer'),
    refusalReason: varchar('refusal_reason', { length: 600 }),
    /** Citations the model invented, dropped before storing the findings. */
    rejectedCitations: int('rejected_citations').notNull().default(0),
    error: varchar('error', { length: 2000 }),
  },
  table => ({
    stateIdx: index('diagnostic_runs_state_idx').on(table.state, table.startedAt),
    requesterIdx: index('diagnostic_runs_requested_by_idx').on(table.requestedBy, table.startedAt),
  })
);

export const diagnosticFindings = pgTable(
  'diagnostic_findings',
  {
    id: serial('id').primaryKey(),
    runId: int('run_id')
      .notNull()
      .references(() => diagnosticRuns.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 300 }).notNull(),
    hypothesis: text('hypothesis').notNull(),
    recommendedAction: text('recommended_action').notNull(),
    /** 'low' | 'medium' | 'high', checked in the migration. */
    confidence: varchar('confidence', { length: 12 }).notNull(),
    /** Observation ids from the evidence; verified to exist before insert. */
    observationIds: text('observation_ids').array().notNull(),
  },
  table => ({
    runIdx: index('diagnostic_findings_run_idx').on(table.runId),
  })
);

/**
 * Aggregates computed from objects the lakehouse actually stored.
 *
 * A baseline is only meaningful with its provenance, so `source_objects` lists the
 * Parquet keys it was read from and `sample_rows` how many rows were behind it —
 * both constrained non-empty. Diagnostics then compares live Postgres counts
 * against these and can say "reads are 6x the 30-day baseline computed from 412k
 * rows in 9 objects" rather than asserting an anomaly with nothing behind it.
 */
export const lakehouseBaselines = pgTable(
  'lakehouse_baselines',
  {
    id: serial('id').primaryKey(),
    dataset: varchar('dataset', { length: 80 }).notNull(),
    metric: varchar('metric', { length: 120 }).notNull(),
    unit: varchar('unit', { length: 40 }).notNull(),
    windowStart: timestamp('window_start').notNull(),
    windowEnd: timestamp('window_end').notNull(),
    value: doublePrecision('value').notNull(),
    sampleRows: bigint('sample_rows', { mode: 'number' }).notNull(),
    sourceObjects: text('source_objects').array().notNull(),
    computedAt: timestamp('computed_at').notNull().defaultNow(),
    runner: varchar('runner', { length: 120 }).notNull(),
  },
  table => ({
    windowIdx: uniqueIndex('lakehouse_baselines_window_key').on(
      table.dataset,
      table.metric,
      table.windowStart,
      table.windowEnd
    ),
    datasetIdx: index('lakehouse_baselines_dataset_idx').on(table.dataset, table.computedAt),
  })
);

export type DiagnosticRunState = (typeof diagnosticRunStateEnum.enumValues)[number];
export type DiagnosticRunRow = typeof diagnosticRuns.$inferSelect;
export type DiagnosticFindingRow = typeof diagnosticFindings.$inferSelect;
export type LakehouseBaselineRow = typeof lakehouseBaselines.$inferSelect;
