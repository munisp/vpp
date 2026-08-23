-- The lakehouse had no record of itself. `services/lakehouse/etl_pipeline.py`
-- dumped a whole day at a time and ignored the return value of its own loader,
-- so an S3 failure logged "ETL completed successfully" and left a hole no query
-- could find. Analytics, and later any model trained on this data, would read a
-- partial day as the day.
--
-- `lakehouse_watermarks` is how far each dataset is ingested, advanced only after
-- the object store confirms the object. `lakehouse_runs` is every attempt, with
-- the rows and bytes it actually wrote, the object it wrote them to and the
-- verbatim error when it failed.
DO $$ BEGIN
  CREATE TYPE "public"."lakehouse_run_state" AS ENUM ('running', 'succeeded', 'empty', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lakehouse_watermarks" (
  "dataset" varchar(80) PRIMARY KEY NOT NULL,
  "watermark_at" timestamp,
  "watermark_id" bigint,
  "rows_ingested" bigint DEFAULT 0 NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  -- A watermark is a position in a totally ordered stream: either both halves are
  -- known or the dataset has never been ingested. A half-set watermark would make
  -- the next run's `(change_at, id) > (?, ?)` comparison silently match nothing.
  CONSTRAINT "lakehouse_watermarks_whole_position" CHECK (
    ("watermark_at" IS NULL AND "watermark_id" IS NULL)
    OR ("watermark_at" IS NOT NULL AND "watermark_id" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lakehouse_runs" (
  "id" serial PRIMARY KEY NOT NULL,
  "dataset" varchar(80) NOT NULL,
  "state" "public"."lakehouse_run_state" DEFAULT 'running' NOT NULL,
  "runner" varchar(120) NOT NULL,
  "started_at" timestamp DEFAULT now() NOT NULL,
  "finished_at" timestamp,
  "rows_written" integer DEFAULT 0 NOT NULL,
  "bytes_written" bigint DEFAULT 0 NOT NULL,
  "object_key" varchar(400),
  "object_digest" varchar(64),
  "from_watermark_at" timestamp,
  "from_watermark_id" bigint,
  "to_watermark_at" timestamp,
  "to_watermark_id" bigint,
  "error" varchar(2000),
  -- "succeeded" means the bytes are in the store: it must name the object it
  -- wrote and the digest of what was written, or it is not evidence of anything.
  CONSTRAINT "lakehouse_runs_succeeded_has_object" CHECK (
    "state" <> 'succeeded'
    OR ("object_key" IS NOT NULL AND "object_digest" IS NOT NULL AND "rows_written" > 0
        AND "finished_at" IS NOT NULL)
  ),
  -- A failure must say why, in the store's or the database's own words.
  CONSTRAINT "lakehouse_runs_failed_has_error" CHECK (
    "state" <> 'failed' OR ("error" IS NOT NULL AND "finished_at" IS NOT NULL)
  ),
  -- Finding no new rows writes no object, so it cannot claim one.
  CONSTRAINT "lakehouse_runs_empty_wrote_nothing" CHECK (
    "state" <> 'empty'
    OR ("object_key" IS NULL AND "rows_written" = 0 AND "finished_at" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lakehouse_runs_dataset_idx" ON "lakehouse_runs" ("dataset", "started_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lakehouse_runs_state_idx" ON "lakehouse_runs" ("state", "started_at");
