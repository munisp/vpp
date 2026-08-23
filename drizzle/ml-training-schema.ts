/**
 * The training side of the model registry: what a model was trained on, by which
 * run, and what "normal" looked like in that data.
 *
 * `model_registry` predates this and could hold a row claiming `framework:
 * 'pytorch'` and a validation MAE with no artifact anywhere — nothing in the
 * platform trained anything, and queued `retraining_jobs` were never executed. A
 * registry row written by `services/ml` now points at a `training_datasets` row
 * (which names either the lake objects it read, with the digests re-hashed at read
 * time, or the generator/version/seed that produced it) and a `training_runs` row
 * (which holds the checkpoint path, the checkpoint's SHA-256 and the metrics
 * measured on held-out sequences). A run that could not train is `refused` with a
 * reason and carries no checkpoint, so an untrained model cannot be promoted.
 */

import {
  bigint,
  doublePrecision,
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

/**
 * `synthetic` is a first-class origin rather than a metadata flag, so a model
 * trained on generated fleet data can never be presented as trained on the
 * fleet's own history.
 */
export const trainingDataOriginEnum = pgEnum('training_data_origin', [
  'platform',
  'lakehouse',
  'synthetic',
]);

/** `refused` means the run declined to train (too little data, unverifiable lake). */
export const trainingRunStateEnum = pgEnum('training_run_state', [
  'running',
  'succeeded',
  'refused',
  'failed',
]);

export const trainingDatasets = pgTable(
  'training_datasets',
  {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 120 }).notNull(),
    origin: trainingDataOriginEnum('origin').notNull(),
    task: varchar('task', { length: 60 }).notNull(),
    featureSpec: jsonb('feature_spec').notNull(),
    /** Hash of the feature/label shape: two datasets only compare if it matches. */
    featureSpecDigest: varchar('feature_spec_digest', { length: 64 }).notNull(),
    windowStart: timestamp('window_start').notNull(),
    windowEnd: timestamp('window_end').notNull(),
    rows: int('rows').notNull(),
    sequences: int('sequences').notNull(),
    entities: int('entities').notNull(),
    /** Lake object keys read, required for a `lakehouse` dataset. */
    sourceObjects: text('source_objects').array().notNull().default([]),
    /** SHA-256 of each object as re-read, in the same order. */
    sourceDigests: text('source_digests').array().notNull().default([]),
    generator: varchar('generator', { length: 120 }),
    generatorVersion: varchar('generator_version', { length: 40 }),
    seed: bigint('seed', { mode: 'number' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    createdBy: varchar('created_by', { length: 120 }).notNull(),
  },
  table => ({
    nameIdx: index('training_datasets_name_idx').on(table.name, table.createdAt),
    originIdx: index('training_datasets_origin_idx').on(table.origin, table.createdAt),
  })
);

export const trainingRuns = pgTable(
  'training_runs',
  {
    id: serial('id').primaryKey(),
    datasetId: int('dataset_id').notNull(),
    /** Set only once the run registered a model version. */
    modelId: int('model_id'),
    modelName: varchar('model_name', { length: 100 }).notNull(),
    modelKind: varchar('model_kind', { length: 60 }).notNull(),
    state: trainingRunStateEnum('state').notNull(),
    framework: varchar('framework', { length: 60 }).notNull(),
    frameworkVersion: varchar('framework_version', { length: 40 }).notNull(),
    /** `local` or the Ray address actually connected to — never an aspiration. */
    compute: varchar('compute', { length: 200 }).notNull(),
    hyperparameters: jsonb('hyperparameters').notNull(),
    epochsRequested: int('epochs_requested').notNull(),
    epochsRan: int('epochs_ran').notNull().default(0),
    trainSequences: int('train_sequences').notNull().default(0),
    valSequences: int('val_sequences').notNull().default(0),
    /** The timestamp the train/validation split was cut at, not a row index. */
    splitAt: timestamp('split_at'),
    bestEpoch: int('best_epoch'),
    trainLoss: doublePrecision('train_loss'),
    valLoss: doublePrecision('val_loss'),
    metrics: jsonb('metrics'),
    checkpointPath: varchar('checkpoint_path', { length: 500 }),
    checkpointDigest: varchar('checkpoint_digest', { length: 64 }),
    checkpointBytes: int('checkpoint_bytes'),
    startedAt: timestamp('started_at').notNull().defaultNow(),
    finishedAt: timestamp('finished_at'),
    durationSeconds: int('duration_seconds'),
    runner: varchar('runner', { length: 120 }).notNull(),
    trigger: varchar('trigger', { length: 40 }).notNull(),
    retrainingJobId: varchar('retraining_job_id', { length: 64 }),
    refusalReason: varchar('refusal_reason', { length: 600 }),
    error: varchar('error', { length: 2000 }),
  },
  table => ({
    modelIdx: index('training_runs_model_idx').on(table.modelName, table.startedAt),
    stateIdx: index('training_runs_state_idx').on(table.state, table.startedAt),
  })
);

/**
 * The distribution drift is measured against. Previously this lived in Redis: an
 * eviction re-established "normal" from the current window, so drift silently
 * became undetectable after a cache restart. Here it is a row tied to the dataset
 * that produced the model.
 */
export const modelFeatureBaselines = pgTable(
  'model_feature_baselines',
  {
    id: serial('id').primaryKey(),
    modelId: int('model_id').notNull(),
    datasetId: int('dataset_id').notNull(),
    feature: varchar('feature', { length: 120 }).notNull(),
    mean: doublePrecision('mean').notNull(),
    std: doublePrecision('std').notNull(),
    p05: doublePrecision('p05').notNull(),
    p50: doublePrecision('p50').notNull(),
    p95: doublePrecision('p95').notNull(),
    binEdges: doublePrecision('bin_edges').array().notNull(),
    binShares: doublePrecision('bin_shares').array().notNull(),
    sampleCount: int('sample_count').notNull(),
    computedAt: timestamp('computed_at').notNull().defaultNow(),
  },
  table => ({
    perFeature: unique('model_feature_baselines_unique').on(table.modelId, table.feature),
    modelIdx: index('model_feature_baselines_model_idx').on(table.modelId),
  })
);
