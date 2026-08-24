-- Protocol conformance evidence: what the platform has proved it can speak.
--
-- The point of these tables is that `der_capabilities.protocols` is a list
-- somebody typed. A run here is an executed vector set with every case's
-- outcome, the peer it ran against, the operator and an artifact checksum.
--
-- The check constraints are the honesty rules, in the database rather than only
-- in the service, because a passing run is what lets money and grid actuation
-- lean on an adapter:
--   * the case counts must add up to the total, so a run cannot claim more
--     passes than cases it carried;
--   * `passed` requires a non-empty set with nothing failed and nothing
--     skipped, so an empty or half-run suite cannot be recorded as a pass;
--   * the checksum must look like a SHA-256 digest, so "n/a" cannot sit in the
--     column where evidence belongs.

DO $$ BEGIN
	CREATE TYPE "public"."conformance_adapter" AS ENUM('ocpp16', 'ocpp201', 'openadr2b', 'ieee2030_5', 'modbus_sunspec', 'matter');
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."conformance_target" AS ENUM('simulator', 'device');
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."conformance_run_outcome" AS ENUM('passed', 'failed', 'refused');
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."conformance_case_outcome" AS ENUM('pass', 'fail', 'skipped');
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conformance_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"adapter" "conformance_adapter" NOT NULL,
	"adapter_version" varchar(64) NOT NULL,
	"protocol_version" varchar(32) NOT NULL,
	"device_model" varchar(191) NOT NULL,
	"device_identifier" varchar(191),
	"target" "conformance_target" NOT NULL,
	"vector_set_id" varchar(128) NOT NULL,
	"vector_set_version" varchar(32) NOT NULL,
	"total_cases" integer NOT NULL,
	"passed_cases" integer NOT NULL,
	"failed_cases" integer NOT NULL,
	"skipped_cases" integer NOT NULL,
	"outcome" "conformance_run_outcome" NOT NULL,
	"operator" varchar(191) NOT NULL,
	"started_at" timestamp NOT NULL,
	"completed_at" timestamp NOT NULL,
	"artifact_checksum" varchar(64) NOT NULL,
	"artifact_uri" text,
	"detail" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "conformance_runs_counts_agree" CHECK (
		"passed_cases" + "failed_cases" + "skipped_cases" = "total_cases"
		AND "passed_cases" >= 0 AND "failed_cases" >= 0 AND "skipped_cases" >= 0
	),
	CONSTRAINT "conformance_runs_passed_is_complete" CHECK (
		"outcome" <> 'passed'
		OR ("total_cases" > 0 AND "passed_cases" = "total_cases"
		    AND "failed_cases" = 0 AND "skipped_cases" = 0)
	),
	CONSTRAINT "conformance_runs_checksum_sha256" CHECK ("artifact_checksum" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "conformance_runs_window_ordered" CHECK ("completed_at" >= "started_at")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conformance_runs_adapter_idx" ON "conformance_runs" ("adapter", "completed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conformance_runs_outcome_idx" ON "conformance_runs" ("outcome", "completed_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conformance_cases" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"case_id" varchar(128) NOT NULL,
	"name" varchar(255) NOT NULL,
	"requirement" text NOT NULL,
	"outcome" "conformance_case_outcome" NOT NULL,
	"detail" text,
	"evidence" jsonb,
	CONSTRAINT "conformance_cases_run_case_unique" UNIQUE ("run_id", "case_id"),
	CONSTRAINT "conformance_cases_run_id_fk" FOREIGN KEY ("run_id")
		REFERENCES "conformance_runs"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conformance_cases_run_idx" ON "conformance_cases" ("run_id");
--> statement-breakpoint
-- A certification with no run behind it is the thing this table exists to stop,
-- so the reference is NOT NULL and ON DELETE RESTRICT: the evidence cannot be
-- deleted out from under a certification that cites it.
CREATE TABLE IF NOT EXISTS "der_protocol_certifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"asset_id" integer NOT NULL,
	"adapter" "conformance_adapter" NOT NULL,
	"conformance_run_id" integer NOT NULL,
	"certified_by" varchar(191) NOT NULL,
	"certified_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp,
	"note" text,
	CONSTRAINT "der_protocol_certifications_asset_adapter_run_unique" UNIQUE ("asset_id", "adapter", "conformance_run_id"),
	CONSTRAINT "der_protocol_certifications_run_id_fk" FOREIGN KEY ("conformance_run_id")
		REFERENCES "conformance_runs"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "der_protocol_certifications_asset_idx" ON "der_protocol_certifications" ("asset_id", "adapter");
--> statement-breakpoint
-- Every control now carries the proof state of the wire that delivered it,
-- frozen at issue time. Nullable because controls issued before this migration
-- were never assessed, and backfilling them with any value would be inventing
-- evidence: null reads as "not assessed", which is what it is.
DO $$ BEGIN
	CREATE TYPE "public"."control_assignments_protocol_proof" AS ENUM('proven', 'claimed_unproven', 'suite_failed', 'proof_stale', 'no_suite');
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "control_assignments" ADD COLUMN IF NOT EXISTS "protocol_proof" "control_assignments_protocol_proof";
--> statement-breakpoint
ALTER TABLE "control_assignments" ADD COLUMN IF NOT EXISTS "protocol_proof_run_id" integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "control_assignments_protocol_proof_idx" ON "control_assignments" ("protocol_proof", "created_at");
