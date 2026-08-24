-- The critical-load register behind a resilience figure.
--
-- Island autonomy used to be computed as `shared_capacity_kw * 2` ("assume a
-- 2-hour battery") and critical loads were reported as served whenever measured
-- generation exceeded half of measured load. Both answers look like engineering
-- and are actually guesses about a site nobody surveyed. This table is the
-- survey: which loads must stay energised, at what power, in what priority, for
-- how long, and who said so.
--
-- Storage energy is not duplicated here. `assets.capacity` already holds
-- watt-hours for batteries and `der_capabilities.min_soc` / `max_power_export`
-- already hold the usable floor and the discharge limit; the assessment reads
-- those and names the ones that are missing instead of defaulting them.
DO $$ BEGIN
  CREATE TYPE "public"."critical_load_category" AS ENUM ('health', 'water', 'education', 'communications', 'security', 'cold_chain', 'agriculture', 'residential', 'commercial', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."critical_load_rating_source" AS ENUM ('nameplate', 'commissioning_measurement', 'operator_estimate');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "critical_loads" (
	"id" serial PRIMARY KEY NOT NULL,
	"community_id" integer NOT NULL,
	"asset_id" integer,
	"label" varchar(160) NOT NULL,
	"category" "critical_load_category" NOT NULL,
	"priority" integer DEFAULT 1 NOT NULL,
	"rated_power_w" integer NOT NULL,
	"rating_source" "critical_load_rating_source" NOT NULL,
	"autonomy_target_hours" integer,
	"active" boolean DEFAULT true NOT NULL,
	"declared_by" integer NOT NULL,
	"notes" varchar(500),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "critical_loads_rated_power_positive" CHECK ("rated_power_w" > 0),
	CONSTRAINT "critical_loads_autonomy_target_positive" CHECK ("autonomy_target_hours" IS NULL OR "autonomy_target_hours" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "critical_loads_community_label_key" ON "critical_loads" ("community_id", "label");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "critical_loads_community_priority_idx" ON "critical_loads" ("community_id", "priority");
