-- The evidence behind a customer supply reliability figure.
--
-- Before this table pair the platform had no record of a customer losing power.
-- The nearest thing to one was the consumer-protection compliance check, which
-- measured the EWURA "service availability" requirement against the
-- `health_checks` table — API uptime presented where a regulator reads supply
-- availability. Nothing here derives supply from platform health.
--
-- `service_points` is the customer population an average is taken over, and it
-- records whether each connection is observed at all: an unmonitored connection
-- counts as a customer but its silence is not evidence of uninterrupted supply.
-- `service_interruptions` is one loss of supply, with the source of the claim
-- and a reference to it. Indices (SAIFI/SAIDI/CAIDI/ASAI/MAIFI) are recomputed
-- from these rows rather than stored, so a late restoration corrects the figure.
DO $$ BEGIN
  CREATE TYPE "public"."service_point_class" AS ENUM ('residential', 'commercial', 'industrial', 'institutional', 'public_service');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."service_point_monitoring" AS ENUM ('metered_telemetry', 'reported_only', 'unmonitored');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."interruption_cause" AS ENUM ('utility_grid_outage', 'generation_shortfall', 'storage_depleted', 'equipment_fault', 'planned_maintenance', 'load_shedding', 'payment_disconnection', 'unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."interruption_detection_source" AS ENUM ('meter_event', 'telemetry_gap', 'device_offline_event', 'operator_declared', 'customer_reported');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_points" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"community_id" integer,
	"code" varchar(64) NOT NULL,
	"point_class" "service_point_class" NOT NULL,
	"monitoring" "service_point_monitoring" NOT NULL,
	"meter_asset_id" integer,
	"expected_report_interval_seconds" integer,
	"connected_at" timestamp NOT NULL,
	"disconnected_at" timestamp,
	"registered_by" integer NOT NULL,
	"notes" varchar(500),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "service_points_interval_positive" CHECK ("expected_report_interval_seconds" IS NULL OR "expected_report_interval_seconds" > 0),
	CONSTRAINT "service_points_metered_needs_meter" CHECK ("monitoring" <> 'metered_telemetry' OR ("meter_asset_id" IS NOT NULL AND "expected_report_interval_seconds" IS NOT NULL)),
	CONSTRAINT "service_points_disconnect_after_connect" CHECK ("disconnected_at" IS NULL OR "disconnected_at" > "connected_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "service_points_code_key" ON "service_points" ("code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_points_community_idx" ON "service_points" ("community_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_points_user_idx" ON "service_points" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_interruptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_point_id" integer NOT NULL,
	"started_at" timestamp NOT NULL,
	"ended_at" timestamp,
	"cause" "interruption_cause" NOT NULL,
	"detection_source" "interruption_detection_source" NOT NULL,
	"evidence_ref" varchar(200) NOT NULL,
	"restored_evidence_ref" varchar(200),
	"exclude_from_indices" boolean DEFAULT false NOT NULL,
	"exclusion_reason" varchar(200),
	"recorded_by" integer,
	"notes" varchar(500),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "service_interruptions_evidence_present" CHECK (length(btrim("evidence_ref")) > 0),
	CONSTRAINT "service_interruptions_ends_after_start" CHECK ("ended_at" IS NULL OR "ended_at" > "started_at"),
	CONSTRAINT "service_interruptions_exclusion_explained" CHECK ("exclude_from_indices" = false OR length(btrim(coalesce("exclusion_reason", ''))) > 0),
	CONSTRAINT "service_interruptions_restored_evidence_when_closed" CHECK ("ended_at" IS NULL OR length(btrim(coalesce("restored_evidence_ref", ''))) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "service_interruptions_point_start_key" ON "service_interruptions" ("service_point_id", "started_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_interruptions_started_idx" ON "service_interruptions" ("started_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_interruptions_open_idx" ON "service_interruptions" ("service_point_id", "ended_at");
