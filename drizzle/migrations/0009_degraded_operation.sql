CREATE TYPE "public"."dependency_name" AS ENUM('optimizer', 'mqtt_broker', 'grid_protocols', 'matter_controller', 'payment_gateway', 'market_broker', 'meter_telemetry');--> statement-breakpoint
CREATE TYPE "public"."dependency_observation" AS ENUM('reachable', 'unreachable', 'faulted');--> statement-breakpoint
CREATE TABLE "dependency_observations" (
	"id" serial PRIMARY KEY NOT NULL,
	"dependency" "dependency_name" NOT NULL,
	"observation" "dependency_observation" NOT NULL,
	"observed_by" varchar(64) NOT NULL,
	"operation" varchar(128) NOT NULL,
	"latency_ms" integer,
	"detail" varchar(512),
	"observed_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "dependency_observations_dependency_idx" ON "dependency_observations" USING btree ("dependency","observed_at");--> statement-breakpoint
CREATE TABLE "dependency_outages" (
	"id" serial PRIMARY KEY NOT NULL,
	"dependency" "dependency_name" NOT NULL,
	"started_at" timestamp NOT NULL,
	"restored_at" timestamp,
	"opened_by" integer NOT NULL,
	"closed_by" integer,
	"failure_count" integer NOT NULL,
	"last_detail" varchar(512),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "dependency_outages_opened_by_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."dependency_observations"("id") ON DELETE RESTRICT,
	CONSTRAINT "dependency_outages_closed_by_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."dependency_observations"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX "dependency_outages_open_idx" ON "dependency_outages" USING btree ("dependency","restored_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dependency_outages_one_open_per_dependency" ON "dependency_outages" USING btree ("dependency") WHERE "restored_at" IS NULL;--> statement-breakpoint
CREATE TABLE "degraded_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"capability" varchar(64) NOT NULL,
	"subject" varchar(128) NOT NULL,
	"missing_dependencies" jsonb NOT NULL,
	"evidence_limit" varchar(512) NOT NULL,
	"acted_at" timestamp NOT NULL,
	"reconciled_at" timestamp,
	"reconciliation_note" varchar(512),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "degraded_actions_capability_idx" ON "degraded_actions" USING btree ("capability","acted_at");--> statement-breakpoint
CREATE INDEX "degraded_actions_open_idx" ON "degraded_actions" USING btree ("reconciled_at");
