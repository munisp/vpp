# Platform Database Seeding and Isolated End-to-End Contract Tests

The platform includes a deterministic schema fixture runner at `scripts/seed-platform.ts`. It introspects the migrated PostgreSQL public schema, truncates **only** explicitly named test databases, and inserts at least one valid row into every public application table. At the currently migrated schema revision, this covers **141 application tables**.

> The seed runner is destructive. It refuses to run unless the database name ends in `_e2e`, `_test`, or `_seed`. Never point it at a production, staging, shared-development, or personal database.

## Prerequisites

Run PostgreSQL locally or in a disposable isolated environment, then ensure the caller has permissions to apply migrations, truncate tables, and insert fixtures. The project uses the database URL supplied in `DATABASE_URL`.

```bash
export DATABASE_URL='postgresql://vpp_e2e:vpp_e2e@127.0.0.1:5432/vpp_e2e'
pnpm exec drizzle-kit migrate
pnpm run seed:platform
```

The seed is deterministic and resets application tables before recreating fixtures, so re-running it gives a stable schema-covered baseline. It preserves real database constraints rather than disabling them. For tables with cross-column integrity requirements, such as ledger postings, network topology, prepaid meter consumption, conformance evidence, and model baselines, it emits intentionally valid failure/refusal/unavailable states where a successful state would require evidence from an external service.

## Isolated contract suite

Run the complete local schema and focused critical-flow contract check with:

```bash
DATABASE_URL='postgresql://vpp_e2e:vpp_e2e@127.0.0.1:5432/vpp_e2e' \
  pnpm run test:e2e:seeded
```

The command applies migrations, seeds every application table, verifies exact non-empty table coverage, verifies selected persisted invariants, and runs the focused payment, wallet, P2P approval, edge authorization, and standalone-platform regression suites. It is a real PostgreSQL integration check, but it does **not** simulate or certify external providers, TigerBeetle, Kafka, Temporal, Keycloak, or field-device behavior.

| Control | Result expected from the seeded harness |
|---|---|
| Database safety | A URL not ending in `_e2e`, `_test`, or `_seed` is rejected before migrations or truncation. |
| Schema coverage | Every public application table other than the migration journal has at least one fixture row. |
| Ledger validity | No seeded ledger posting uses the same debit and credit account. |
| Grid topology validity | Seeded network lines and transformers have distinct endpoints. |
| Prepaid evidence validity | Meter-register consumption equals end register minus start register. |
| Critical regression coverage | Focused payment, wallet, marketplace, edge-control, and standalone contract tests pass. |

## Extending the schema

When a migration adds a public table, `seed-platform.ts` will discover it. If its required columns can be derived from SQL type, enum, foreign-key, default, and nullability metadata, the generic planner adds it automatically. If the table adds a cross-column check constraint or an invariant that cannot be inferred from metadata, add a narrowly scoped statement to `SPECIAL_INSERTS` in `scripts/seed-platform.ts`. The statement must satisfy, rather than disable, the new business rule. The isolated harness is the acceptance test for that change.
