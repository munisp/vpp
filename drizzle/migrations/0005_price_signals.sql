CREATE TYPE "public"."price_signal_status" AS ENUM('draft', 'published', 'scored', 'not_converged');--> statement-breakpoint
CREATE TYPE "public"."price_signal_delivery" AS ENUM('pending', 'broker_queued', 'failed');--> statement-breakpoint
CREATE TYPE "public"."price_signal_response" AS ENUM('unmeasured', 'followed', 'deviated', 'no_telemetry');--> statement-breakpoint
CREATE TABLE "price_signals" (
	"id" serial PRIMARY KEY NOT NULL,
	"signal_id" varchar(64) NOT NULL,
	"scope_type" varchar(32) NOT NULL,
	"scope_id" integer,
	"region" varchar(50),
	"status" "price_signal_status" DEFAULT 'draft' NOT NULL,
	"interval_minutes" integer NOT NULL,
	"starts_at" timestamp NOT NULL,
	"ends_at" timestamp NOT NULL,
	"solver" varchar(50) NOT NULL,
	"iterations" integer NOT NULL,
	"max_deviation_watts" integer NOT NULL,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"published_at" timestamp,
	"scored_at" timestamp,
	CONSTRAINT "price_signals_signal_id_unique" UNIQUE("signal_id")
);
--> statement-breakpoint
CREATE TABLE "price_signal_intervals" (
	"id" serial PRIMARY KEY NOT NULL,
	"signal_id" varchar(64) NOT NULL,
	"interval_index" integer NOT NULL,
	"starts_at" timestamp NOT NULL,
	"base_import_price_value" integer NOT NULL,
	"signal_adjustment_value" integer NOT NULL,
	"target_net_watts" integer,
	"planned_net_watts" integer NOT NULL,
	CONSTRAINT "price_signal_intervals_signal_index_unique" UNIQUE("signal_id","interval_index")
);
--> statement-breakpoint
CREATE TABLE "price_signal_sites" (
	"id" serial PRIMARY KEY NOT NULL,
	"signal_id" varchar(64) NOT NULL,
	"site_ref" varchar(64) NOT NULL,
	"user_id" integer,
	"planned_net_watts" jsonb NOT NULL,
	"planned_net_wh" integer NOT NULL,
	"planned_bill_cents" integer NOT NULL,
	"delivery" "price_signal_delivery" DEFAULT 'pending' NOT NULL,
	"delivery_detail" varchar(255),
	"delivered_at" timestamp,
	"response" "price_signal_response" DEFAULT 'unmeasured' NOT NULL,
	"actual_net_wh" integer,
	"telemetry_samples" integer DEFAULT 0 NOT NULL,
	"scored_at" timestamp,
	CONSTRAINT "price_signal_sites_signal_site_unique" UNIQUE("signal_id","site_ref")
);
--> statement-breakpoint
ALTER TABLE "price_signal_intervals" ADD CONSTRAINT "price_signal_intervals_signal_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."price_signals"("signal_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "price_signal_sites" ADD CONSTRAINT "price_signal_sites_signal_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."price_signals"("signal_id") ON DELETE CASCADE;--> statement-breakpoint
CREATE INDEX "price_signals_scope_idx" ON "price_signals" USING btree ("scope_type","scope_id");--> statement-breakpoint
CREATE INDEX "price_signals_starts_at_idx" ON "price_signals" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "price_signals_status_idx" ON "price_signals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "price_signal_intervals_signal_idx" ON "price_signal_intervals" USING btree ("signal_id","interval_index");--> statement-breakpoint
CREATE INDEX "price_signal_sites_signal_idx" ON "price_signal_sites" USING btree ("signal_id");--> statement-breakpoint
CREATE INDEX "price_signal_sites_user_idx" ON "price_signal_sites" USING btree ("user_id");
