-- The electrical model of the network, and the feasibility studies solved over it.
--
-- `grid_nodes` is extended rather than shadowed by a second topology table: the
-- node the market buys flexibility at and the bus the power flow solves at are
-- the same place, and two tables claiming to describe one network is how they
-- come to disagree. Only the branches between nodes are new.
--
-- Every added electrical column is nullable (or defaulted where zero is a valid
-- model, like line charging). An unmodelled node makes its network unsolvable,
-- which the feasibility service reports as `model_unavailable` and the caller
-- reports as network-unchecked. A default impedance would instead produce a
-- confident "feasible" for a network nobody has surveyed.
ALTER TABLE "grid_nodes" ADD COLUMN IF NOT EXISTS "nominal_volts" integer;
--> statement-breakpoint
ALTER TABLE "grid_nodes" ADD COLUMN IF NOT EXISTS "is_source" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "grid_nodes" ADD COLUMN IF NOT EXISTS "voltage_min_pu_x1000" integer;
--> statement-breakpoint
ALTER TABLE "grid_nodes" ADD COLUMN IF NOT EXISTS "voltage_max_pu_x1000" integer;
--> statement-breakpoint
-- A voltage band that is not a band would silently pass or fail every bus.
ALTER TABLE "grid_nodes" DROP CONSTRAINT IF EXISTS "grid_nodes_voltage_band_ordered";
--> statement-breakpoint
ALTER TABLE "grid_nodes" ADD CONSTRAINT "grid_nodes_voltage_band_ordered" CHECK (
	"voltage_min_pu_x1000" IS NULL
	OR "voltage_max_pu_x1000" IS NULL
	OR "voltage_min_pu_x1000" < "voltage_max_pu_x1000"
);
--> statement-breakpoint
ALTER TABLE "grid_nodes" DROP CONSTRAINT IF EXISTS "grid_nodes_nominal_volts_positive";
--> statement-breakpoint
ALTER TABLE "grid_nodes" ADD CONSTRAINT "grid_nodes_nominal_volts_positive" CHECK (
	"nominal_volts" IS NULL OR "nominal_volts" > 0
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "grid_network_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" varchar(80) NOT NULL,
	"from_node_id" integer NOT NULL,
	"to_node_id" integer NOT NULL,
	"length_m" integer NOT NULL,
	"resistance_mohm_per_km" integer NOT NULL,
	"reactance_mohm_per_km" integer NOT NULL,
	"capacitance_nf_per_km" integer DEFAULT 0 NOT NULL,
	"max_current_ma" integer NOT NULL,
	"parallel_circuits" integer DEFAULT 1 NOT NULL,
	"data_source" varchar(200),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "grid_network_lines_code_unique" UNIQUE("code"),
	CONSTRAINT "grid_network_lines_from_node_id_fk" FOREIGN KEY ("from_node_id")
		REFERENCES "grid_nodes"("id") ON DELETE CASCADE,
	CONSTRAINT "grid_network_lines_to_node_id_fk" FOREIGN KEY ("to_node_id")
		REFERENCES "grid_nodes"("id") ON DELETE CASCADE,
	-- A line to itself is not a branch, and a zero-impedance or unrated line
	-- makes every flow over it look acceptable.
	CONSTRAINT "grid_network_lines_distinct_ends" CHECK ("from_node_id" <> "to_node_id"),
	CONSTRAINT "grid_network_lines_rated" CHECK (
		"length_m" > 0
		AND "resistance_mohm_per_km" > 0
		AND "reactance_mohm_per_km" > 0
		AND "capacitance_nf_per_km" >= 0
		AND "max_current_ma" > 0
		AND "parallel_circuits" >= 1
	)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "grid_network_lines_from_idx" ON "grid_network_lines" ("from_node_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "grid_network_lines_to_idx" ON "grid_network_lines" ("to_node_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "grid_network_transformers" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" varchar(80) NOT NULL,
	"hv_node_id" integer NOT NULL,
	"lv_node_id" integer NOT NULL,
	"rated_kva" integer NOT NULL,
	"hv_volts" integer NOT NULL,
	"lv_volts" integer NOT NULL,
	"short_circuit_percent_x100" integer NOT NULL,
	"short_circuit_resistive_percent_x100" integer DEFAULT 0 NOT NULL,
	"iron_loss_w" integer DEFAULT 0 NOT NULL,
	"open_loop_current_percent_x100" integer DEFAULT 0 NOT NULL,
	"data_source" varchar(200),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "grid_network_transformers_code_unique" UNIQUE("code"),
	CONSTRAINT "grid_network_transformers_pair_unique" UNIQUE("hv_node_id","lv_node_id"),
	CONSTRAINT "grid_network_transformers_hv_node_id_fk" FOREIGN KEY ("hv_node_id")
		REFERENCES "grid_nodes"("id") ON DELETE CASCADE,
	CONSTRAINT "grid_network_transformers_lv_node_id_fk" FOREIGN KEY ("lv_node_id")
		REFERENCES "grid_nodes"("id") ON DELETE CASCADE,
	CONSTRAINT "grid_network_transformers_distinct_ends" CHECK ("hv_node_id" <> "lv_node_id"),
	-- The rating is what an overload is measured against, and the short-circuit
	-- voltage is the impedance: neither can be zero in a usable model. The
	-- resistive part cannot exceed the total, or the reactance is imaginary.
	CONSTRAINT "grid_network_transformers_rated" CHECK (
		"rated_kva" > 0
		AND "hv_volts" > 0
		AND "lv_volts" > 0
		AND "short_circuit_percent_x100" > 0
		AND "short_circuit_resistive_percent_x100" >= 0
		AND "short_circuit_resistive_percent_x100" <= "short_circuit_percent_x100"
		AND "iron_loss_w" >= 0
		AND "open_loop_current_percent_x100" >= 0
	)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "grid_network_transformers_hv_idx" ON "grid_network_transformers" ("hv_node_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "grid_network_transformers_lv_idx" ON "grid_network_transformers" ("lv_node_id");
--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."feasibility_subject" AS ENUM ('dispatch', 'flexibility_clearing', 'connection_enquiry');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."feasibility_status" AS ENUM ('feasible', 'violations', 'model_unavailable', 'not_converged', 'service_unavailable');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
-- The study is the evidence behind a refusal. A dispatch or an award refused on
-- network grounds has to be reproducible later, so the request that was solved
-- and the answer that came back are both kept whole.
CREATE TABLE IF NOT EXISTS "network_feasibility_studies" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject" "feasibility_subject" NOT NULL,
	"subject_reference" varchar(120),
	"node_id" integer,
	"status" "feasibility_status" NOT NULL,
	"reason" varchar(500),
	"engine" varchar(80),
	"buses" integer DEFAULT 0 NOT NULL,
	"violation_count" integer DEFAULT 0 NOT NULL,
	"limiting_element" varchar(80),
	"request" jsonb NOT NULL,
	"response" jsonb,
	"requested_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "network_feasibility_studies_node_id_fk" FOREIGN KEY ("node_id")
		REFERENCES "grid_nodes"("id") ON DELETE SET NULL,
	-- A status that means "nothing solved this" must not carry an engine or
	-- voltages, and a solved status must say what solved it.
	CONSTRAINT "network_feasibility_studies_engine_matches_status" CHECK (
		("status" IN ('model_unavailable', 'service_unavailable') AND "engine" IS NULL)
		OR ("status" IN ('feasible', 'violations', 'not_converged') AND "engine" IS NOT NULL)
	),
	-- Violations are only meaningful for a solved case, and a case reported as
	-- feasible cannot have any.
	CONSTRAINT "network_feasibility_studies_violations_match_status" CHECK (
		("status" = 'violations' AND "violation_count" > 0)
		OR ("status" <> 'violations' AND "violation_count" = 0)
	)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "network_feasibility_studies_subject_idx" ON "network_feasibility_studies" ("subject", "subject_reference");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "network_feasibility_studies_node_idx" ON "network_feasibility_studies" ("node_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "network_feasibility_studies_created_idx" ON "network_feasibility_studies" ("created_at");
--> statement-breakpoint
-- The feasibility service is a dependency like any other, so a study that could
-- not be run is recorded as an observation of it rather than as a missing study.
ALTER TYPE "public"."dependency_name" ADD VALUE IF NOT EXISTS 'network_model';
--> statement-breakpoint
-- An award cleared while the network could not be checked is not a
-- network-approved award. The column records which of the two it was, and the
-- study it came from.
ALTER TABLE "flexibility_awards" ADD COLUMN IF NOT EXISTS "network_check_status" varchar(40);
--> statement-breakpoint
ALTER TABLE "flexibility_awards" ADD COLUMN IF NOT EXISTS "network_study_id" integer;
--> statement-breakpoint
ALTER TABLE "flexibility_awards" DROP CONSTRAINT IF EXISTS "flexibility_awards_network_check_known";
--> statement-breakpoint
ALTER TABLE "flexibility_awards" ADD CONSTRAINT "flexibility_awards_network_check_known" CHECK (
	"network_check_status" IS NULL
	OR "network_check_status" IN ('feasible', 'model_unavailable', 'service_unavailable', 'not_converged')
);
