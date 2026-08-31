CREATE TYPE "public"."demand_charge_alerts_status" AS ENUM('alert', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."ev_charging_plans_status" AS ENUM('scheduled', 'active', 'completed', 'cancelled', 'infeasible');--> statement-breakpoint
CREATE TYPE "public"."ev_charging_sessions_source" AS ENUM('telemetry');--> statement-breakpoint
CREATE TYPE "public"."firmware_campaigns_status" AS ENUM('draft', 'active', 'paused', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."firmware_targets_status" AS ENUM('pending', 'offered', 'applied', 'failed', 'excluded');--> statement-breakpoint
CREATE TYPE "public"."flex_load_enrollments_status" AS ENUM('active', 'suspended', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."flex_load_programs_status" AS ENUM('draft', 'active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."work_order_events_type" AS ENUM('created', 'assigned', 'status_changed', 'note', 'verified', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."work_orders_priority" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."work_orders_status" AS ENUM('open', 'assigned', 'in_progress', 'done', 'verified', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."challenge_entries_status" AS ENUM('active', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."community_challenges_metric" AS ENUM('consumption_reduction_pct');--> statement-breakpoint
CREATE TYPE "public"."community_challenges_status" AS ENUM('open', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."digest_subscriptions_channel" AS ENUM('email', 'sms');--> statement-breakpoint
CREATE TYPE "public"."digest_runs_status" AS ENUM('sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."grid_service_revenues_source" AS ENUM('dr_compensation', 'p2p_match', 'referral_reward');--> statement-breakpoint
CREATE TYPE "public"."inverter_faults_status" AS ENUM('open', 'acknowledged', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."inverter_faults_type" AS ENUM('zero_output_daylight', 'error_code_reported', 'sustained_underperformance');--> statement-breakpoint
CREATE TYPE "public"."offset_listings_status" AS ENUM('active', 'sold', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."capacity_bid_status" AS ENUM('draft', 'submitted', 'awarded', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."export_job_format" AS ENUM('csv', 'espi_xml');--> statement-breakpoint
CREATE TYPE "public"."export_job_scope" AS ENUM('usage', 'billing', 'both');--> statement-breakpoint
CREATE TYPE "public"."export_job_status" AS ENUM('queued', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "appliance_estimates" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"assetId" integer NOT NULL,
	"windowStart" timestamp NOT NULL,
	"windowEnd" timestamp NOT NULL,
	"spanDays10" integer NOT NULL,
	"applianceClass" varchar(40) NOT NULL,
	"estimatedWh" integer NOT NULL,
	"shareMilliPct" integer NOT NULL,
	"confidenceMilli" integer NOT NULL,
	"method" varchar(60) NOT NULL,
	"sampleCount" integer NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demand_charge_alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"assetId" integer NOT NULL,
	"windowMinutes" integer NOT NULL,
	"thresholdKw10" integer NOT NULL,
	"windowStart" timestamp NOT NULL,
	"windowEnd" timestamp NOT NULL,
	"sampleCount" integer NOT NULL,
	"observedWindowAvgKw10" integer NOT NULL,
	"projectedPeakKw10" integer NOT NULL,
	"projectedExcessKw10" integer NOT NULL,
	"projectionMethod" varchar(60) NOT NULL,
	"status" "demand_charge_alerts_status" DEFAULT 'alert' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ev_charging_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"assetId" integer NOT NULL,
	"country" "dynamic_tariffs_country" NOT NULL,
	"departureTime" timestamp NOT NULL,
	"targetSocPct100" integer NOT NULL,
	"startSocPct100" integer,
	"capacityWh" integer NOT NULL,
	"maxChargePowerW" integer NOT NULL,
	"tariffId" integer,
	"scheduleAvailable" boolean DEFAULT false NOT NULL,
	"unavailableReason" varchar(40),
	"energyNeededWh" integer,
	"windows" json,
	"expectedCostCents" integer,
	"naiveImmediateCostCents" integer,
	"status" "ev_charging_plans_status" DEFAULT 'scheduled' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ev_charging_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"planId" integer,
	"userId" integer NOT NULL,
	"assetId" integer NOT NULL,
	"startedAt" timestamp NOT NULL,
	"endedAt" timestamp NOT NULL,
	"startSocPct100" integer NOT NULL,
	"endSocPct100" integer NOT NULL,
	"capacityWh" integer NOT NULL,
	"energyWh" integer NOT NULL,
	"sampleCount" integer NOT NULL,
	"source" "ev_charging_sessions_source" DEFAULT 'telemetry' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outage_risk_scores" (
	"id" serial PRIMARY KEY NOT NULL,
	"assetId" integer NOT NULL,
	"userId" integer NOT NULL,
	"windowStart" timestamp NOT NULL,
	"windowEnd" timestamp NOT NULL,
	"spanDays10" integer NOT NULL,
	"telemetrySampleCount" integer NOT NULL,
	"anomalyComponentMilli" integer,
	"telemetryGapComponentMilli" integer,
	"gridQualityComponentMilli" integer,
	"scoreMilli" integer,
	"anomalyScoreCount" integer NOT NULL,
	"severeAnomalyCount" integer NOT NULL,
	"gapRatioMilli" integer,
	"voltageSampleCount" integer NOT NULL,
	"voltageViolationCount" integer,
	"frequencySampleCount" integer NOT NULL,
	"frequencyViolationCount" integer,
	"insufficientData" boolean DEFAULT false NOT NULL,
	"reason" text,
	"computedAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tariff_comparisons" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"country" "dynamic_tariffs_country" NOT NULL,
	"windowStart" timestamp,
	"windowEnd" timestamp,
	"spanDays10" integer,
	"usageWh" integer,
	"hourlyUsageWh" json,
	"available" boolean DEFAULT false NOT NULL,
	"unavailableReason" varchar(40),
	"results" json NOT NULL,
	"cheapestTariffId" integer,
	"cheapestCostCents" integer,
	"currentTariffId" integer,
	"savingsVsCurrentCents" integer,
	"computedAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "firmware_campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"createdBy" integer NOT NULL,
	"model" varchar(255),
	"fromVersion" varchar(50),
	"targetVersion" varchar(50) NOT NULL,
	"status" "firmware_campaigns_status" DEFAULT 'draft' NOT NULL,
	"notes" text,
	"startedAt" timestamp,
	"completedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "firmware_targets" (
	"id" serial PRIMARY KEY NOT NULL,
	"campaignId" integer NOT NULL,
	"deviceId" integer NOT NULL,
	"assetId" integer NOT NULL,
	"expectedVersion" varchar(50) NOT NULL,
	"reportedVersion" varchar(50),
	"observedAt" timestamp,
	"status" "firmware_targets_status" DEFAULT 'pending' NOT NULL,
	"statusReason" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flex_load_enrollments" (
	"id" serial PRIMARY KEY NOT NULL,
	"programId" integer NOT NULL,
	"assetId" integer NOT NULL,
	"userId" integer NOT NULL,
	"status" "flex_load_enrollments_status" DEFAULT 'active' NOT NULL,
	"drEventId" integer,
	"dispatchedAt" timestamp,
	"incentiveCents" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flex_load_programs" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"createdBy" integer NOT NULL,
	"assetType" "assets_asset_type" NOT NULL,
	"eventWindowRules" json,
	"incentiveRateCentsPerKwh" integer,
	"status" "flex_load_programs_status" DEFAULT 'draft' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolio_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"periodStart" timestamp NOT NULL,
	"periodEnd" timestamp NOT NULL,
	"periodLabel" varchar(32) NOT NULL,
	"siteCount" integer NOT NULL,
	"unavailableSiteCount" integer NOT NULL,
	"payload" json NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "savings_verifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"assetId" integer NOT NULL,
	"userId" integer NOT NULL,
	"method" varchar(64) NOT NULL,
	"baselineStart" timestamp NOT NULL,
	"baselineEnd" timestamp NOT NULL,
	"reportingStart" timestamp NOT NULL,
	"reportingEnd" timestamp NOT NULL,
	"baselineCoveragePct100" integer NOT NULL,
	"reportingCoveragePct100" integer NOT NULL,
	"baselineSampleCount" integer NOT NULL,
	"reportingSampleCount" integer NOT NULL,
	"baselineEnergyWh" integer,
	"reportingEnergyWh" integer,
	"baselineWhPerDayMilli" integer,
	"reportingWhPerDayMilli" integer,
	"savingsWh" integer,
	"savingsWhPerDayMilli" integer,
	"verifiable" boolean NOT NULL,
	"reason" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_order_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"workOrderId" integer NOT NULL,
	"actorUserId" integer NOT NULL,
	"eventType" "work_order_events_type" NOT NULL,
	"fromStatus" "work_orders_status",
	"toStatus" "work_orders_status",
	"note" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"assetId" integer NOT NULL,
	"createdBy" integer NOT NULL,
	"assignedTo" integer,
	"title" varchar(255) NOT NULL,
	"description" text,
	"priority" "work_orders_priority" DEFAULT 'medium' NOT NULL,
	"status" "work_orders_status" DEFAULT 'open' NOT NULL,
	"gridAnomalyScoreId" integer,
	"ntlFlagId" integer,
	"dueAt" timestamp,
	"completedAt" timestamp,
	"verifiedAt" timestamp,
	"verifiedBy" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "challenge_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"challengeId" integer NOT NULL,
	"userId" integer NOT NULL,
	"status" "challenge_entries_status" DEFAULT 'active' NOT NULL,
	"joinedAt" timestamp DEFAULT now() NOT NULL,
	"withdrawnAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "community_challenges" (
	"id" serial PRIMARY KEY NOT NULL,
	"creatorUserId" integer NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"metric" "community_challenges_metric" NOT NULL,
	"goalPercent100" integer NOT NULL,
	"baselineStart" timestamp NOT NULL,
	"baselineEnd" timestamp NOT NULL,
	"periodStart" timestamp NOT NULL,
	"periodEnd" timestamp NOT NULL,
	"status" "community_challenges_status" DEFAULT 'open' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "digest_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"subscriptionId" integer NOT NULL,
	"userId" integer NOT NULL,
	"channel" "digest_subscriptions_channel" NOT NULL,
	"periodStart" timestamp NOT NULL,
	"periodEnd" timestamp NOT NULL,
	"stats" json NOT NULL,
	"status" "digest_runs_status" NOT NULL,
	"error" text,
	"sentAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "digest_subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"channel" "digest_subscriptions_channel" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grid_service_revenues" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"sourceType" "grid_service_revenues_source" NOT NULL,
	"sourceId" integer NOT NULL,
	"amountCents" integer NOT NULL,
	"currency" varchar(8) NOT NULL,
	"occurredAt" timestamp NOT NULL,
	"metadata" text,
	"recordedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inverter_faults" (
	"id" serial PRIMARY KEY NOT NULL,
	"assetId" integer NOT NULL,
	"userId" integer NOT NULL,
	"faultType" "inverter_faults_type" NOT NULL,
	"status" "inverter_faults_status" DEFAULT 'open' NOT NULL,
	"detectedAt" timestamp DEFAULT now() NOT NULL,
	"evidence" json NOT NULL,
	"acknowledgedAt" timestamp,
	"resolvedAt" timestamp,
	"resolutionNote" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offset_listings" (
	"id" serial PRIMARY KEY NOT NULL,
	"sellerUserId" integer NOT NULL,
	"certificateId" integer NOT NULL,
	"askingPriceCents" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"status" "offset_listings_status" DEFAULT 'active' NOT NULL,
	"buyerUserId" integer,
	"soldAt" timestamp,
	"cancelledAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offset_transfers" (
	"id" serial PRIMARY KEY NOT NULL,
	"listingId" integer NOT NULL,
	"certificateId" integer NOT NULL,
	"fromUserId" integer NOT NULL,
	"toUserId" integer NOT NULL,
	"priceCents" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"transferredAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "offset_transfers_listingId_unique" UNIQUE("listingId")
);
--> statement-breakpoint
CREATE TABLE "budget_checkpoints" (
	"id" serial PRIMARY KEY NOT NULL,
	"budget_id" integer NOT NULL,
	"week_start" timestamp NOT NULL,
	"checkpoint_at" timestamp DEFAULT now() NOT NULL,
	"days_elapsed" integer NOT NULL,
	"days_in_month" integer NOT NULL,
	"consumed_wh" bigint,
	"billed_cost_cents" integer,
	"basis_json" json,
	"projection_available" boolean NOT NULL,
	"projection_unavailable_reason" varchar(120),
	"projected_month_end_wh" bigint,
	"projected_month_end_cost_cents" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capacity_bids" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"delivery_start" timestamp NOT NULL,
	"delivery_end" timestamp NOT NULL,
	"status" "capacity_bid_status" DEFAULT 'draft' NOT NULL,
	"bid_available" boolean NOT NULL,
	"unavailable_reason" varchar(120),
	"known_capacity_w" integer,
	"committed_capacity_w" integer,
	"offered_capacity_w" integer,
	"price_cents_per_kwh" integer,
	"basis_json" json,
	"submitted_at" timestamp,
	"outcome_recorded_at" timestamp,
	"outcome_recorded_by" integer,
	"outcome_note" varchar(500),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispatch_window_recommendations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"asset_id" integer NOT NULL,
	"tariff_id" integer,
	"tariff_version" integer,
	"recommendation_available" boolean NOT NULL,
	"reason" varchar(120),
	"windows" json,
	"asset_constraints" json,
	"computed_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "energy_budgets" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"target_kwh" integer,
	"target_cost_cents" integer,
	"currency" varchar(3) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "export_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"format" "export_job_format" NOT NULL,
	"scope" "export_job_scope" NOT NULL,
	"status" "export_job_status" DEFAULT 'queued' NOT NULL,
	"telemetry_row_count" integer,
	"billing_row_count" integer,
	"empty" boolean,
	"content" text,
	"checksum" varchar(64),
	"byte_size" integer,
	"failure_reason" varchar(500),
	"queued_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "island_assessments" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"assessed_at" timestamp DEFAULT now() NOT NULL,
	"assessment_available" boolean NOT NULL,
	"unavailable_reason" varchar(120),
	"autonomy_hours_x100" integer,
	"autonomy_basis" varchar(16),
	"net_drain_watts" integer,
	"usable_energy_wh" bigint,
	"registered_batteries" integer,
	"assessed_batteries" integer,
	"telemetry_staleness_minutes" integer,
	"limitations" json NOT NULL,
	"event_detection" varchar(32) NOT NULL,
	"event_detection_reason" varchar(300),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "firmware_campaigns_status_idx" ON "firmware_campaigns" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "firmware_targets_campaign_device_unique" ON "firmware_targets" USING btree ("campaignId","deviceId");--> statement-breakpoint
CREATE INDEX "firmware_targets_campaign_idx" ON "firmware_targets" USING btree ("campaignId");--> statement-breakpoint
CREATE UNIQUE INDEX "flex_load_enrollments_program_asset_unique" ON "flex_load_enrollments" USING btree ("programId","assetId");--> statement-breakpoint
CREATE INDEX "flex_load_enrollments_user_idx" ON "flex_load_enrollments" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "flex_load_programs_status_idx" ON "flex_load_programs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "portfolio_snapshots_user_idx" ON "portfolio_snapshots" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "savings_verifications_asset_idx" ON "savings_verifications" USING btree ("assetId");--> statement-breakpoint
CREATE INDEX "work_order_events_order_idx" ON "work_order_events" USING btree ("workOrderId");--> statement-breakpoint
CREATE INDEX "work_orders_asset_idx" ON "work_orders" USING btree ("assetId");--> statement-breakpoint
CREATE INDEX "work_orders_status_idx" ON "work_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "work_orders_assignee_idx" ON "work_orders" USING btree ("assignedTo");--> statement-breakpoint
CREATE UNIQUE INDEX "challenge_entries_membership_uq" ON "challenge_entries" USING btree ("challengeId","userId");--> statement-breakpoint
CREATE INDEX "challenge_entries_challenge_idx" ON "challenge_entries" USING btree ("challengeId");--> statement-breakpoint
CREATE INDEX "community_challenges_creator_idx" ON "community_challenges" USING btree ("creatorUserId");--> statement-breakpoint
CREATE INDEX "community_challenges_status_idx" ON "community_challenges" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "digest_runs_period_uq" ON "digest_runs" USING btree ("subscriptionId","periodStart");--> statement-breakpoint
CREATE INDEX "digest_runs_user_idx" ON "digest_runs" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "digest_runs_status_idx" ON "digest_runs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "digest_subscriptions_user_channel_uq" ON "digest_subscriptions" USING btree ("userId","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "grid_service_revenues_source_uq" ON "grid_service_revenues" USING btree ("sourceType","sourceId");--> statement-breakpoint
CREATE INDEX "grid_service_revenues_user_idx" ON "grid_service_revenues" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "grid_service_revenues_occurred_idx" ON "grid_service_revenues" USING btree ("occurredAt");--> statement-breakpoint
CREATE INDEX "inverter_faults_asset_idx" ON "inverter_faults" USING btree ("assetId");--> statement-breakpoint
CREATE INDEX "inverter_faults_user_idx" ON "inverter_faults" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "inverter_faults_status_idx" ON "inverter_faults" USING btree ("status");--> statement-breakpoint
CREATE INDEX "offset_listings_cert_idx" ON "offset_listings" USING btree ("certificateId");--> statement-breakpoint
CREATE INDEX "offset_listings_seller_idx" ON "offset_listings" USING btree ("sellerUserId");--> statement-breakpoint
CREATE INDEX "offset_listings_status_idx" ON "offset_listings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "offset_transfers_cert_idx" ON "offset_transfers" USING btree ("certificateId");--> statement-breakpoint
CREATE INDEX "offset_transfers_to_idx" ON "offset_transfers" USING btree ("toUserId");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_checkpoints_budget_week_key" ON "budget_checkpoints" USING btree ("budget_id","week_start");--> statement-breakpoint
CREATE INDEX "budget_checkpoints_budget_idx" ON "budget_checkpoints" USING btree ("budget_id","checkpoint_at");--> statement-breakpoint
CREATE INDEX "capacity_bids_user_idx" ON "capacity_bids" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "dispatch_window_recs_user_idx" ON "dispatch_window_recommendations" USING btree ("user_id","computed_at");--> statement-breakpoint
CREATE INDEX "dispatch_window_recs_asset_idx" ON "dispatch_window_recommendations" USING btree ("asset_id","computed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "energy_budgets_user_month_key" ON "energy_budgets" USING btree ("user_id","year","month");--> statement-breakpoint
CREATE INDEX "export_jobs_user_idx" ON "export_jobs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "island_assessments_user_idx" ON "island_assessments" USING btree ("user_id","assessed_at");