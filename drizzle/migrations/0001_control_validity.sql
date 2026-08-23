CREATE TYPE "public"."control_assignments_delivery" AS ENUM('accepted', 'rejected', 'unconfirmed');--> statement-breakpoint
CREATE TYPE "public"."control_assignments_fallback_outcome" AS ENUM('applied', 'device_offline', 'rejected', 'unconfirmed', 'not_required');--> statement-breakpoint
CREATE TYPE "public"."control_assignments_fallback_policy" AS ENUM('safe_limit', 'resume_local', 'hold_last');--> statement-breakpoint
CREATE TYPE "public"."control_assignments_protocol" AS ENUM('ocpp16', 'sep2', 'openadr', 'modbus');--> statement-breakpoint
CREATE TYPE "public"."control_assignments_source" AS ENUM('optimizer', 'v2g_schedule', 'dr_event', 'grid_instruction', 'manual');--> statement-breakpoint
CREATE TYPE "public"."control_fallback_events_outcome" AS ENUM('applied', 'device_offline', 'rejected', 'unconfirmed');--> statement-breakpoint
CREATE TYPE "public"."control_fallback_events_reason" AS ENUM('window_expired', 'superseded', 'device_offline', 'operator_revoked');--> statement-breakpoint
CREATE TABLE "control_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"protocol" "control_assignments_protocol" NOT NULL,
	"target_ref" varchar(191) NOT NULL,
	"sub_target_ref" integer DEFAULT 0 NOT NULL,
	"command_ref" varchar(128),
	"asset_id" integer,
	"ev_id" integer,
	"user_id" integer,
	"source" "control_assignments_source" NOT NULL,
	"source_id" integer,
	"setpoint_watts" integer,
	"valid_from" timestamp NOT NULL,
	"valid_to" timestamp NOT NULL,
	"fallback_policy" "control_assignments_fallback_policy" NOT NULL,
	"fallback_limit_watts" integer,
	"delivery" "control_assignments_delivery" NOT NULL,
	"delivery_detail" text,
	"superseded_at" timestamp,
	"fallback_claimed_at" timestamp,
	"fallback_applied_at" timestamp,
	"fallback_outcome" "control_assignments_fallback_outcome",
	"fallback_detail" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "control_assignments_bounded_window" CHECK ("control_assignments"."valid_to" > "control_assignments"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "control_fallback_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"assignment_id" integer NOT NULL,
	"reason" "control_fallback_events_reason" NOT NULL,
	"outcome" "control_fallback_events_outcome" NOT NULL,
	"detail" text NOT NULL,
	"occurred_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "control_fallback_events" ADD CONSTRAINT "control_fallback_events_assignment_id_control_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."control_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "control_assignments_target_idx" ON "control_assignments" USING btree ("protocol","target_ref","valid_to");--> statement-breakpoint
CREATE INDEX "control_assignments_asset_idx" ON "control_assignments" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "control_assignments_expiry_idx" ON "control_assignments" USING btree ("valid_to");--> statement-breakpoint
CREATE INDEX "control_assignments_fallback_claim_idx" ON "control_assignments" USING btree ("delivery","valid_to","fallback_claimed_at");--> statement-breakpoint
CREATE INDEX "control_fallback_events_assignment_idx" ON "control_fallback_events" USING btree ("assignment_id");