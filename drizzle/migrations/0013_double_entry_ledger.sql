-- The platform recorded money in a single-entry hash chain: tamper-evident, but
-- it does not balance. Nothing forced the funds held at a gateway and the amount
-- owed to a seller to add up, so a lost or duplicated leg was invisible.
--
-- These tables are the platform's half of a TigerBeetle double-entry ledger.
-- `ledger_accounts` pins each platform entity to the ledger account that holds
-- its balance; `ledger_postings` is the outbox and audit trail for every transfer
-- the platform asked the ledger to apply, written before the call so an
-- unconfirmed transfer is a visible row rather than money missing from our record.
DO $$ BEGIN
  CREATE TYPE "public"."ledger_account_kind" AS ENUM ('member_liability', 'gateway_clearing', 'treasury', 'fee_revenue');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."ledger_currency" AS ENUM ('NGN', 'TZS', 'USD');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."ledger_posting_kind" AS ENUM ('buyer_payment_captured', 'member_payout_settled', 'buyer_payment_reversed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."ledger_posting_state" AS ENUM ('pending', 'posted', 'refused', 'unavailable_no_ledger');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ledger_accounts" (
  "id" serial PRIMARY KEY NOT NULL,
  "account_kind" "public"."ledger_account_kind" NOT NULL,
  "currency" "public"."ledger_currency" NOT NULL,
  "owner_user_id" integer,
  "gateway_key" varchar(64),
  -- A 128-bit TigerBeetle account id does not fit an int8, so it is the decimal
  -- string of the derived id. Unique: two platform entities cannot share a balance.
  "tb_account_id" varchar(40) NOT NULL,
  "ledger_code" integer NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ledger_accounts_tb_account_id_key" ON "ledger_accounts" ("tb_account_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_accounts_owner_idx" ON "ledger_accounts" ("owner_user_id", "currency");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ledger_postings" (
  "id" serial PRIMARY KEY NOT NULL,
  "posting_kind" "public"."ledger_posting_kind" NOT NULL,
  "source_type" varchar(40) NOT NULL,
  "source_id" integer NOT NULL,
  "provider_reference" varchar(128),
  "currency" "public"."ledger_currency" NOT NULL,
  "amount_minor" integer NOT NULL,
  "debit_account_id" integer NOT NULL,
  "credit_account_id" integer NOT NULL,
  "tb_transfer_id" varchar(40) NOT NULL,
  "state" "public"."ledger_posting_state" DEFAULT 'pending' NOT NULL,
  "detail" varchar(512),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "settled_at" timestamp,
  -- The ledger holds integers and a posting moves money in one direction.
  CONSTRAINT "ledger_postings_amount_positive" CHECK ("amount_minor" > 0),
  -- An entry from an account to itself moves nothing while appearing to settle.
  CONSTRAINT "ledger_postings_distinct_accounts" CHECK ("debit_account_id" <> "credit_account_id"),
  CONSTRAINT "ledger_postings_debit_account_fk" FOREIGN KEY ("debit_account_id") REFERENCES "ledger_accounts"("id"),
  CONSTRAINT "ledger_postings_credit_account_fk" FOREIGN KEY ("credit_account_id") REFERENCES "ledger_accounts"("id")
);
--> statement-breakpoint
-- The transfer id is derived from the business fact, so this index is what makes a
-- retried provider callback re-enter one posting instead of moving money twice.
CREATE UNIQUE INDEX IF NOT EXISTS "ledger_postings_tb_transfer_id_key" ON "ledger_postings" ("tb_transfer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_postings_source_idx" ON "ledger_postings" ("source_type", "source_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_postings_state_idx" ON "ledger_postings" ("state", "created_at");
