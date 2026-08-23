/**
 * The lakehouse's own record of what it has actually ingested.
 *
 * Before this, `services/lakehouse/etl_pipeline.py` ran (if anyone ran it) as a
 * daily whole-day dump whose loader returned `False` on an S3 failure into a
 * caller that ignored the result and logged "ETL completed successfully". There
 * was no record of which windows had been ingested, so a silent failure looked
 * exactly like a quiet day, and a reader had no way to tell an empty dataset
 * from a pipeline that never ran.
 *
 * These two tables are the evidence instead:
 *
 *   - `lakehouse_watermarks` is how far each dataset has been ingested. It only
 *     advances after the object store has confirmed the object, so a crash
 *     mid-run re-reads the same rows rather than skipping them.
 *   - `lakehouse_runs` is every attempt, successful or not, with the row count,
 *     the object it wrote and the error if it failed — which is what lets the
 *     platform say "this dataset is 40 minutes stale because the last three runs
 *     could not reach MinIO" instead of showing a stale figure as current.
 *
 * Nothing here is written by the API server; the ingestion job owns both tables
 * and the server only reads them.
 */

import {
  bigint,
  index,
  integer as int,
  pgEnum,
  pgTable,
  serial,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * How a run ended.
 *
 * `empty` is distinct from `succeeded` on purpose: a run that found no new rows
 * wrote no object, so counting it as a successful load would make an idle
 * pipeline and a working one indistinguishable in the object store.
 */
export const lakehouseRunStateEnum = pgEnum('lakehouse_run_state', [
  'running',
  'succeeded',
  'empty',
  'failed',
]);

export const lakehouseWatermarks = pgTable('lakehouse_watermarks', {
  dataset: varchar('dataset', { length: 80 }).primaryKey(),
  /** The change time of the last row ingested; NULL means nothing ingested yet. */
  watermarkAt: timestamp('watermark_at'),
  /** Tie-break within the same change time, so simultaneous rows are not skipped. */
  watermarkId: bigint('watermark_id', { mode: 'number' }),
  rowsIngested: bigint('rows_ingested', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const lakehouseRuns = pgTable(
  'lakehouse_runs',
  {
    id: serial('id').primaryKey(),
    dataset: varchar('dataset', { length: 80 }).notNull(),
    state: lakehouseRunStateEnum('state').notNull().default('running'),
    /** Which process ran it, so two schedulers writing the same dataset are visible. */
    runner: varchar('runner', { length: 120 }).notNull(),
    startedAt: timestamp('started_at').notNull().defaultNow(),
    finishedAt: timestamp('finished_at'),
    rowsWritten: int('rows_written').notNull().default(0),
    bytesWritten: bigint('bytes_written', { mode: 'number' }).notNull().default(0),
    /** The object this run wrote, as the store confirmed it. NULL when nothing was written. */
    objectKey: varchar('object_key', { length: 400 }),
    /** SHA-256 of the object's bytes, so a reader can verify what it downloaded. */
    objectDigest: varchar('object_digest', { length: 64 }),
    fromWatermarkAt: timestamp('from_watermark_at'),
    fromWatermarkId: bigint('from_watermark_id', { mode: 'number' }),
    toWatermarkAt: timestamp('to_watermark_at'),
    toWatermarkId: bigint('to_watermark_id', { mode: 'number' }),
    /** Kept verbatim from the store or the database; never summarised into "failed". */
    error: varchar('error', { length: 2000 }),
  },
  table => ({
    datasetIdx: index('lakehouse_runs_dataset_idx').on(table.dataset, table.startedAt),
    stateIdx: index('lakehouse_runs_state_idx').on(table.state, table.startedAt),
  })
);

export type LakehouseRunState = (typeof lakehouseRunStateEnum.enumValues)[number];
export type LakehouseRunRow = typeof lakehouseRuns.$inferSelect;
export type LakehouseWatermarkRow = typeof lakehouseWatermarks.$inferSelect;
