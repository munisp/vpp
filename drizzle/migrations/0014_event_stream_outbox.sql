-- Kafka publishing was fire-and-forget after the commit: a broker outage, a
-- missing topic or a pod killed at the wrong moment lost the event with nothing
-- but a log line, and on money paths the inline KafkaJS retries added ~30s of
-- latency *after* the settlement row was already written.
--
-- `event_outbox` is written in the same transaction as the business fact, so an
-- event that never reached the broker is a visible pending row. `event_inbox` is
-- the consuming half: Kafka's offsets say where a consumer is, not what it did,
-- so the unique (topic, event_key) makes a redelivery a no-op instead of a second
-- application. `event_dead_letters` is what neither side could complete — kept,
-- never dropped, and only an operator clears it.
DO $$ BEGIN
  CREATE TYPE "public"."event_outbox_state" AS ENUM ('pending', 'published', 'undeliverable');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."event_dead_letter_side" AS ENUM ('produce', 'consume');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "event_outbox" (
  "id" serial PRIMARY KEY NOT NULL,
  "topic" varchar(160) NOT NULL,
  "partition_key" varchar(200),
  "event_key" varchar(200) NOT NULL,
  "payload" jsonb NOT NULL,
  "state" "public"."event_outbox_state" DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp DEFAULT now() NOT NULL,
  "last_error" varchar(1000),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "published_at" timestamp,
  -- A published row must carry the moment the broker acknowledged it, and an
  -- unpublished row must not: otherwise "published" is a claim with no evidence.
  CONSTRAINT "event_outbox_published_has_time" CHECK (
    ("state" = 'published' AND "published_at" IS NOT NULL)
    OR ("state" <> 'published' AND "published_at" IS NULL)
  )
);
--> statement-breakpoint
-- The idempotency of the whole outbox: a retried callback or replayed workflow
-- conflicts here instead of enqueuing the same event twice.
CREATE UNIQUE INDEX IF NOT EXISTS "event_outbox_event_key_key" ON "event_outbox" ("event_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_outbox_due_idx" ON "event_outbox" ("state", "next_attempt_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_outbox_topic_idx" ON "event_outbox" ("topic", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "event_inbox" (
  "id" serial PRIMARY KEY NOT NULL,
  "topic" varchar(160) NOT NULL,
  "event_key" varchar(200) NOT NULL,
  "partition" integer NOT NULL,
  -- Offsets pass 2^31 on a busy topic, so this cannot be an integer.
  "message_offset" bigint NOT NULL,
  "payload" jsonb NOT NULL,
  "produced_at" timestamp,
  "consumed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "event_inbox_identity_key" ON "event_inbox" ("topic", "event_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_inbox_coordinates_idx" ON "event_inbox" ("topic", "partition", "message_offset");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_inbox_consumed_idx" ON "event_inbox" ("topic", "consumed_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "event_dead_letters" (
  "id" serial PRIMARY KEY NOT NULL,
  "side" "public"."event_dead_letter_side" NOT NULL,
  "topic" varchar(160) NOT NULL,
  "event_key" varchar(200) NOT NULL,
  "payload" jsonb NOT NULL,
  "reason" varchar(1000) NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "acknowledged_at" timestamp,
  "acknowledged_by" integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_dead_letters_side_idx" ON "event_dead_letters" ("side", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_dead_letters_open_idx" ON "event_dead_letters" ("acknowledged_at");
