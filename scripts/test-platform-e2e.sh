#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must point to an isolated *_e2e, *_test, or *_seed database}"

case "${DATABASE_URL%%\?*}" in
  *_e2e|*_test|*_seed) ;;
  *)
    echo "Refusing to run destructive integration seed: database name must end in _e2e, _test, or _seed." >&2
    exit 2
    ;;
esac

if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required for schema coverage assertions." >&2
  exit 2
fi

cd "$(dirname "$0")/.."

pnpm exec drizzle-kit migrate
pnpm exec tsx scripts/seed-platform.ts

# Fail if any public application table remains empty after the deterministic seed.
# Exact counts are intentional; pg_stat_user_tables is approximate and can be
# stale immediately after a freshly migrated test database is seeded.
empty_tables=""
while IFS= read -r quoted_table; do
  count="$(psql "$DATABASE_URL" -Atc "SELECT count(*) FROM ${quoted_table}")"
  if [[ "$count" == "0" ]]; then
    empty_tables+="${quoted_table}"$'\n'
  fi
done < <(psql "$DATABASE_URL" -Atc "
  SELECT quote_ident(table_name)
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_type = 'BASE TABLE'
    AND table_name <> '__drizzle_migrations'
  ORDER BY table_name;
")
if [[ -n "$empty_tables" ]]; then
  printf '%s\n%s' 'Seed coverage failed; empty table(s):' "$empty_tables" >&2
  exit 1
fi

# Assert representative business invariants on real migrated PostgreSQL tables.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ledger_postings WHERE debit_account_id = credit_account_id) THEN
    RAISE EXCEPTION 'seeded ledger posting uses the same debit and credit account';
  END IF;
  IF EXISTS (SELECT 1 FROM grid_network_lines WHERE from_node_id = to_node_id) THEN
    RAISE EXCEPTION 'seeded grid line has identical endpoints';
  END IF;
  IF EXISTS (SELECT 1 FROM grid_network_transformers WHERE hv_node_id = lv_node_id) THEN
    RAISE EXCEPTION 'seeded transformer has identical endpoints';
  END IF;
  IF EXISTS (
    SELECT 1 FROM prepaid_consumption
    WHERE source = 'meter_register' AND energy_wh <> register_end_wh - register_start_wh
  ) THEN
    RAISE EXCEPTION 'seeded prepaid meter consumption is inconsistent';
  END IF;
END
$$;
SQL

pnpm exec vitest run \
  server/payment-initiation.test.ts \
  server/payment-callback-recovery.test.ts \
  server/payment-processing-remediation.test.ts \
  server/energy-wallet-remediation.test.ts \
  server/p2p-asset-approval.test.ts \
  server/edge-router-authorization.test.ts \
  server/standalone-platform.test.ts

echo "Isolated platform seed and focused end-to-end contract suite passed."
