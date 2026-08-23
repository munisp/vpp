-- Diagnosis with a local model, and the lake-derived baselines it reasons against.
--
-- The failure mode being designed out is a diagnostic tool that answers when it
-- has nothing to answer from. So:
--   * a finding must cite at least one observation (checked here, and the service
--     drops citations that were not in the evidence before inserting),
--   * a run that reached no model is stored as 'refused' with the reason, and
--     cannot carry an answer,
--   * a baseline must name the lake objects and the row count behind it, so an
--     "anomaly vs baseline" statement is always backed by stored bytes.
DO $$ BEGIN
  CREATE TYPE "public"."diagnostic_run_state" AS ENUM ('succeeded', 'refused', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "diagnostic_runs" (
  "id" serial PRIMARY KEY NOT NULL,
  "state" "public"."diagnostic_run_state" NOT NULL,
  "question" varchar(2000) NOT NULL,
  "model" varchar(160),
  "endpoint" varchar(300),
  "requested_by" integer NOT NULL,
  "started_at" timestamp DEFAULT now() NOT NULL,
  "finished_at" timestamp,
  "latency_ms" integer,
  "evidence" jsonb NOT NULL,
  "evidence_digest" varchar(64) NOT NULL,
  "answer" text,
  "refusal_reason" varchar(600),
  "rejected_citations" integer DEFAULT 0 NOT NULL,
  "error" varchar(2000),
  -- An answer is only an answer if a named model produced it and the run finished.
  CONSTRAINT "diagnostic_runs_succeeded_has_answer" CHECK (
    "state" <> 'succeeded'
    OR ("answer" IS NOT NULL AND "model" IS NOT NULL AND "finished_at" IS NOT NULL)
  ),
  -- A refusal must say why, and must not smuggle out a partial answer as one.
  CONSTRAINT "diagnostic_runs_refused_has_reason" CHECK (
    "state" <> 'refused'
    OR ("refusal_reason" IS NOT NULL AND "answer" IS NULL AND "finished_at" IS NOT NULL)
  ),
  CONSTRAINT "diagnostic_runs_failed_has_error" CHECK (
    "state" <> 'failed' OR ("error" IS NOT NULL AND "finished_at" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "diagnostic_runs_state_idx" ON "diagnostic_runs" ("state", "started_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "diagnostic_runs_requested_by_idx" ON "diagnostic_runs" ("requested_by", "started_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "diagnostic_findings" (
  "id" serial PRIMARY KEY NOT NULL,
  "run_id" integer NOT NULL REFERENCES "diagnostic_runs" ("id") ON DELETE CASCADE,
  "title" varchar(300) NOT NULL,
  "hypothesis" text NOT NULL,
  "recommended_action" text NOT NULL,
  "confidence" varchar(12) NOT NULL,
  "observation_ids" text[] NOT NULL,
  CONSTRAINT "diagnostic_findings_confidence_known" CHECK (
    "confidence" IN ('low', 'medium', 'high')
  ),
  -- The whole point: no finding without evidence behind it. array_length() of an
  -- empty array is NULL, and a NULL CHECK passes, so it is coalesced.
  CONSTRAINT "diagnostic_findings_cites_evidence" CHECK (
    COALESCE(array_length("observation_ids", 1), 0) >= 1
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "diagnostic_findings_run_idx" ON "diagnostic_findings" ("run_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lakehouse_baselines" (
  "id" serial PRIMARY KEY NOT NULL,
  "dataset" varchar(80) NOT NULL,
  "metric" varchar(120) NOT NULL,
  "unit" varchar(40) NOT NULL,
  "window_start" timestamp NOT NULL,
  "window_end" timestamp NOT NULL,
  "value" double precision NOT NULL,
  "sample_rows" bigint NOT NULL,
  "source_objects" text[] NOT NULL,
  "computed_at" timestamp DEFAULT now() NOT NULL,
  "runner" varchar(120) NOT NULL,
  -- A baseline with no rows behind it is a number with no meaning.
  CONSTRAINT "lakehouse_baselines_has_sample" CHECK ("sample_rows" > 0),
  -- ...and it must say which stored objects it read.
  CONSTRAINT "lakehouse_baselines_has_provenance" CHECK (
    COALESCE(array_length("source_objects", 1), 0) >= 1
  ),
  CONSTRAINT "lakehouse_baselines_window_ordered" CHECK ("window_end" > "window_start")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lakehouse_baselines_window_key"
  ON "lakehouse_baselines" ("dataset", "metric", "window_start", "window_end");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lakehouse_baselines_dataset_idx"
  ON "lakehouse_baselines" ("dataset", "computed_at");
