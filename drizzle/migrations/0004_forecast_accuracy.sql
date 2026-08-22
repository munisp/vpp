CREATE TYPE "public"."forecast_accuracy_actual_source" AS ENUM('telemetry', 'grid_monitoring', 'market_prices', 'emissions_factors');--> statement-breakpoint
CREATE TYPE "public"."forecast_accuracy_status" AS ENUM('scored', 'insufficient_actuals');--> statement-breakpoint
CREATE TABLE "forecast_accuracy" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" varchar(64) NOT NULL,
	"forecast_type" varchar(32) NOT NULL,
	"scope_type" varchar(32) NOT NULL,
	"scope_id" integer,
	"region" varchar(50),
	"model_version" varchar(50) NOT NULL,
	"actual_source" "forecast_accuracy_actual_source" NOT NULL,
	"status" "forecast_accuracy_status" NOT NULL,
	"sample_count" integer NOT NULL,
	"mae_value" integer,
	"rmse_value" integer,
	"mape_bp" integer,
	"bias_value" integer,
	"coverage_bp" integer,
	"interval_width_value" integer,
	"scored_through" timestamp NOT NULL,
	"scored_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "forecast_accuracy_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE INDEX "forecast_accuracy_type_scope_idx" ON "forecast_accuracy" USING btree ("forecast_type","scope_type","scope_id");--> statement-breakpoint
CREATE INDEX "forecast_accuracy_scored_at_idx" ON "forecast_accuracy" USING btree ("scored_at");
