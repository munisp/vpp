-- A community's allocation prices come from market data in fractional cents per
-- kWh, but the columns held whole cents, so every allocation run against a real
-- price (e.g. 21.6979 c/kWh) failed its insert outright: the pool could not be
-- allocated at all. Widening the scale to hundredths of a cent (the scale the
-- locational flexibility market already stores prices at) lets the price be
-- recorded as it was used, so a run's own arithmetic reproduces from its row.
--
-- Existing rows can only hold whole cents — a fractional value could never have
-- been inserted — so multiplying by 100 converts them exactly.
ALTER TABLE "allocation_runs" RENAME COLUMN "export_price_cents" TO "export_price_cents_x100";
--> statement-breakpoint
ALTER TABLE "allocation_runs" RENAME COLUMN "import_price_cents" TO "import_price_cents_x100";
--> statement-breakpoint
UPDATE "allocation_runs" SET
  "export_price_cents_x100" = "export_price_cents_x100" * 100,
  "import_price_cents_x100" = "import_price_cents_x100" * 100;
