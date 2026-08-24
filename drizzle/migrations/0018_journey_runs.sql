-- Stakeholder journeys are re-run against the live services, so each run has to
-- be kept: without history, a step that has been blocked on an unprovisioned
-- provider for a month is indistinguishable from one that passed this morning,
-- and nobody can tell which service changed when a journey starts failing.
--
-- `journey_runs.run_key` is the idempotency key. A Temporal workflow retry
-- re-uses it and resumes the same run rather than forking a second one, which
-- is what makes a journey replayable instead of a one-off script.
--
-- `journey_step_results.facts` holds the values the step observed rather than a
-- rendered sentence, so two runs can be compared directly.
DO $$ BEGIN
  CREATE TYPE "public"."journey_run_state" AS ENUM ('running', 'passed', 'failed', 'blocked', 'aborted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
-- `refused` keeps a platform that correctly declined to act on evidence it does
-- not have out of the failure column; `blocked` keeps an absent external
-- provider out of the pass column.
DO $$ BEGIN
  CREATE TYPE "public"."journey_step_outcome" AS ENUM ('passed', 'refused', 'blocked', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "journey_runs" (
  "id" serial PRIMARY KEY NOT NULL,
  "journey_id" varchar(80) NOT NULL,
  "workflow_id" varchar(200),
  "suite_run_key" varchar(120),
  "run_key" varchar(160) NOT NULL,
  "state" "public"."journey_run_state" DEFAULT 'running' NOT NULL,
  "member_user_id" integer NOT NULL,
  "admin_user_id" integer,
  "started_at" timestamp DEFAULT now() NOT NULL,
  "finished_at" timestamp,
  "error" text,
  CONSTRAINT "journey_runs_run_key_unique" UNIQUE("run_key"),
  -- A finished run has a state that is not `running`, and a running one has no
  -- finish time. Without this a crashed worker leaves a row that reads as an
  -- in-progress journey forever.
  CONSTRAINT "journey_runs_finished_state" CHECK (
    ("finished_at" IS NULL AND "state" = 'running')
    OR ("finished_at" IS NOT NULL AND "state" <> 'running')
  )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "journey_step_results" (
  "id" serial PRIMARY KEY NOT NULL,
  "run_id" integer NOT NULL,
  "step_id" varchar(80) NOT NULL,
  "outcome" "public"."journey_step_outcome" NOT NULL,
  "detail" text NOT NULL,
  "facts" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "duration_ms" integer NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  -- One result per step per run: an activity retried by Temporal overwrites its
  -- own result instead of appending a second, contradictory one.
  CONSTRAINT "journey_step_results_run_step_unique" UNIQUE("run_id","step_id"),
  CONSTRAINT "journey_step_results_run_fk" FOREIGN KEY ("run_id")
    REFERENCES "journey_runs"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journey_runs_journey_idx" ON "journey_runs" ("journey_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journey_runs_suite_idx" ON "journey_runs" ("suite_run_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journey_step_results_run_idx" ON "journey_step_results" ("run_id");
