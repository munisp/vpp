/*
 * Deterministic whole-schema fixture seeder.
 *
 * This command is deliberately destructive and refuses any database name that
 * does not contain _e2e, _test, or _seed. It creates one minimally valid,
 * deterministic fixture row per public application table after applying the
 * repository migrations. It is designed for schema coverage and contract/E2E
 * smoke tests; business-flow tests add explicit scenario data separately.
 *
 * Usage:
 *   DATABASE_URL=postgresql://.../vpp_e2e pnpm exec tsx scripts/seed-platform.ts
 */
import pg from "pg";

const { Client } = pg;

type Column = {
  tableName: string;
  columnName: string;
  dataType: string;
  udtName: string;
  nullable: boolean;
  hasDefault: boolean;
  isIdentity: boolean;
  ordinalPosition: number;
  characterMaximumLength: number | null;
  enumLabels: string[];
};

type ForeignKey = {
  tableName: string;
  columnName: string;
  referencedTable: string;
  referencedColumn: string;
};

type TablePlan = {
  tableName: string;
  columns: Column[];
  foreignKeys: Map<string, ForeignKey>;
};

const FIXTURE_TIMESTAMP = "2026-01-02T03:04:05.000Z";
const SAFE_DATABASE = /(?:_e2e|_test|_seed)$/i;

// Tables below encode cross-column business invariants that cannot be inferred
// from column types alone. These rows deliberately represent failed/refused or
// unavailable states when that is the smallest honest fixture state.
const SPECIAL_INSERTS: Record<string, string> = {
  conformance_runs: `
    INSERT INTO "conformance_runs" (
      "adapter", "adapter_version", "protocol_version", "device_model", "target",
      "vector_set_id", "vector_set_version", "total_cases", "passed_cases",
      "failed_cases", "skipped_cases", "outcome", "operator", "started_at",
      "completed_at", "artifact_checksum"
    ) VALUES (
      'ocpp16', 'seed-1', '1.6', 'seed-device', 'simulator',
      'seed-vectors', '1', 0, 0, 0, 0, 'failed', 'seed-operator',
      '2026-01-02T03:04:05Z'::timestamp, '2026-01-02T04:04:05Z'::timestamp,
      repeat('0', 64)
    )`,
  design_study_versions: `
    INSERT INTO "design_study_versions" (
      "study_id", "version", "status", "reason", "input_digest", "request", "load_source"
    ) VALUES (
      (SELECT id FROM "design_studies" ORDER BY id LIMIT 1), 1,
      (SELECT e.enumlabel::design_study_status FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'design_study_status' AND e.enumlabel <> 'optimal' ORDER BY e.enumsortorder LIMIT 1),
      'seed study was not executed', repeat('0', 64), '{}'::jsonb,
      (SELECT e.enumlabel::profile_source FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'profile_source' ORDER BY e.enumsortorder LIMIT 1)
    )`,
  diagnostic_runs: `
    INSERT INTO "diagnostic_runs" (
      "state", "question", "requested_by", "evidence", "evidence_digest", "finished_at", "error"
    ) VALUES (
      'failed', 'seed diagnostic request', (SELECT id FROM "users" ORDER BY id LIMIT 1),
      '{}'::jsonb, repeat('0', 64), '2026-01-02T04:04:05Z'::timestamp, 'seeded failure state'
    )`,
  diagnostic_findings: `
    INSERT INTO "diagnostic_findings" (
      "run_id", "title", "hypothesis", "recommended_action", "confidence", "observation_ids"
    ) VALUES (
      (SELECT id FROM "diagnostic_runs" ORDER BY id LIMIT 1), 'seed finding',
      'seed hypothesis', 'seed action', 'low', ARRAY['seed-observation']::text[]
    )`,
  grid_network_lines: `
    INSERT INTO "grid_network_lines" (
      "code", "from_node_id", "to_node_id", "length_m", "resistance_mohm_per_km",
      "reactance_mohm_per_km", "capacitance_nf_per_km", "max_current_ma", "parallel_circuits"
    ) VALUES (
      'seed-line', (SELECT id FROM "grid_nodes" ORDER BY id LIMIT 1),
      (SELECT id FROM "grid_nodes" ORDER BY id OFFSET 1 LIMIT 1), 1, 1, 1, 0, 1, 1
    )`,
  grid_network_transformers: `
    INSERT INTO "grid_network_transformers" (
      "code", "hv_node_id", "lv_node_id", "rated_kva", "hv_volts", "lv_volts",
      "short_circuit_percent_x100", "short_circuit_resistive_percent_x100", "iron_loss_w", "open_loop_current_percent_x100"
    ) VALUES (
      'seed-transformer', (SELECT id FROM "grid_nodes" ORDER BY id LIMIT 1),
      (SELECT id FROM "grid_nodes" ORDER BY id OFFSET 1 LIMIT 1), 1, 1, 1, 1, 0, 0, 0
    )`,
  lakehouse_baselines: `
    INSERT INTO "lakehouse_baselines" (
      "dataset", "metric", "unit", "window_start", "window_end", "value", "sample_rows", "source_objects", "runner"
    ) VALUES (
      'seed_dataset', 'seed_metric', 'count', '2026-01-02T03:04:05Z'::timestamp,
      '2026-01-02T04:04:05Z'::timestamp, 1, 1, ARRAY['s3://seed/object.parquet']::text[], 'seed-runner'
    )`,
  ledger_postings: `
    INSERT INTO "ledger_postings" (
      "posting_kind", "source_type", "source_id", "currency", "amount_minor",
      "debit_account_id", "credit_account_id", "tb_transfer_id"
    ) VALUES (
      (SELECT e.enumlabel::ledger_posting_kind FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'ledger_posting_kind' ORDER BY e.enumsortorder LIMIT 1),
      'seed', 1,
      (SELECT e.enumlabel::ledger_currency FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'ledger_currency' ORDER BY e.enumsortorder LIMIT 1),
      1, (SELECT id FROM "ledger_accounts" ORDER BY id LIMIT 1),
      (SELECT id FROM "ledger_accounts" ORDER BY id OFFSET 1 LIMIT 1), 'seed-transfer'
    )`,
  model_feature_baselines: `
    INSERT INTO "model_feature_baselines" (
      "model_id", "dataset_id", "feature", "mean", "std", "p05", "p50", "p95",
      "bin_edges", "bin_shares", "sample_count"
    ) VALUES (
      (SELECT id FROM "model_registry" ORDER BY id LIMIT 1),
      (SELECT id FROM "training_datasets" ORDER BY id LIMIT 1), 'seed_feature',
      0, 0, 0, 0, 0, ARRAY[0::float8, 1::float8], ARRAY[1::float8], 1
    )`,
  network_feasibility_studies: `
    INSERT INTO "network_feasibility_studies" (
      "subject", "status", "reason", "buses", "violation_count", "request"
    ) VALUES (
      (SELECT e.enumlabel::feasibility_subject FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'feasibility_subject' ORDER BY e.enumsortorder LIMIT 1),
      'service_unavailable', 'seed service unavailable', 0, 0, '{}'::jsonb
    )`,
  prepaid_consumption: `
    INSERT INTO "prepaid_consumption" (
      "account_id", "from_at", "to_at", "register_start_wh", "register_end_wh", "energy_wh", "source", "evidence_ref"
    ) VALUES (
      (SELECT id FROM "prepaid_accounts" ORDER BY id LIMIT 1),
      '2026-01-02T03:04:05Z'::timestamp, '2026-01-02T04:04:05Z'::timestamp,
      1, 2, 1, 'meter_register', 'seed-meter-reading'
    )`,
  training_runs: `
    INSERT INTO "training_runs" (
      "dataset_id", "model_name", "model_kind", "state", "framework", "framework_version",
      "compute", "hyperparameters", "epochs_requested", "runner", "trigger", "finished_at", "error"
    ) VALUES (
      (SELECT id FROM "training_datasets" ORDER BY id LIMIT 1), 'seed-model', 'seed-kind', 'failed',
      'seed-framework', '1', 'cpu', '{}'::jsonb, 1, 'seed-runner', 'seed',
      '2026-01-02T04:04:05Z'::timestamp, 'seeded failure state'
    )`,
};

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function assertSafeDatabase(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  const database = url.pathname.replace(/^\//, "");
  if (!SAFE_DATABASE.test(database)) {
    throw new Error(
      `Refusing destructive seed against database ${JSON.stringify(database)}. ` +
        "Use a database name ending in _e2e, _test, or _seed."
    );
  }
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function deterministicText(column: Column): string {
  const value = `seed_${column.tableName}_${column.columnName}`;
  return value.slice(0, Math.min(column.characterMaximumLength ?? 200, 200));
}

function scalarExpression(column: Column): string {
  if (column.enumLabels.length > 0) {
    // Prefer a non-success terminal state when present. It minimizes evidence
    // requirements (for example, a successful diagnostic requires an answer)
    // while still respecting the table's enumerated business state.
    const preferred = ["failed", "refused", "cancelled", "inactive", "draft", "pending", "created", "open"];
    return literal(preferred.find(value => column.enumLabels.includes(value)) ?? column.enumLabels[0]);
  }
  if (["passed_cases", "failed_cases", "skipped_cases", "total_cases"].includes(column.columnName)) return "0";
  const type = column.dataType.toLowerCase();
  const udt = column.udtName.toLowerCase();

  if (type === "boolean") return "false";
  if (["smallint", "integer", "bigint", "numeric", "decimal", "real", "double precision"].includes(type)) return "1";
  if (type === "date") {
    return /(?:end|to|completed|expires|until)/i.test(column.columnName)
      ? "'2026-01-03'::date"
      : `${literal(FIXTURE_TIMESTAMP.slice(0, 10))}::date`;
  }
  if (type.includes("timestamp")) {
    return /(?:end|to|completed|expires|until)/i.test(column.columnName)
      ? "'2026-01-02T04:04:05.000Z'::timestamp"
      : `${literal(FIXTURE_TIMESTAMP)}::timestamp`;
  }
  if (type === "time without time zone" || type === "time with time zone") return "'03:04:05'";
  if (type === "json" || type === "jsonb") return `'{}'::${type}`;
  if (type === "uuid") return "'00000000-0000-4000-8000-000000000001'::uuid";
  if (type === "bytea") return "decode('00', 'hex')";
  if (type === "inet" || type === "cidr") return "'127.0.0.1'";
  if (type === "interval") return "'1 second'::interval";
  if (type === "array" || column.dataType.endsWith("[]")) return `'{}'::${quoteIdentifier(column.udtName)}`;
  if (udt === "tsvector") return "''::tsvector";
  if (udt === "point") return "'(0,0)'::point";
  return literal(deterministicText(column));
}

async function loadPlans(client: Client): Promise<TablePlan[]> {
  const columns = await client.query<Column>(`
    SELECT
      c.table_name AS "tableName",
      c.column_name AS "columnName",
      c.data_type AS "dataType",
      c.udt_name AS "udtName",
      c.is_nullable = 'YES' AS nullable,
      c.column_default IS NOT NULL AS "hasDefault",
      c.is_identity = 'YES' AS "isIdentity",
      c.ordinal_position AS "ordinalPosition",
      c.character_maximum_length AS "characterMaximumLength",
      COALESCE(enum_values.labels, '[]'::json) AS "enumLabels"
    FROM information_schema.columns c
    LEFT JOIN LATERAL (
      SELECT json_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = c.udt_name
    ) enum_values ON true
    WHERE c.table_schema = 'public'
      AND c.table_name <> '__drizzle_migrations'
    ORDER BY c.table_name, c.ordinal_position
  `);

  const foreignKeys = await client.query<ForeignKey>(`
    SELECT
      child.relname AS "tableName",
      child_attribute.attname AS "columnName",
      parent.relname AS "referencedTable",
      parent_attribute.attname AS "referencedColumn"
    FROM pg_constraint con
    JOIN pg_class child ON child.oid = con.conrelid
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN LATERAL unnest(con.conkey) WITH ORDINALITY child_keys(attnum, position) ON true
    JOIN LATERAL unnest(con.confkey) WITH ORDINALITY parent_keys(attnum, position)
      ON parent_keys.position = child_keys.position
    JOIN pg_attribute child_attribute ON child_attribute.attrelid = child.oid AND child_attribute.attnum = child_keys.attnum
    JOIN pg_attribute parent_attribute ON parent_attribute.attrelid = parent.oid AND parent_attribute.attnum = parent_keys.attnum
    WHERE con.contype = 'f'
      AND child.relnamespace = 'public'::regnamespace
  `);

  const plans = new Map<string, TablePlan>();
  for (const column of columns.rows) {
    const plan = plans.get(column.tableName) ?? {
      tableName: column.tableName,
      columns: [],
      foreignKeys: new Map(),
    };
    plan.columns.push(column);
    plans.set(column.tableName, plan);
  }
  for (const fk of foreignKeys.rows) {
    const plan = plans.get(fk.tableName);
    if (plan) plan.foreignKeys.set(fk.columnName, fk);
  }
  return [...plans.values()];
}

function insertStatement(plan: TablePlan): string {
  if (SPECIAL_INSERTS[plan.tableName]) return SPECIAL_INSERTS[plan.tableName];
  const columns = plan.columns.filter(column =>
    !column.nullable && !column.hasDefault && !column.isIdentity
  );
  if (columns.length === 0) {
    return `INSERT INTO ${quoteIdentifier(plan.tableName)} DEFAULT VALUES`;
  }

  const values = columns.map(column => {
    const fk = plan.foreignKeys.get(column.columnName);
    if (fk) {
      return `(SELECT ${quoteIdentifier(fk.referencedColumn)} FROM ${quoteIdentifier(fk.referencedTable)} ORDER BY 1 LIMIT 1)`;
    }
    return scalarExpression(column);
  });

  return `INSERT INTO ${quoteIdentifier(plan.tableName)} (${columns.map(column => quoteIdentifier(column.columnName)).join(", ")}) VALUES (${values.join(", ")})`;
}

async function truncateApplicationTables(client: Client, plans: TablePlan[]): Promise<void> {
  const tables = plans.map(plan => quoteIdentifier(plan.tableName)).join(", ");
  if (!tables) throw new Error("No public application tables were discovered.");
  await client.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}

async function ensureSecondParentRows(client: Client, tableName: string): Promise<void> {
  if (tableName === "grid_nodes") {
    await client.query(`
      INSERT INTO "grid_nodes" ("code", "name", "kind")
      SELECT "code" || '-secondary', "name" || ' secondary', "kind"
      FROM "grid_nodes" ORDER BY id LIMIT 1
    `);
  }
  if (tableName === "ledger_accounts") {
    await client.query(`
      INSERT INTO "ledger_accounts" ("account_kind", "currency", "tb_account_id", "ledger_code")
      SELECT "account_kind", "currency", 'seed-ledger-secondary', "ledger_code" + 1
      FROM "ledger_accounts" ORDER BY id LIMIT 1
    `);
  }
}

async function seedAllTables(client: Client, plans: TablePlan[]): Promise<void> {
  const pending = new Map(plans.map(plan => [plan.tableName, plan]));
  const failures = new Map<string, string>();

  for (let pass = 1; pending.size > 0 && pass <= plans.length; pass += 1) {
    let progress = 0;
    for (const [tableName, plan] of [...pending]) {
      await client.query("SAVEPOINT whole_schema_seed_row");
      try {
        await client.query(insertStatement(plan));
        await client.query("RELEASE SAVEPOINT whole_schema_seed_row");
        await ensureSecondParentRows(client, tableName);
        pending.delete(tableName);
        failures.delete(tableName);
        progress += 1;
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT whole_schema_seed_row");
        const message = error instanceof Error ? error.message : String(error);
        failures.set(tableName, message.replace(/\s+/g, " ").slice(0, 500));
      }
    }
    if (progress === 0) break;
  }

  if (pending.size > 0) {
    const detail = [...pending.keys()]
      .sort()
      .map(table => `- ${table}: ${failures.get(table) ?? "dependency did not resolve"}`)
      .join("\n");
    throw new Error(`Whole-schema seed could not create rows for ${pending.size} table(s):\n${detail}`);
  }
}

async function verifyCoverage(client: Client, plans: TablePlan[]): Promise<void> {
  const missing: string[] = [];
  for (const plan of plans) {
    const result = await client.query(`SELECT count(*)::int AS count FROM ${quoteIdentifier(plan.tableName)}`);
    if (result.rows[0]?.count < 1) missing.push(plan.tableName);
  }
  if (missing.length) {
    throw new Error(`Seed coverage failed; empty table(s): ${missing.sort().join(", ")}`);
  }
}

export async function seedPlatformDatabase(databaseUrl = process.env.DATABASE_URL): Promise<{ tableCount: number }> {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  assertSafeDatabase(databaseUrl);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const plans = await loadPlans(client);
    await client.query("BEGIN");
    await truncateApplicationTables(client, plans);
    await seedAllTables(client, plans);
    await verifyCoverage(client, plans);
    await client.query("COMMIT");
    return { tableCount: plans.length };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedPlatformDatabase()
    .then(({ tableCount }) => console.log(`Seeded ${tableCount} public application tables.`))
    .catch(error => {
      console.error("Platform seed failed:", error);
      process.exitCode = 1;
    });
}
