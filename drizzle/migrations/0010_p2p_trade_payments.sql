-- A matched P2P trade needs a payment of its own: until now the payment type
-- enum could only describe invoices, token purchases and monthly fees, so a
-- buyer had no way to pay a seller and a matched trade was a dead end.
ALTER TYPE "public"."payments_payment_type" ADD VALUE IF NOT EXISTS 'p2p_trade';
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "p2pTradeId" integer;
--> statement-breakpoint
-- Only one live payment per purchase: two concurrent pay requests would
-- otherwise both find no existing payment and charge the buyer twice. A failed
-- attempt leaves the index, so a buyer can retry.
CREATE UNIQUE INDEX IF NOT EXISTS "payments_p2p_trade_live_uq"
  ON "payments" ("p2pTradeId")
  WHERE "p2pTradeId" IS NOT NULL AND "status" IN ('pending', 'completed');
