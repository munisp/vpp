-- Design studies: sizing a site before it is built, with the assumptions frozen.
--
-- The recommendation columns are all nullable and constrained to agree with the
-- status, so a study that concluded nothing cannot be read as a study that
-- recommended nothing to build. A served-nothing candidate has no LCOE and a
-- no-saving candidate has no payback; zero in either column would read as free
-- power and as instant payback.

DO $$ BEGIN
	CREATE TYPE "public"."profile_source" AS ENUM('metered', 'declared', 'sourced', 'synthetic');
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."design_study_status" AS ENUM('optimal', 'no_feasible_candidate', 'service_unavailable', 'refused');
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "design_studies" (
	"id" serial PRIMARY KEY NOT NULL,
	"reference" varchar(120) NOT NULL UNIQUE,
	"site_name" varchar(200) NOT NULL,
	"node_id" integer,
	"notes" varchar(500),
	"created_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "design_studies_node_id_fk" FOREIGN KEY ("node_id")
		REFERENCES "grid_nodes"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "design_studies_node_idx" ON "design_studies" ("node_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "design_study_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"study_id" integer NOT NULL,
	"version" integer NOT NULL,
	"status" "design_study_status" NOT NULL,
	"reason" varchar(500),
	"input_digest" varchar(64) NOT NULL,
	"request" jsonb NOT NULL,
	"response" jsonb,
	"load_source" "profile_source" NOT NULL,
	"load_reference" varchar(200),
	"recommended_pv_w" integer,
	"recommended_wind_w" integer,
	"recommended_battery_wh" integer,
	"recommended_battery_w" integer,
	"unmet_ppm" integer,
	"lcoe_cents_per_kwh_x100" integer,
	"payback_months" integer,
	"capex_cents" bigint,
	"fuel_litres_saved_per_year" integer,
	"emissions_kg_saved_per_year" integer,
	"network_study_id" integer,
	"network_status" "feasibility_status",
	"created_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "design_study_versions_study_version_unique" UNIQUE ("study_id", "version"),
	CONSTRAINT "design_study_versions_study_id_fk" FOREIGN KEY ("study_id")
		REFERENCES "design_studies"("id") ON DELETE CASCADE,
	CONSTRAINT "design_study_versions_network_study_id_fk" FOREIGN KEY ("network_study_id")
		REFERENCES "network_feasibility_studies"("id") ON DELETE SET NULL,
	-- A sizing exists only where a candidate met the stated tolerance, and a
	-- status that recommended nothing carries no sizing to build from.
	CONSTRAINT "design_study_versions_sizing_matches_status" CHECK (
		("status" = 'optimal'
			AND "recommended_pv_w" IS NOT NULL
			AND "recommended_wind_w" IS NOT NULL
			AND "recommended_battery_wh" IS NOT NULL
			AND "recommended_battery_w" IS NOT NULL
			AND "unmet_ppm" IS NOT NULL
			AND "capex_cents" IS NOT NULL)
		OR ("status" <> 'optimal'
			AND "recommended_pv_w" IS NULL
			AND "recommended_wind_w" IS NULL
			AND "recommended_battery_wh" IS NULL
			AND "recommended_battery_w" IS NULL
			AND "unmet_ppm" IS NULL
			AND "capex_cents" IS NULL
			AND "lcoe_cents_per_kwh_x100" IS NULL
			AND "payback_months" IS NULL)
	),
	-- Nothing was sized, so nothing was refused or approved by the network
	-- either: an unchecked recommendation is the null case, not a pass.
	CONSTRAINT "design_study_versions_network_check_pairs" CHECK (
		("network_study_id" IS NULL AND "network_status" IS NULL)
		OR ("network_study_id" IS NOT NULL AND "network_status" IS NOT NULL AND "status" = 'optimal')
	),
	-- A study that could not run says why. A version with no reason and no
	-- recommendation would be a silent failure.
	CONSTRAINT "design_study_versions_reason_when_nothing_recommended" CHECK (
		"status" = 'optimal' OR "reason" IS NOT NULL
	),
	CONSTRAINT "design_study_versions_version_positive" CHECK ("version" >= 1),
	CONSTRAINT "design_study_versions_unmet_in_range" CHECK (
		"unmet_ppm" IS NULL OR ("unmet_ppm" >= 0 AND "unmet_ppm" <= 1000000)
	)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "design_study_versions_digest_idx" ON "design_study_versions" ("input_digest");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "design_study_versions_created_idx" ON "design_study_versions" ("created_at");
