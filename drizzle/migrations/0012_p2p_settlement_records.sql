-- A trade used to be its own settlement evidence: the only record that money
-- had moved was a status on the trade row, so reconciliation compared a trade
-- against itself and always agreed. Settlement now has its own record, holding
-- the provider payment reference, the metered delivery and the payout the
-- platform can prove -- or naming which of the three is missing.
DO $$ BEGIN
  CREATE TYPE "public"."p2p_settlements_state" AS ENUM ('buyer_paid_seller_unpaid', 'delivery_evidenced', 'complete', 'unresolved');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."p2p_settlements_delivery" AS ENUM ('unmeasured', 'unverified', 'measured', 'not_delivered');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."p2p_settlements_payout" AS ENUM ('unavailable_no_provider', 'requested', 'evidenced');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."p2p_settlements_reconciliation" AS ENUM ('pending', 'matched', 'mismatch');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "p2p_settlements" (
  "id" serial PRIMARY KEY NOT NULL,
  "buyTradeId" integer NOT NULL,
  "sellTradeId" integer,
  "buyerId" integer NOT NULL,
  "sellerId" integer NOT NULL,
  "energyWh" integer NOT NULL,
  "amountCents" integer NOT NULL,
  "currency" varchar(3) NOT NULL,
  "buyerPaymentId" integer,
  "buyerPaymentReference" varchar(191),
  "buyerPaidAt" timestamp,
  "delivery" "public"."p2p_settlements_delivery" DEFAULT 'unmeasured' NOT NULL,
  "deliveredEnergyWh" integer,
  "deliverySamples" integer,
  "deliveryMeasuredAt" timestamp,
  "deliveryNote" text,
  "sellerPayout" "public"."p2p_settlements_payout" DEFAULT 'unavailable_no_provider' NOT NULL,
  "sellerPayoutReference" varchar(191),
  "sellerPaidAt" timestamp,
  "state" "public"."p2p_settlements_state" NOT NULL,
  "reconciliation" "public"."p2p_settlements_reconciliation" DEFAULT 'pending' NOT NULL,
  "reconciliationNote" text,
  "reconciledAt" timestamp,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "p2p_settlements_buyTradeId_unique" UNIQUE ("buyTradeId"),
  CONSTRAINT "p2p_settlements_buy_trade_fk" FOREIGN KEY ("buyTradeId") REFERENCES "public"."trades"("id") ON DELETE RESTRICT,
  CONSTRAINT "p2p_settlements_sell_trade_fk" FOREIGN KEY ("sellTradeId") REFERENCES "public"."trades"("id") ON DELETE RESTRICT,
  CONSTRAINT "p2p_settlements_buyer_fk" FOREIGN KEY ("buyerId") REFERENCES "public"."users"("id") ON DELETE RESTRICT,
  CONSTRAINT "p2p_settlements_seller_fk" FOREIGN KEY ("sellerId") REFERENCES "public"."users"("id") ON DELETE RESTRICT,
  CONSTRAINT "p2p_settlements_payment_fk" FOREIGN KEY ("buyerPaymentId") REFERENCES "public"."payments"("id") ON DELETE RESTRICT,
  -- A paid settlement must carry the provider's reference, and a measured
  -- delivery must carry the energy it measured: a state with nothing behind it
  -- would be exactly the claim this table exists to prevent.
  CONSTRAINT "p2p_settlements_paid_evidence_ck" CHECK (
    "buyerPaidAt" IS NULL OR ("buyerPaymentId" IS NOT NULL AND "buyerPaymentReference" IS NOT NULL)
  ),
  CONSTRAINT "p2p_settlements_delivery_evidence_ck" CHECK (
    "delivery" <> 'measured' OR ("deliveredEnergyWh" IS NOT NULL AND "deliveryMeasuredAt" IS NOT NULL)
  ),
  CONSTRAINT "p2p_settlements_payout_evidence_ck" CHECK (
    "sellerPayout" <> 'evidenced' OR ("sellerPayoutReference" IS NOT NULL AND "sellerPaidAt" IS NOT NULL)
  ),
  -- 'complete' is the only state that asserts the trade is finished, so it may
  -- only exist when every leg is evidenced.
  CONSTRAINT "p2p_settlements_complete_ck" CHECK (
    "state" <> 'complete'
    OR ("buyerPaidAt" IS NOT NULL AND "delivery" = 'measured' AND "sellerPayout" = 'evidenced')
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "p2p_settlements_state_idx" ON "p2p_settlements" ("state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "p2p_settlements_seller_idx" ON "p2p_settlements" ("sellerId");
--> statement-breakpoint
-- The payment's trade link was an unenforced integer, so a payment could name
-- a trade that never existed.
DO $$ BEGIN
  ALTER TABLE "payments" ADD CONSTRAINT "payments_p2p_trade_fk"
    FOREIGN KEY ("p2pTradeId") REFERENCES "public"."trades"("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
