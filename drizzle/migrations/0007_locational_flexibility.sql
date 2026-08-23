CREATE TYPE "public"."grid_node_kind" AS ENUM('substation', 'feeder', 'transformer');--> statement-breakpoint
CREATE TYPE "public"."grid_node_link_source" AS ENUM('operator_declared', 'utility_verified', 'unverified');--> statement-breakpoint
CREATE TYPE "public"."flexibility_direction" AS ENUM('import_reduction', 'export_reduction');--> statement-breakpoint
CREATE TYPE "public"."flexibility_requirement_status" AS ENUM('open', 'cleared', 'short', 'cancelled', 'settled');--> statement-breakpoint
CREATE TYPE "public"."flexibility_offer_status" AS ENUM('submitted', 'awarded', 'not_awarded', 'ineligible', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."flexibility_delivery_status" AS ENUM('unmeasured', 'delivered', 'partial', 'not_delivered', 'unverified');--> statement-breakpoint
CREATE TABLE "grid_nodes" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" varchar(80) NOT NULL,
	"name" varchar(200) NOT NULL,
	"kind" "grid_node_kind" NOT NULL,
	"parent_node_id" integer,
	"region" varchar(100),
	"firm_capacity_w" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "grid_nodes_code_unique" UNIQUE("code"),
	CONSTRAINT "grid_nodes_parent_fk" FOREIGN KEY ("parent_node_id") REFERENCES "public"."grid_nodes"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX "grid_nodes_region_idx" ON "grid_nodes" USING btree ("region");--> statement-breakpoint
CREATE INDEX "grid_nodes_parent_idx" ON "grid_nodes" USING btree ("parent_node_id");--> statement-breakpoint
CREATE TABLE "grid_node_assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"node_id" integer NOT NULL,
	"asset_id" integer NOT NULL,
	"link_source" "grid_node_link_source" NOT NULL,
	"linked_by_user_id" integer,
	"evidence" varchar(500),
	"verified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "grid_node_assets_asset_unique" UNIQUE("asset_id"),
	CONSTRAINT "grid_node_assets_node_fk" FOREIGN KEY ("node_id") REFERENCES "public"."grid_nodes"("id") ON DELETE CASCADE,
	CONSTRAINT "grid_node_assets_asset_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "grid_node_assets_node_idx" ON "grid_node_assets" USING btree ("node_id");--> statement-breakpoint
CREATE TABLE "flexibility_requirements" (
	"id" serial PRIMARY KEY NOT NULL,
	"node_id" integer NOT NULL,
	"direction" "flexibility_direction" NOT NULL,
	"status" "flexibility_requirement_status" DEFAULT 'open' NOT NULL,
	"starts_at" timestamp NOT NULL,
	"ends_at" timestamp NOT NULL,
	"required_power_w" integer NOT NULL,
	"price_cap_cents_per_kwh" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'TZS' NOT NULL,
	"cleared_power_w" integer DEFAULT 0 NOT NULL,
	"clearing_price_cents_per_kwh" integer,
	"created_by_user_id" integer NOT NULL,
	"cleared_at" timestamp,
	"notes" varchar(500),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "flexibility_requirements_node_fk" FOREIGN KEY ("node_id") REFERENCES "public"."grid_nodes"("id") ON DELETE CASCADE,
	CONSTRAINT "flexibility_requirements_window_check" CHECK ("ends_at" > "starts_at"),
	CONSTRAINT "flexibility_requirements_power_check" CHECK ("required_power_w" > 0),
	CONSTRAINT "flexibility_requirements_cap_check" CHECK ("price_cap_cents_per_kwh" >= 0)
);
--> statement-breakpoint
CREATE INDEX "flexibility_requirements_node_idx" ON "flexibility_requirements" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "flexibility_requirements_window_idx" ON "flexibility_requirements" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "flexibility_requirements_status_idx" ON "flexibility_requirements" USING btree ("status");--> statement-breakpoint
CREATE TABLE "flexibility_offers" (
	"id" serial PRIMARY KEY NOT NULL,
	"requirement_id" integer NOT NULL,
	"asset_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"status" "flexibility_offer_status" DEFAULT 'submitted' NOT NULL,
	"offered_power_w" integer NOT NULL,
	"price_cents_per_kwh" integer NOT NULL,
	"link_source" "grid_node_link_source" NOT NULL,
	"ineligible_reason" varchar(300),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "flexibility_offers_asset_unique" UNIQUE("requirement_id","asset_id"),
	CONSTRAINT "flexibility_offers_requirement_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."flexibility_requirements"("id") ON DELETE CASCADE,
	CONSTRAINT "flexibility_offers_asset_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE CASCADE,
	CONSTRAINT "flexibility_offers_power_check" CHECK ("offered_power_w" > 0),
	CONSTRAINT "flexibility_offers_price_check" CHECK ("price_cents_per_kwh" >= 0)
);
--> statement-breakpoint
CREATE INDEX "flexibility_offers_requirement_idx" ON "flexibility_offers" USING btree ("requirement_id");--> statement-breakpoint
CREATE INDEX "flexibility_offers_user_idx" ON "flexibility_offers" USING btree ("user_id");--> statement-breakpoint
CREATE TABLE "flexibility_awards" (
	"id" serial PRIMARY KEY NOT NULL,
	"requirement_id" integer NOT NULL,
	"offer_id" integer NOT NULL,
	"asset_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"awarded_power_w" integer NOT NULL,
	"price_cents_per_kwh" integer NOT NULL,
	"delivery_status" "flexibility_delivery_status" DEFAULT 'unmeasured' NOT NULL,
	"baseline_power_w" integer,
	"baseline_samples" integer DEFAULT 0 NOT NULL,
	"measured_power_w" integer,
	"measured_samples" integer DEFAULT 0 NOT NULL,
	"delivered_power_w" integer,
	"delivered_energy_wh" integer,
	"earned_amount" integer,
	"measured_at" timestamp,
	"settlement_event_id" integer,
	"settled_at" timestamp,
	"measurement" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "flexibility_awards_offer_unique" UNIQUE("offer_id"),
	CONSTRAINT "flexibility_awards_requirement_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."flexibility_requirements"("id") ON DELETE CASCADE,
	CONSTRAINT "flexibility_awards_offer_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."flexibility_offers"("id") ON DELETE CASCADE,
	CONSTRAINT "flexibility_awards_power_check" CHECK ("awarded_power_w" > 0)
);
--> statement-breakpoint
CREATE INDEX "flexibility_awards_requirement_idx" ON "flexibility_awards" USING btree ("requirement_id");--> statement-breakpoint
CREATE INDEX "flexibility_awards_user_idx" ON "flexibility_awards" USING btree ("user_id");
