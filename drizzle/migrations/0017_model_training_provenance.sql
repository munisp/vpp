-- Where a model's numbers come from, recorded so a prediction can be traced back
-- to the bytes it was trained on.
--
-- `model_registry` already existed, but nothing ever trained anything: retraining
-- jobs were queued and never executed, and a row could claim `framework` and
-- `validation_mae` with no artifact behind it. These tables make the training
-- side of that auditable:
--
--   * `training_datasets` names its origin. A dataset built from lake objects
--     records every object key and digest it read; a synthetic dataset records
--     the generator, its version and its seed. `origin` is a hard column, not a
--     tag in a JSON blob, so a model trained on generated data can never be read
--     as trained on the fleet.
--   * `training_runs` is the run itself: epochs actually executed, the split
--     boundaries, the checkpoint path and its SHA-256, and the metrics measured
--     on held-out data. A run that produced no usable model is `failed` or
--     `refused` with a reason, and carries no checkpoint.
--   * `model_feature_baselines` is what drift is measured against. This used to
--     live in Redis, where an eviction silently re-established "normal" from
--     whatever the current window happened to look like — so drift could not be
--     detected across a cache restart. It is now a row tied to the training
--     dataset that produced it.
DO $$ BEGIN
  CREATE TYPE "public"."training_data_origin" AS ENUM ('platform', 'lakehouse', 'synthetic');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."training_run_state" AS ENUM ('running', 'succeeded', 'refused', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "training_datasets" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" varchar(120) NOT NULL,
  "origin" "public"."training_data_origin" NOT NULL,
  "task" varchar(60) NOT NULL,
  -- Feature/label shape, hashed so two datasets that disagree about the feature
  -- order cannot be compared as if they agreed.
  "feature_spec" jsonb NOT NULL,
  "feature_spec_digest" varchar(64) NOT NULL,
  "window_start" timestamp NOT NULL,
  "window_end" timestamp NOT NULL,
  "rows" integer NOT NULL,
  "sequences" integer NOT NULL,
  "entities" integer NOT NULL,
  -- Lake objects read, and their digests as re-hashed at read time. Required for
  -- a lakehouse-origin dataset; empty for platform and synthetic origins.
  "source_objects" text[] NOT NULL DEFAULT '{}',
  "source_digests" text[] NOT NULL DEFAULT '{}',
  -- Synthetic provenance. Required for a synthetic dataset so the run is
  -- reproducible from the seed alone.
  "generator" varchar(120),
  "generator_version" varchar(40),
  "seed" bigint,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "created_by" varchar(120) NOT NULL,
  CONSTRAINT "training_datasets_window_ordered" CHECK ("window_end" > "window_start"),
  CONSTRAINT "training_datasets_has_rows" CHECK ("rows" > 0 AND "sequences" > 0 AND "entities" > 0),
  -- A lake-origin dataset must name what it read, and name a digest per object.
  CONSTRAINT "training_datasets_lake_has_objects" CHECK (
    "origin" <> 'lakehouse'
    OR (COALESCE(array_length("source_objects", 1), 0) >= 1
        AND COALESCE(array_length("source_objects", 1), 0)
            = COALESCE(array_length("source_digests", 1), 0))
  ),
  -- A synthetic dataset must be reproducible: generator, version and seed.
  CONSTRAINT "training_datasets_synthetic_is_reproducible" CHECK (
    "origin" <> 'synthetic'
    OR ("generator" IS NOT NULL AND "generator_version" IS NOT NULL AND "seed" IS NOT NULL)
  ),
  -- ...and must not claim lake provenance it does not have.
  CONSTRAINT "training_datasets_synthetic_cites_no_objects" CHECK (
    "origin" <> 'synthetic' OR COALESCE(array_length("source_objects", 1), 0) = 0
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "training_datasets_name_idx" ON "training_datasets" ("name", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "training_datasets_origin_idx" ON "training_datasets" ("origin", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "training_runs" (
  "id" serial PRIMARY KEY NOT NULL,
  "dataset_id" integer NOT NULL REFERENCES "training_datasets" ("id") ON DELETE RESTRICT,
  -- Set once the run registers a model version; null while running, and for a
  -- run that refused or failed.
  "model_id" integer REFERENCES "model_registry" ("id") ON DELETE SET NULL,
  "model_name" varchar(100) NOT NULL,
  "model_kind" varchar(60) NOT NULL,
  "state" "public"."training_run_state" NOT NULL,
  "framework" varchar(60) NOT NULL,
  "framework_version" varchar(40) NOT NULL,
  -- 'local' or the Ray address the run actually connected to. Never a claim of
  -- distribution the run did not make.
  "compute" varchar(200) NOT NULL,
  "hyperparameters" jsonb NOT NULL,
  "epochs_requested" integer NOT NULL,
  "epochs_ran" integer NOT NULL DEFAULT 0,
  "train_sequences" integer NOT NULL DEFAULT 0,
  "val_sequences" integer NOT NULL DEFAULT 0,
  "split_at" timestamp,
  "best_epoch" integer,
  "train_loss" double precision,
  "val_loss" double precision,
  "metrics" jsonb,
  "checkpoint_path" varchar(500),
  "checkpoint_digest" varchar(64),
  "checkpoint_bytes" integer,
  "started_at" timestamp DEFAULT now() NOT NULL,
  "finished_at" timestamp,
  "duration_seconds" integer,
  "runner" varchar(120) NOT NULL,
  "trigger" varchar(40) NOT NULL,
  "retraining_job_id" varchar(64),
  "refusal_reason" varchar(600),
  "error" varchar(2000),
  -- A succeeded run has a stored checkpoint, its digest, held-out metrics and an
  -- epoch that produced them. Anything less is not a trained model.
  CONSTRAINT "training_runs_succeeded_has_artifact" CHECK (
    "state" <> 'succeeded'
    OR ("checkpoint_path" IS NOT NULL AND "checkpoint_digest" IS NOT NULL
        AND "checkpoint_bytes" IS NOT NULL AND "checkpoint_bytes" > 0
        AND "metrics" IS NOT NULL AND "best_epoch" IS NOT NULL
        AND "epochs_ran" >= 1 AND "val_sequences" >= 1
        AND "model_id" IS NOT NULL AND "finished_at" IS NOT NULL)
  ),
  CONSTRAINT "training_runs_refused_has_reason" CHECK (
    "state" <> 'refused'
    OR ("refusal_reason" IS NOT NULL AND "checkpoint_path" IS NULL
        AND "model_id" IS NULL AND "finished_at" IS NOT NULL)
  ),
  CONSTRAINT "training_runs_failed_has_error" CHECK (
    "state" <> 'failed' OR ("error" IS NOT NULL AND "finished_at" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "training_runs_model_idx" ON "training_runs" ("model_name", "started_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "training_runs_state_idx" ON "training_runs" ("state", "started_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_feature_baselines" (
  "id" serial PRIMARY KEY NOT NULL,
  "model_id" integer NOT NULL REFERENCES "model_registry" ("id") ON DELETE CASCADE,
  "dataset_id" integer NOT NULL REFERENCES "training_datasets" ("id") ON DELETE RESTRICT,
  "feature" varchar(120) NOT NULL,
  "mean" double precision NOT NULL,
  "std" double precision NOT NULL,
  "p05" double precision NOT NULL,
  "p50" double precision NOT NULL,
  "p95" double precision NOT NULL,
  -- Bin edges and the share of training values in each, for population stability.
  "bin_edges" double precision[] NOT NULL,
  "bin_shares" double precision[] NOT NULL,
  "sample_count" integer NOT NULL,
  "computed_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "model_feature_baselines_unique" UNIQUE ("model_id", "feature"),
  CONSTRAINT "model_feature_baselines_has_samples" CHECK ("sample_count" > 0),
  CONSTRAINT "model_feature_baselines_std_not_negative" CHECK ("std" >= 0),
  -- One share per bin, and edges bound those bins.
  CONSTRAINT "model_feature_baselines_bins_align" CHECK (
    COALESCE(array_length("bin_shares", 1), 0) >= 1
    AND COALESCE(array_length("bin_edges", 1), 0)
        = COALESCE(array_length("bin_shares", 1), 0) + 1
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_feature_baselines_model_idx"
  ON "model_feature_baselines" ("model_id");
--> statement-breakpoint
-- Which dataset and run a registry row came from. Existing rows keep NULLs: they
-- predate the training service and are honestly unprovenanced.
ALTER TABLE "model_registry"
  ADD COLUMN IF NOT EXISTS "training_dataset_id" integer
  REFERENCES "training_datasets" ("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "model_registry"
  ADD COLUMN IF NOT EXISTS "training_run_id" integer
  REFERENCES "training_runs" ("id") ON DELETE SET NULL;
--> statement-breakpoint
-- The version a rollback returned to, so "production" has a history rather than
-- just a current value.
ALTER TABLE "model_registry"
  ADD COLUMN IF NOT EXISTS "rolled_back_from_id" integer
  REFERENCES "model_registry" ("id") ON DELETE SET NULL;
--> statement-breakpoint
-- One production version per model name. The registry service already intended
-- this; without the index two concurrent promotions could both win and
-- inference would pick whichever row it read first.
CREATE UNIQUE INDEX IF NOT EXISTS "model_registry_one_production_per_name"
  ON "model_registry" ("model_name") WHERE "status" = 'production';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "model_registry_name_version_unique"
  ON "model_registry" ("model_name", "model_version");
