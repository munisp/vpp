-- Every P2P counterparty used to be an anonymous `users` row, so a trade could
-- not say whether it was between two households, a household and a business, or
-- two businesses -- a distinction that changes invoicing, tax and exposure
-- treatment at settlement. Participants now carry their own type, and a
-- business carries the identity it trades under.
DO $$ BEGIN
  CREATE TYPE "public"."users_participant_type" AS ENUM ('person', 'business');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "participantType" "public"."users_participant_type" DEFAULT 'person' NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "businessLegalName" varchar(255);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "businessRegistrationNumber" varchar(100);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "businessVerifiedAt" timestamp;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "businessVerifiedBy" integer;
--> statement-breakpoint
-- A verified business must name itself: verification with no legal name and no
-- registration number would be a claim with nothing behind it.
DO $$ BEGIN
  ALTER TABLE "users" ADD CONSTRAINT "users_business_identity_ck" CHECK (
    "businessVerifiedAt" IS NULL
    OR ("businessLegalName" IS NOT NULL AND "businessRegistrationNumber" IS NOT NULL)
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
