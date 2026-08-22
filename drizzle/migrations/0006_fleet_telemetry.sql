CREATE TYPE "public"."fleet_window_scope" AS ENUM('fleet', 'community', 'region');--> statement-breakpoint
CREATE TYPE "public"."fleet_window_state" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TABLE "fleet_telemetry_windows" (
	"id" serial PRIMARY KEY NOT NULL,
	"scope_type" "fleet_window_scope" NOT NULL,
	"scope_key" varchar(96) NOT NULL,
	"scope_id" integer,
	"region" varchar(50),
	"bucket_starts_at" timestamp NOT NULL,
	"bucket_minutes" integer NOT NULL,
	"state" "fleet_window_state" DEFAULT 'open' NOT NULL,
	"mean_net_power_watts" integer NOT NULL,
	"integrated_energy_wh" integer NOT NULL,
	"expected_assets" integer NOT NULL,
	"reporting_assets" integer NOT NULL,
	"silent_assets" integer NOT NULL,
	"samples" integer NOT NULL,
	"reporting_capacity_wh" integer NOT NULL,
	"silent_capacity_wh" integer NOT NULL,
	"soc_known_assets" integer NOT NULL,
	"soc_unknown_assets" integer NOT NULL,
	"available_energy_wh" integer NOT NULL,
	"computed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "fleet_telemetry_windows_scope_bucket_unique" UNIQUE("scope_key","bucket_starts_at","bucket_minutes")
);
--> statement-breakpoint
CREATE INDEX "fleet_telemetry_windows_scope_idx" ON "fleet_telemetry_windows" USING btree ("scope_key","bucket_starts_at");--> statement-breakpoint
CREATE INDEX "fleet_telemetry_windows_state_idx" ON "fleet_telemetry_windows" USING btree ("state");
