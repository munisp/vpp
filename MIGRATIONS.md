# Database Migrations

MySQL / Drizzle ORM migration guide for the VPP platform.

> **WARNING: Never run `drizzle-kit push` against production.**
> `push` rewrites the live schema directly from `drizzle/schema.ts` with no
> migration history, no journal entries, and no rollback path. It can silently
> drop or alter columns. Production schema changes must go through the
> versioned SQL migrations in `drizzle/migrations/` only.

## Canonical migration set (repaired)

The coherent, linear, idempotent history lives in **`drizzle/migrations/`**:

| # | File | Contents |
|---|------|----------|
| 0000 | `drizzle/migrations/0000_baseline.sql` | `CREATE TABLE IF NOT EXISTS` for **all 89 tables** defined across every `drizzle/*.ts` schema file, in dependency-safe order (no inter-table FKs exist, so creation order is unconstrained). Generated with drizzle-kit 0.31.4 from the full schema; `IF NOT EXISTS` added so it can be re-applied to partially-migrated databases. |
| 0001 | `drizzle/migrations/0001_recent_schema_changes.sql` | `ALTER TABLE` statements for the three recent schema changes (see below). |

`drizzle/migrations/meta/_journal.json` + `0000_snapshot.json` / `0001_snapshot.json`
follow drizzle-kit's exact format (journal `version: "7"`, dialect `mysql`,
snapshot `version: "5"`, chained via `id`/`prevId`) and are consistent with
the SQL: snapshot 0000 = pre-change schema, snapshot 0001 = post-change schema.

### 0001 recent schema changes

| Table | Change |
|-------|--------|
| `assets` | `ADD approvalStatus enum('pending','approved','rejected') DEFAULT 'pending' NOT NULL` |
| `tokens` | `MODIFY COLUMN status enum('active','used','expired','pending_issuance') NOT NULL DEFAULT 'active'` (extends enum with `pending_issuance`) |
| `participant_scores` | `MODIFY COLUMN responseTimeScore int` (drops `NOT NULL`; nullable when no DR response can be matched to a real event — see `drizzle/dr-segmentation-schema.ts`) |

## How to apply

### Option A — manual `mysql` (recommended for existing databases)

```bash
mysql -u <user> -p <database> < drizzle/migrations/0000_baseline.sql
mysql -u <user> -p <database> < drizzle/migrations/0001_recent_schema_changes.sql
```

* `0000_baseline.sql` is fully idempotent (`IF NOT EXISTS` on every table) and
  safe to run on a fresh **or** partially migrated database. On a database that
  already ran the legacy `0000_peaceful_scourge.sql`, it only adds the 45
  previously-uncovered tables (next-gen VPP, innovations, trust-access,
  grid-intel, `mqtt_broker_credentials`, `qr_code_history`, `user_achievements`, …).
* `0001_recent_schema_changes.sql`: the two `MODIFY COLUMN` statements are
  naturally re-runnable. The `assets ADD approvalStatus` statement is **not**
  idempotent (MySQL has no `ADD COLUMN IF NOT EXISTS`); if the column already
  exists (e.g. the DB was built with `drizzle-kit push` from the current
  schema), skip that one statement or ignore error 1060.

### Option B — `drizzle-kit migrate`

`drizzle.config.ts` currently points `out` at `./drizzle` (the legacy,
broken set). To migrate using the repaired set, use a config whose `out`
is `./drizzle/migrations`:

```bash
DATABASE_URL=mysql://... drizzle-kit migrate --config drizzle.migrations.config.ts
```

(Or update `drizzle.config.ts` `out` to `./drizzle/migrations` when ownership
of that file allows.) drizzle-kit records applied migrations in the
`__drizzle_migrations` table — that table plus
`drizzle/migrations/meta/_journal.json` is the source of truth going forward.

**Do not** run `drizzle-kit migrate` with the stock `drizzle.config.ts`: it
would replay the legacy journal (`drizzle/meta/_journal.json`), which tracks
only 2 of the 22 legacy files and leaves the database partially migrated.

## Legacy files — superseded, kept in place

The 22 SQL files in `drizzle/` root had duplicate `0000`/`0001` indexes and a
journal (`drizzle/meta/_journal.json`) tracking only 2 of them. Their content
has been **folded into the consolidated history**; the originals are left
untouched to avoid breaking references but are **superseded — do not apply them**:

| Legacy file | Status |
|---|---|
| `0000_peaceful_scourge.sql` (43 tables incl. `users`, `qr_code_history`) | folded into `0000_baseline.sql` |
| `0000_daily_drax.sql` (`price_alerts`) | duplicate create — folded into `0000_baseline.sql` |
| `0000_smiling_black_crow.sql` (`users`) | duplicate create — folded into `0000_baseline.sql` |
| `0001_classy_dazzler.sql` (9 dup creates + `users` column adds) | folded into `0000_baseline.sql` (columns are in the baseline `users` definition) |
| `0001_motionless_shiva.sql` (`price_alerts`, `referrals`, `referral_rewards`) | duplicate create — folded into `0000_baseline.sql` |
| `0001_silent_ben_parker.sql` (`mqtt_broker_credentials`) | folded into `0000_baseline.sql` |
| `0002`–`0005`, `0007`–`0011`, `0013`, `0017`, `0018`, `0021` | duplicate creates of baseline tables — folded into `0000_baseline.sql` |
| `0006_solid_grey_gargoyle.sql` (`demandResponseEvents.eventType` enum) | reflected in baseline column definition |
| `0014_loving_tombstone.sql` (`users` onboarding columns) | reflected in baseline `users` definition |
| `0015`/`0016` (`notification_preferences` columns) | reflected in baseline definition |
| `0019`/`0020` (`trading_strategies.tradingMode` type churn) | final `varchar(20)` reflected in baseline definition |
| `0012_eager_zaran.sql` | intentionally empty (reverted change); nothing to fold |

`drizzle/meta/` (old journal + 2 snapshots) is likewise legacy and superseded
by `drizzle/migrations/meta/`.

## Table ↔ migration map

All 89 tables are created by **`migrations/0000_baseline.sql`**; `0001` only
alters `assets`, `tokens`, `participant_scores`.

| Schema file | Tables | Migration |
|---|---|---|
| `schema.ts` | users, assets¹, telemetry, contracts, trades, marketPrices, billings, payments, tokens¹, alerts, tradingPreferences, devices, device_commands, device_logs, demandResponseEvents, drParticipants, drResponses, drCompensation, payment_credentials, payment_gateway_logs, dr_forecasts, dr_event_templates, dr_automation_rules, grid_monitoring, mqtt_broker_credentials | 0000 (+0001 for ¹) |
| `achievements-schema.ts` | achievements, user_achievements, leaderboard_entries | 0000 |
| `audit-logs-schema.ts` | audit_logs | 0000 |
| `biometric-credentials-schema.ts` | biometric_credentials | 0000 |
| `devices-schema.ts` | devices, device_commands, device_logs (duplicates of `schema.ts` definitions) | 0000 |
| `dr-forecasting-schema.ts` | dr_forecasts, dr_event_templates, dr_automation_rules, grid_monitoring (duplicates of `schema.ts` definitions) | 0000 |
| `dr-segmentation-schema.ts` | participant_scores¹, participant_segments, dr_campaigns | 0000 (+0001 for ¹) |
| `grid-intel-schema.ts` | grid_anomaly_scores, v2g_schedules, energy_wallets, wallet_balance_snapshots, wallet_top_up_attempts, pool_allocation_rules, allocation_runs, allocation_entries, dr_event_forecasts, dr_participant_recommendations | 0000 |
| `innovations-schema.ts` | energy_advisor_reports, dynamic_tariffs, battery_health_snapshots, p2p_matches, carbon_certificates | 0000 |
| `nextgen-vpp-schema.ts` | der_capabilities, der_constraints, grid_service_products, service_enrollments, dispatch_schedules, dispatch_setpoints, settlement_events, settlement_periods, electric_vehicles, charging_stations, charging_sessions, energy_communities, community_members, community_allocations, emissions_factors, carbon_credits, forecast_runs, forecast_values, model_registry, model_drift_events, edge_gateways, edge_commands, compliance_rules, compliance_checks, anomaly_events | 0000 |
| `notification-preferences-schema.ts` | notification_preferences | 0000 |
| `payment-credentials-schema.ts` | payment_credentials, payment_gateway_logs (duplicates of `schema.ts` definitions) | 0000 |
| `price-alerts-schema.ts` | price_alerts | 0000 |
| `push-subscriptions-schema.ts` | push_subscriptions | 0000 |
| `qr-history-schema.ts` | qr_code_history | 0000 |
| `reconciliation-schema.ts` | payment_reconciliations, reconciliation_reports, reconciliation_audit_logs | 0000 |
| `referrals-schema.ts` | referrals, referral_rewards | 0000 |
| `strategy-templates-schema.ts` | strategy_templates | 0000 |
| `trading-strategies-schema.ts` | trading_strategies | 0000 |
| `trust-access-schema.ts` | sms_command_log, ntl_flags, price_alert_market_scopes, price_alert_dispatch_log, regulator_reports | 0000 |

### Coverage gaps (as of this repair)

* **Schema tables with no SQL coverage: none.** All 89 tables are in
  `0000_baseline.sql`. Before this repair, 45 tables (all of
  `nextgen-vpp-schema.ts`, `innovations-schema.ts`, `trust-access-schema.ts`,
  `grid-intel-schema.ts`) had no SQL anywhere.
* **SQL creating tables absent from the schema: none.** Every table created by
  the 22 legacy SQL files exists in the schema files.
* **Config gap:** `drizzle.config.ts` `schema: ./drizzle/schema.ts` does not
  (yet) re-export `innovations-schema.ts`, `trust-access-schema.ts`, or
  `grid-intel-schema.ts`, so a future `drizzle-kit generate` with the stock
  config will not see those 20 tables. Their exports should be added to
  `drizzle/schema.ts` (owner: schema author) to keep generated migrations
  aligned with `0000_baseline.sql`.
* **Duplicate definitions:** `devices-schema.ts`, `dr-forecasting-schema.ts`,
  and `payment-credentials-schema.ts` redefine tables also defined inline in
  `schema.ts`. The baseline follows the `schema.ts` definitions (the
  drizzle.config.ts entry point). These duplicate files should eventually be
  reconciled or removed.

## Rollback

Drizzle has no built-in down migrations; roll back manually:

* **Undo 0001:**
  ```sql
  ALTER TABLE `assets` DROP COLUMN `approvalStatus`;
  ALTER TABLE `tokens` MODIFY COLUMN `status` enum('active','used','expired') NOT NULL DEFAULT 'active';
  ALTER TABLE `participant_scores` MODIFY COLUMN `responseTimeScore` int NOT NULL; -- backfill NULLs first
  ```
  Note: shrinking the `tokens.status` enum fails if rows use
  `pending_issuance`; making `responseTimeScore` NOT NULL fails while NULLs exist.
* **Undo 0000 (fresh deployments only — destroys data):** drop the 89 tables.
  There are no foreign keys, so drop order does not matter, e.g.
  ```bash
  grep -oP '(?<=CREATE TABLE IF NOT EXISTS `)[^`]+' drizzle/migrations/0000_baseline.sql \
    | tac | sed 's/.*/DROP TABLE IF EXISTS `&`;/' | mysql -u <user> -p <database>
  ```
* **Never** roll back by editing already-applied migration files; add a new
  forward migration instead.
