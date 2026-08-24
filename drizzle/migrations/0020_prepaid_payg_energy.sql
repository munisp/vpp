-- Prepaid / pay-as-you-go energy accounts, tokens, metered consumption and
-- supply decisions.
--
-- The platform already charged prepaid customers: a `token_purchase` payment
-- called `generateSTSToken()`, which refuses because no certified STS vending
-- system stands behind it, leaving a `tokens` row reading `PENDING_ISSUANCE_<id>`
-- and a customer with no energy. Nothing recorded how much energy they were
-- owed, how much they had used, or whether a code had already been entered once.
--
-- These tables hold that record against the OpenPAYGO Token standard, which is
-- open and already spoken by PAYG hardware sold across these markets, so a token
-- vended here is acceptable to a meter this platform did not sell.
--
-- Device secret keys are deliberately absent: an account names a key in the
-- deployment keyring (`key_ref`), so a database dump is not enough to vend energy
-- on somebody's meter.
DO $$ BEGIN
  CREATE TYPE "public"."prepaid_token_scheme" AS ENUM ('openpaygo', 'sts_certified');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."prepaid_account_status" AS ENUM ('active', 'suspended', 'disconnected', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."prepaid_token_status" AS ENUM ('issued', 'redeemed', 'void');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."prepaid_consumption_source" AS ENUM ('meter_register', 'meter_reset_gap');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."prepaid_supply_action" AS ENUM ('disconnect', 'reconnect');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."prepaid_supply_reason" AS ENUM ('credit_exhausted', 'operator_request', 'customer_request', 'fault', 'credit_restored');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
-- Prepaid credit is a liability to the customer until their meter takes it, and
-- it needs its own posting kind so unvended credit cannot be read as revenue.
-- Not wrapped in a DO block: PostgreSQL refuses `ALTER TYPE ... ADD VALUE`
-- inside one. `IF NOT EXISTS` is what makes re-running this safe.
ALTER TYPE "public"."ledger_posting_kind" ADD VALUE IF NOT EXISTS 'prepaid_credit_purchased';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prepaid_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"meter_asset_id" integer,
	"meter_serial" varchar(64) NOT NULL,
	"scheme" "prepaid_token_scheme" DEFAULT 'openpaygo' NOT NULL,
	"device_profile" varchar(160) NOT NULL,
	"key_ref" varchar(160) NOT NULL,
	"starting_code" bigint NOT NULL,
	"token_count" integer DEFAULT 1 NOT NULL,
	"wh_per_value_unit" integer DEFAULT 1 NOT NULL,
	"tariff_minor_per_kwh" integer NOT NULL,
	"currency" "ledger_currency" NOT NULL,
	"credited_wh" bigint DEFAULT 0 NOT NULL,
	"consumed_wh" bigint DEFAULT 0 NOT NULL,
	"meter_register_wh" bigint,
	"meter_reading_at" timestamp,
	"status" "prepaid_account_status" DEFAULT 'active' NOT NULL,
	"opened_at" timestamp DEFAULT now() NOT NULL,
	"opened_by" integer NOT NULL,
	"notes" varchar(500),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	-- A tariff of zero would credit infinite energy for any payment.
	CONSTRAINT "prepaid_accounts_tariff_positive" CHECK ("tariff_minor_per_kwh" > 0),
	CONSTRAINT "prepaid_accounts_device_unit_positive" CHECK ("wh_per_value_unit" > 0),
	CONSTRAINT "prepaid_accounts_counts_non_negative" CHECK ("token_count" >= 0 AND "credited_wh" >= 0 AND "consumed_wh" >= 0),
	CONSTRAINT "prepaid_accounts_starting_code_non_negative" CHECK ("starting_code" >= 0),
	-- A device profile and a key reference are what make a vended token
	-- acceptable to hardware; blank ones produce codes that fail in the field.
	CONSTRAINT "prepaid_accounts_device_profile_present" CHECK (length(btrim("device_profile")) > 0),
	CONSTRAINT "prepaid_accounts_key_ref_present" CHECK (length(btrim("key_ref")) > 0),
	CONSTRAINT "prepaid_accounts_meter_serial_present" CHECK (length(btrim("meter_serial")) > 0),
	-- A register reading without its time (or the reverse) cannot bound a
	-- consumption period, so neither is allowed alone.
	CONSTRAINT "prepaid_accounts_meter_cursor_paired" CHECK (("meter_register_wh" IS NULL) = ("meter_reading_at" IS NULL)),
	CONSTRAINT "prepaid_accounts_meter_register_non_negative" CHECK ("meter_register_wh" IS NULL OR "meter_register_wh" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prepaid_accounts_meter_serial_key" ON "prepaid_accounts" ("meter_serial");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prepaid_accounts_user_idx" ON "prepaid_accounts" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prepaid_accounts_meter_asset_idx" ON "prepaid_accounts" ("meter_asset_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prepaid_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"payment_id" integer NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"scheme" "prepaid_token_scheme" NOT NULL,
	"token_code" varchar(64) NOT NULL,
	"token_count" integer NOT NULL,
	"token_type" varchar(32) NOT NULL,
	"energy_wh" bigint NOT NULL,
	"value_units" integer NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" "ledger_currency" NOT NULL,
	"status" "prepaid_token_status" DEFAULT 'issued' NOT NULL,
	"provider_reference" varchar(200) NOT NULL,
	"ledger_posting_id" integer,
	"issued_at" timestamp DEFAULT now() NOT NULL,
	"issued_by" integer,
	"redeemed_at" timestamp,
	"redemption_evidence_ref" varchar(200),
	"void_reason" varchar(200),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "prepaid_tokens_energy_positive" CHECK ("energy_wh" > 0 AND "value_units" > 0),
	CONSTRAINT "prepaid_tokens_amount_positive" CHECK ("amount_minor" > 0),
	CONSTRAINT "prepaid_tokens_code_present" CHECK (length(btrim("token_code")) > 0),
	-- Money arriving is the only reason a token exists, so its evidence is
	-- mandatory rather than nullable.
	CONSTRAINT "prepaid_tokens_provider_reference_present" CHECK (length(btrim("provider_reference")) > 0),
	-- "Redeemed" is a claim about a meter: it needs a time and evidence, or it is
	-- just a status somebody set.
	CONSTRAINT "prepaid_tokens_redeemed_has_evidence" CHECK (
		"status" <> 'redeemed'
		OR ("redeemed_at" IS NOT NULL AND length(btrim(coalesce("redemption_evidence_ref", ''))) > 0)
	),
	CONSTRAINT "prepaid_tokens_void_has_reason" CHECK (
		"status" <> 'void' OR length(btrim(coalesce("void_reason", ''))) > 0
	)
);
--> statement-breakpoint
-- One payment buys one token: a replayed provider callback loses this insert and
-- reads back the token the first attempt vended.
CREATE UNIQUE INDEX IF NOT EXISTS "prepaid_tokens_payment_sequence_key" ON "prepaid_tokens" ("account_id", "payment_id", "sequence");
--> statement-breakpoint
-- An OpenPAYGO count is consumed once per device; two tokens at one count would
-- be a code the meter rejects.
CREATE UNIQUE INDEX IF NOT EXISTS "prepaid_tokens_account_count_key" ON "prepaid_tokens" ("account_id", "token_count");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prepaid_tokens_account_code_key" ON "prepaid_tokens" ("account_id", "token_code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prepaid_tokens_account_issued_idx" ON "prepaid_tokens" ("account_id", "issued_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prepaid_consumption" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"from_at" timestamp NOT NULL,
	"to_at" timestamp NOT NULL,
	"register_start_wh" bigint NOT NULL,
	"register_end_wh" bigint NOT NULL,
	"energy_wh" bigint NOT NULL,
	"source" "prepaid_consumption_source" NOT NULL,
	"evidence_ref" varchar(200) NOT NULL,
	"detail" varchar(300),
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "prepaid_consumption_period_ordered" CHECK ("to_at" > "from_at"),
	CONSTRAINT "prepaid_consumption_energy_non_negative" CHECK ("energy_wh" >= 0),
	CONSTRAINT "prepaid_consumption_registers_non_negative" CHECK ("register_start_wh" >= 0 AND "register_end_wh" >= 0),
	-- A register that moved backwards is a reset: the energy for that period is
	-- unknown and carries zero, never a negative or a guess.
	CONSTRAINT "prepaid_consumption_reset_carries_no_energy" CHECK (
		"source" <> 'meter_reset_gap' OR "energy_wh" = 0
	),
	-- A measured period's energy is exactly the register difference, so a row
	-- cannot claim consumption its own readings do not show.
	CONSTRAINT "prepaid_consumption_measured_matches_registers" CHECK (
		"source" <> 'meter_register' OR "energy_wh" = "register_end_wh" - "register_start_wh"
	),
	CONSTRAINT "prepaid_consumption_evidence_present" CHECK (length(btrim("evidence_ref")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prepaid_consumption_account_to_key" ON "prepaid_consumption" ("account_id", "to_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prepaid_consumption_account_idx" ON "prepaid_consumption" ("account_id", "to_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prepaid_supply_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"action" "prepaid_supply_action" NOT NULL,
	"reason" "prepaid_supply_reason" NOT NULL,
	"actor_user_id" integer,
	"enforced_at_meter" boolean DEFAULT false NOT NULL,
	"evidence_ref" varchar(200),
	"detail" varchar(300),
	"created_at" timestamp DEFAULT now() NOT NULL,
	-- Saying a meter enforced the decision is a claim about hardware, so it needs
	-- the report that came back.
	CONSTRAINT "prepaid_supply_events_enforced_has_evidence" CHECK (
		"enforced_at_meter" = false OR length(btrim(coalesce("evidence_ref", ''))) > 0
	)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prepaid_supply_events_account_idx" ON "prepaid_supply_events" ("account_id", "created_at");
--> statement-breakpoint
-- A meter token is unique to the device that accepts it, not to the world: with
-- OpenPAYGO vending, two customers' meters can legitimately be handed the same
-- digits for the same count. A global unique code silently dropped the second
-- customer's token (the compatibility insert conflicted and did nothing) and let
-- a lookup by code alone return another customer's row, so the code is unique per
-- customer instead.
ALTER TABLE "tokens" DROP CONSTRAINT IF EXISTS "tokens_tokenCode_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tokens_user_code_unique" ON "tokens" ("userId", "tokenCode");
