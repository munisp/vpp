CREATE TABLE "matter_nodes" (
	"id" serial PRIMARY KEY NOT NULL,
	"fabric_id" varchar(20) NOT NULL,
	"node_id" varchar(20) NOT NULL,
	"available" boolean NOT NULL,
	"is_bridge" boolean DEFAULT false NOT NULL,
	"is_test_node" boolean DEFAULT false NOT NULL,
	"reported_attributes" jsonb,
	"removed_at" timestamp,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_reported_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "matter_nodes_fabric_node_unique" UNIQUE("fabric_id","node_id")
);
--> statement-breakpoint
CREATE INDEX "matter_nodes_available_idx" ON "matter_nodes" USING btree ("available");--> statement-breakpoint
CREATE TABLE "matter_node_attributes" (
	"id" serial PRIMARY KEY NOT NULL,
	"matter_node_id" integer NOT NULL,
	"endpoint_id" integer NOT NULL,
	"cluster_id" integer NOT NULL,
	"attribute_id" integer NOT NULL,
	"attribute_path" varchar(64) NOT NULL,
	"value" jsonb,
	"reported_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "matter_node_attributes_node_path_unique" UNIQUE("matter_node_id","attribute_path"),
	CONSTRAINT "matter_node_attributes_node_fk" FOREIGN KEY ("matter_node_id") REFERENCES "public"."matter_nodes"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "matter_node_attributes_node_idx" ON "matter_node_attributes" USING btree ("matter_node_id");
