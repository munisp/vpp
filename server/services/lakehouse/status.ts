/**
 * What the platform can honestly say about the lakehouse.
 *
 * The ingestion job itself is Python (`services/lakehouse/`), so this module
 * reads only its bookkeeping: `lakehouse_runs` (one row per attempt, with the
 * object key and digest of what was actually stored) and `lakehouse_watermarks`
 * (how far each dataset has been ingested).
 *
 * The point is that nothing here infers health from configuration. A dataset that
 * has never run reports `never_run`; a dataset whose last run failed reports the
 * job's own error; a dataset whose newest successful run is older than the
 * freshness budget reports `stale` even though every past run succeeded. Backlog
 * is counted against the source table, so "behind by N rows" is a measurement.
 */

import { sql } from 'drizzle-orm';
import { getDb } from '../../db';

/** Kept in step with `services/lakehouse/lakehouse/datasets.py`. */
export interface DatasetSource {
  dataset: string;
  table: string;
  changeColumn: string;
  idColumn: string;
  description: string;
}

export const LAKEHOUSE_DATASETS: readonly DatasetSource[] = [
  {
    dataset: 'telemetry',
    table: 'telemetry',
    changeColumn: 'createdAt',
    idColumn: 'id',
    description: 'Per-asset meter and device samples as received, in receipt order.',
  },
  {
    dataset: 'payments',
    table: 'payments',
    changeColumn: 'updatedAt',
    idColumn: 'id',
    description: 'Mobile-money payment versions, without subscriber contact details.',
  },
  {
    dataset: 'trades',
    table: 'trades',
    changeColumn: 'updatedAt',
    idColumn: 'id',
    description: 'Energy trade versions, in status-change order.',
  },
  {
    dataset: 'p2p_settlements',
    table: 'p2p_settlements',
    changeColumn: 'updatedAt',
    idColumn: 'id',
    description: 'P2P settlement versions with measured delivery and payout state.',
  },
  {
    dataset: 'settlement_events',
    table: 'settlement_events',
    changeColumn: 'created_at',
    idColumn: 'id',
    description: 'The hash-chained settlement ledger, append-only.',
  },
  {
    dataset: 'event_inbox',
    table: 'event_inbox',
    changeColumn: 'consumed_at',
    idColumn: 'id',
    description: 'Kafka events this platform actually consumed.',
  },
] as const;

export type DatasetState = 'fresh' | 'stale' | 'failing' | 'never_run';

export interface DatasetStatus extends DatasetSource {
  state: DatasetState;
  /** Newest run of any state, so a failing dataset is not reported by its last success. */
  lastRunState: string | null;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  /** Object of the newest successful non-empty run: evidence, not an assumption. */
  lastObjectKey: string | null;
  rowsIngested: number;
  watermarkAt: Date | null;
  /** Source rows past the watermark. `null` when the source could not be counted. */
  rowsBehind: number | null;
  detail: string;
}

export interface LakehouseStatus {
  freshnessSeconds: number;
  datasets: DatasetStatus[];
  /** True only when every dataset has a successful or empty run inside the budget. */
  allFresh: boolean;
  detail: string;
}

export function freshnessSeconds(): number {
  const raw = Number(process.env.LAKEHOUSE_FRESHNESS_SECONDS ?? '');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3_600;
}

function asDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * A dataset's state from its bookkeeping alone. Exported because this is the
 * judgement an operator acts on: a failing dataset must not be described by its
 * last success, and "no run at all" is not the same as "nothing to ingest".
 */
export function classify(
  lastRunState: string | null,
  lastCompletedAt: Date | null,
  budgetSeconds: number,
  now: number
): DatasetState {
  if (lastRunState === null) return 'never_run';
  if (lastRunState === 'failed') return 'failing';
  if (lastCompletedAt === null) return 'never_run';
  return now - lastCompletedAt.getTime() <= budgetSeconds * 1_000 ? 'fresh' : 'stale';
}

export function describe(status: Omit<DatasetStatus, 'detail'>, budgetSeconds: number): string {
  switch (status.state) {
    case 'never_run':
      return `Never ingested. Nothing from ${status.table} is in the lake, so any query over it is answering from an empty dataset.`;
    case 'failing':
      return `The last run failed: ${status.lastError ?? 'no error was recorded'}. The watermark did not move, so these rows will be re-read once the cause is fixed.`;
    case 'stale':
      return `No successful run in the last ${budgetSeconds}s${
        status.rowsBehind === null ? '' : `; ${status.rowsBehind} source row(s) are not in the lake`
      }.`;
    default:
      return status.rowsBehind === null
        ? 'Ingesting; the source row count could not be read, so the backlog is unknown.'
        : `Ingesting; ${status.rowsBehind} source row(s) not yet written.`;
  }
}

/**
 * Rows past the watermark, or `null` when that cannot be established — an
 * unreadable source is reported as unknown rather than as zero backlog.
 */
async function countBehind(
  source: DatasetSource,
  watermarkAt: Date | null,
  watermarkId: number | null
): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  const table = sql.identifier(source.table);
  const change = sql.identifier(source.changeColumn);
  const id = sql.identifier(source.idColumn);
  try {
    const counted =
      watermarkAt === null || watermarkId === null
        ? await db.execute<{ behind: string }>(
            sql`SELECT COUNT(*) AS behind FROM ${table}`
          )
        : await db.execute<{ behind: string }>(
            sql`SELECT COUNT(*) AS behind FROM ${table}
                WHERE (${table}.${change}, ${table}.${id}) > (${watermarkAt}, ${watermarkId})`
          );
    const behind = Number(counted.rows[0]?.behind ?? NaN);
    return Number.isFinite(behind) ? behind : null;
  } catch {
    return null;
  }
}

export async function lakehouseStatus(): Promise<LakehouseStatus> {
  const db = await getDb();
  if (!db) throw new Error('No database connection, so lakehouse ingestion cannot be read.');

  const budget = freshnessSeconds();
  const now = Date.now();

  const watermarks = await db.execute<Record<string, unknown>>(sql`
    SELECT dataset, watermark_at, watermark_id, rows_ingested
      FROM lakehouse_watermarks
  `);
  const byDataset = new Map(watermarks.rows.map(row => [String(row.dataset), row]));

  // Newest run per dataset, plus the newest that actually stored an object. The
  // two differ exactly when ingestion has started failing, which is the case an
  // operator needs to see.
  const runs = await db.execute<Record<string, unknown>>(sql`
    SELECT DISTINCT ON (dataset)
           dataset, state, started_at, finished_at, error
      FROM lakehouse_runs
     ORDER BY dataset, id DESC
  `);
  const latestRun = new Map(runs.rows.map(row => [String(row.dataset), row]));

  const successes = await db.execute<Record<string, unknown>>(sql`
    SELECT DISTINCT ON (dataset)
           dataset, finished_at, object_key
      FROM lakehouse_runs
     WHERE state IN ('succeeded', 'empty')
     ORDER BY dataset, id DESC
  `);
  const latestSuccess = new Map(successes.rows.map(row => [String(row.dataset), row]));

  const datasets: DatasetStatus[] = [];
  for (const source of LAKEHOUSE_DATASETS) {
    const watermark = byDataset.get(source.dataset);
    const run = latestRun.get(source.dataset);
    const success = latestSuccess.get(source.dataset);

    const watermarkAt = asDate(watermark?.watermark_at);
    const watermarkIdRaw = watermark?.watermark_id;
    const watermarkId =
      watermarkIdRaw === null || watermarkIdRaw === undefined ? null : Number(watermarkIdRaw);

    const lastRunState = run ? String(run.state) : null;
    const lastSuccessAt = asDate(success?.finished_at);
    const state = classify(lastRunState, lastSuccessAt, budget, now);
    const partial: Omit<DatasetStatus, 'detail'> = {
      ...source,
      state,
      lastRunState,
      lastRunAt: asDate(run?.finished_at) ?? asDate(run?.started_at),
      lastSuccessAt,
      lastError: run?.error === null || run?.error === undefined ? null : String(run.error),
      lastObjectKey:
        success?.object_key === null || success?.object_key === undefined
          ? null
          : String(success.object_key),
      rowsIngested: Number(watermark?.rows_ingested ?? 0),
      watermarkAt,
      rowsBehind: await countBehind(source, watermarkAt, watermarkId),
    };
    datasets.push({ ...partial, detail: describe(partial, budget) });
  }

  const allFresh = datasets.every(dataset => dataset.state === 'fresh');
  const failing = datasets.filter(dataset => dataset.state === 'failing').length;
  const neverRun = datasets.filter(dataset => dataset.state === 'never_run').length;

  return {
    freshnessSeconds: budget,
    datasets,
    allFresh,
    detail: allFresh
      ? `All ${datasets.length} datasets ingested within ${budget}s.`
      : `${failing} failing, ${neverRun} never ingested, ${
          datasets.filter(dataset => dataset.state === 'stale').length
        } stale of ${datasets.length} datasets — the lake is not a complete view of the platform.`,
  };
}

export interface LakehouseRunRow {
  id: number;
  dataset: string;
  state: string;
  runner: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  rowsWritten: number;
  bytesWritten: number;
  objectKey: string | null;
  objectDigest: string | null;
  error: string | null;
}

export async function recentRuns(limit = 50): Promise<LakehouseRunRow[]> {
  const db = await getDb();
  if (!db) throw new Error('No database connection, so lakehouse runs cannot be read.');
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT id, dataset, state, runner, started_at, finished_at,
           rows_written, bytes_written, object_key, object_digest, error
      FROM lakehouse_runs
     ORDER BY id DESC
     LIMIT ${limit}
  `);
  return result.rows.map(row => ({
    id: Number(row.id),
    dataset: String(row.dataset),
    state: String(row.state),
    runner: String(row.runner ?? ''),
    startedAt: asDate(row.started_at),
    finishedAt: asDate(row.finished_at),
    rowsWritten: Number(row.rows_written ?? 0),
    bytesWritten: Number(row.bytes_written ?? 0),
    objectKey: row.object_key === null || row.object_key === undefined ? null : String(row.object_key),
    objectDigest:
      row.object_digest === null || row.object_digest === undefined
        ? null
        : String(row.object_digest),
    error: row.error === null || row.error === undefined ? null : String(row.error),
  }));
}
