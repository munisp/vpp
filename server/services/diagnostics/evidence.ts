/**
 * The facts a diagnosis is allowed to rest on.
 *
 * Every observation here is a measurement with its source named, and every probe
 * can come back `available: false` carrying the database's own error. That
 * distinction is the point: a diagnostic tool that renders an unreadable table as
 * "0 problems" is worse than one that says nothing, because an operator acts on
 * it. Nothing in this module interprets — no thresholds are called "critical"
 * here — it only counts, and the counts are what the model is shown.
 *
 * Lake-derived baselines are included where they exist, with the objects and row
 * count behind them, so "N times the baseline" can be checked. A missing baseline
 * is reported as missing; the live figure is never compared against a default.
 */

import { sql } from 'drizzle-orm';
import { getDb } from '../../db';
import { lakehouseStatus } from '../lakehouse/status';

export interface Observation {
  /** Stable id the model must cite; findings are rejected when they cite anything else. */
  id: string;
  area: 'lakehouse' | 'events' | 'ledger' | 'payments' | 'control' | 'telemetry' | 'baseline';
  title: string;
  /** False when the probe could not read its source. Never silently zero. */
  available: boolean;
  /** Measured values only. */
  measures: Record<string, number | string | null>;
  /** Table(s) and window the numbers came from. */
  source: string;
  detail: string;
}

export interface EvidenceBundle {
  collectedAt: string;
  observations: Observation[];
  availableCount: number;
  unavailableCount: number;
  detail: string;
}

function failure(
  id: Observation['id'],
  area: Observation['area'],
  title: string,
  source: string,
  error: unknown
): Observation {
  const message = error instanceof Error ? error.message : String(error);
  return {
    id,
    area,
    title,
    available: false,
    measures: {},
    source,
    detail: `Could not be read: ${message}. Treat this area as unknown, not healthy.`,
  };
}

async function query<T extends Record<string, unknown>>(
  statement: ReturnType<typeof sql>
): Promise<T[]> {
  const db = await getDb();
  if (!db) throw new Error('no database connection');
  const result = await db.execute<T>(statement);
  return result.rows as T[];
}

function count(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Lakehouse ingestion, as the job itself recorded it. */
async function lakehouseObservations(): Promise<Observation[]> {
  try {
    const status = await lakehouseStatus();
    const summary: Observation = {
      id: 'lakehouse.freshness',
      area: 'lakehouse',
      title: 'Lakehouse ingestion freshness',
      available: true,
      measures: {
        datasets: status.datasets.length,
        fresh: status.datasets.filter(dataset => dataset.state === 'fresh').length,
        stale: status.datasets.filter(dataset => dataset.state === 'stale').length,
        failing: status.datasets.filter(dataset => dataset.state === 'failing').length,
        neverRun: status.datasets.filter(dataset => dataset.state === 'never_run').length,
        freshnessBudgetSeconds: status.freshnessSeconds,
      },
      source: 'lakehouse_runs, lakehouse_watermarks',
      detail: status.detail,
    };

    const problems = status.datasets
      .filter(dataset => dataset.state !== 'fresh')
      .map<Observation>(dataset => ({
        id: `lakehouse.dataset.${dataset.dataset}`,
        area: 'lakehouse',
        title: `Lakehouse dataset ${dataset.dataset} is ${dataset.state}`,
        available: true,
        measures: {
          state: dataset.state,
          lastRunState: dataset.lastRunState,
          lastSuccessAt: dataset.lastSuccessAt?.toISOString() ?? null,
          rowsBehind: dataset.rowsBehind,
          lastError: dataset.lastError,
        },
        source: `lakehouse_runs, ${dataset.table}`,
        detail: dataset.detail,
      }));

    return [summary, ...problems];
  } catch (error) {
    return [
      failure(
        'lakehouse.freshness',
        'lakehouse',
        'Lakehouse ingestion freshness',
        'lakehouse_runs, lakehouse_watermarks',
        error
      ),
    ];
  }
}

/** Events written but not yet accepted by the broker, and events given up on. */
async function eventObservations(): Promise<Observation[]> {
  const observations: Observation[] = [];

  try {
    const rows = await query<{
      unpublished: string;
      oldest_age_seconds: string | null;
      max_attempts: string | null;
      last_error: string | null;
    }>(sql`
      SELECT COUNT(*) AS unpublished,
             MAX(EXTRACT(EPOCH FROM (now() - created_at)))::int AS oldest_age_seconds,
             MAX(attempts) AS max_attempts,
             (SELECT last_error FROM event_outbox
               WHERE published_at IS NULL AND last_error IS NOT NULL
               ORDER BY id DESC LIMIT 1) AS last_error
        FROM event_outbox
       WHERE published_at IS NULL
    `);
    const row = rows[0];
    const unpublished = count(row?.unpublished);
    const oldest = row?.oldest_age_seconds === null ? null : count(row?.oldest_age_seconds);
    observations.push({
      id: 'events.outbox_backlog',
      area: 'events',
      title: 'Unpublished outbox events',
      available: true,
      measures: {
        unpublished,
        oldestAgeSeconds: oldest,
        maxAttempts: row?.max_attempts === null ? null : count(row?.max_attempts),
        lastError: row?.last_error ?? null,
      },
      source: 'event_outbox WHERE published_at IS NULL',
      detail:
        unpublished === 0
          ? 'Every recorded event has been acknowledged by the broker.'
          : `${unpublished} event(s) recorded in a transaction have not been acknowledged by the broker; the oldest is ${oldest ?? 'unknown'}s old.`,
    });
  } catch (error) {
    observations.push(
      failure('events.outbox_backlog', 'events', 'Unpublished outbox events', 'event_outbox', error)
    );
  }

  try {
    const rows = await query<{ pending: string; topics: string | null }>(sql`
      SELECT COUNT(*) AS pending,
             string_agg(DISTINCT topic, ', ') AS topics
        FROM event_dead_letters
       WHERE acknowledged_at IS NULL
    `);
    const pending = count(rows[0]?.pending);
    observations.push({
      id: 'events.dead_letters',
      area: 'events',
      title: 'Unacknowledged dead-lettered events',
      available: true,
      measures: { pending, topics: rows[0]?.topics ?? null },
      source: 'event_dead_letters WHERE acknowledged_at IS NULL',
      detail:
        pending === 0
          ? 'No consumed event has been given up on.'
          : `${pending} event(s) failed processing and are waiting for an operator on ${rows[0]?.topics ?? 'unknown topics'}.`,
    });
  } catch (error) {
    observations.push(
      failure(
        'events.dead_letters',
        'events',
        'Unacknowledged dead-lettered events',
        'event_dead_letters',
        error
      )
    );
  }

  return observations;
}

/** Money the platform has shown members but the ledger has not accepted. */
async function ledgerObservations(): Promise<Observation[]> {
  try {
    const rows = await query<{ state: string; postings: string; amount_minor: string | null }>(sql`
      SELECT state, COUNT(*) AS postings, SUM(amount_minor) AS amount_minor
        FROM ledger_postings
       WHERE created_at > now() - interval '7 days'
       GROUP BY state
    `);
    const byState = new Map(rows.map(row => [row.state, row]));
    const unposted = ['pending', 'refused', 'unavailable_no_ledger'].reduce(
      (total, state) => total + count(byState.get(state)?.postings),
      0
    );
    return [
      {
        id: 'ledger.unposted',
        area: 'ledger',
        title: 'Ledger postings not applied by TigerBeetle',
        available: true,
        measures: {
          pending: count(byState.get('pending')?.postings),
          refused: count(byState.get('refused')?.postings),
          unavailableNoLedger: count(byState.get('unavailable_no_ledger')?.postings),
          posted: count(byState.get('posted')?.postings),
          unpostedAmountMinor:
            count(byState.get('pending')?.amount_minor) +
            count(byState.get('refused')?.amount_minor) +
            count(byState.get('unavailable_no_ledger')?.amount_minor),
        },
        source: "ledger_postings, last 7 days, grouped by state",
        detail:
          unposted === 0
            ? 'Every posting in the last 7 days was applied by the ledger.'
            : `${unposted} posting(s) in the last 7 days are not on the ledger, so balances shown to members are not backed by it.`,
      },
    ];
  } catch (error) {
    return [
      failure(
        'ledger.unposted',
        'ledger',
        'Ledger postings not applied by TigerBeetle',
        'ledger_postings',
        error
      ),
    ];
  }
}

/** Payments that have neither settled nor failed. */
async function paymentObservations(): Promise<Observation[]> {
  try {
    const rows = await query<{ status: string; payments: string; amount: string | null }>(sql`
      SELECT status, COUNT(*) AS payments, SUM(amount) AS amount
        FROM payments
       WHERE "createdAt" > now() - interval '24 hours'
       GROUP BY status
    `);
    const byStatus = new Map(rows.map(row => [row.status, row]));
    const pending = count(byStatus.get('pending')?.payments);
    const failed = count(byStatus.get('failed')?.payments);
    const completed = count(byStatus.get('completed')?.payments);
    const total = rows.reduce((sum, row) => sum + count(row.payments), 0);
    return [
      {
        id: 'payments.last_24h',
        area: 'payments',
        title: 'Payment outcomes in the last 24 hours',
        available: true,
        measures: {
          total,
          pending,
          failed,
          completed,
          pendingAmountMinor: count(byStatus.get('pending')?.amount),
        },
        source: 'payments, last 24 hours, grouped by status',
        detail:
          total === 0
            ? 'No payment was created in the last 24 hours, so this window says nothing about the gateways.'
            : `${total} payment(s): ${completed} completed, ${pending} still pending, ${failed} failed.`,
      },
    ];
  } catch (error) {
    return [
      failure('payments.last_24h', 'payments', 'Payment outcomes in the last 24 hours', 'payments', error),
    ];
  }
}

/** Controls whose window ran out without their declared fallback being applied. */
async function controlObservations(): Promise<Observation[]> {
  try {
    const rows = await query<{ expired: string; oldest_age_seconds: string | null }>(sql`
      SELECT COUNT(*) AS expired,
             MAX(EXTRACT(EPOCH FROM (now() - valid_to)))::int AS oldest_age_seconds
        FROM control_assignments
       WHERE valid_to < now()
         AND superseded_at IS NULL
         AND fallback_applied_at IS NULL
         AND delivery IN ('accepted', 'broker_queued')
    `);
    const expired = count(rows[0]?.expired);
    return [
      {
        id: 'control.expired_without_fallback',
        area: 'control',
        title: 'Expired controls with no fallback applied',
        available: true,
        measures: {
          expired,
          oldestAgeSeconds:
            rows[0]?.oldest_age_seconds === null ? null : count(rows[0]?.oldest_age_seconds),
        },
        source:
          'control_assignments WHERE valid_to < now() AND fallback_applied_at IS NULL AND delivery in (accepted, broker_queued)',
        detail:
          expired === 0
            ? 'Every control that has run out has had its fallback applied or was superseded.'
            : `${expired} control(s) have run out with no fallback recorded — the device may still be holding the last setpoint. Check that the fallback sweeper is running (GRID_CONTROL_SWEEP_MS).`,
      },
    ];
  } catch (error) {
    return [
      failure(
        'control.expired_without_fallback',
        'control',
        'Expired controls with no fallback applied',
        'control_assignments',
        error
      ),
    ];
  }
}

/** Assets the platform is meant to be metering but has heard nothing from. */
async function telemetryObservations(): Promise<Observation[]> {
  const observations: Observation[] = [];
  try {
    const rows = await query<{ active_assets: string; reporting: string; samples: string }>(sql`
      SELECT (SELECT COUNT(*) FROM assets WHERE status = 'active') AS active_assets,
             COUNT(DISTINCT t."assetId") AS reporting,
             COUNT(*) AS samples
        FROM telemetry t
       WHERE t."timestamp" > now() - interval '1 hour'
    `);
    const active = count(rows[0]?.active_assets);
    const reporting = count(rows[0]?.reporting);
    const samples = count(rows[0]?.samples);
    observations.push({
      id: 'telemetry.coverage_1h',
      area: 'telemetry',
      title: 'Telemetry coverage in the last hour',
      available: true,
      measures: { activeAssets: active, reportingAssets: reporting, samples, silent: active - reporting },
      source: 'telemetry (last hour) against assets WHERE status = active',
      detail:
        active === 0
          ? 'No asset is marked active, so there is no coverage to measure.'
          : `${reporting} of ${active} active asset(s) reported in the last hour (${samples} sample(s)); ${
              active - reporting
            } silent.`,
    });
  } catch (error) {
    observations.push(
      failure(
        'telemetry.coverage_1h',
        'telemetry',
        'Telemetry coverage in the last hour',
        'telemetry, assets',
        error
      )
    );
  }
  return observations;
}

/**
 * Lake-derived baselines, with the live figure beside them.
 *
 * The baseline job (`python -m lakehouse.baselines`) computes these from Parquet
 * objects it verified against `lakehouse_runs`, so each carries the objects and
 * row count behind it. When no baseline exists the observation says so instead of
 * comparing today against an assumed normal.
 */
async function baselineObservations(): Promise<Observation[]> {
  try {
    const rows = await query<{
      dataset: string;
      metric: string;
      unit: string;
      value: string;
      sample_rows: string;
      source_objects: string[] | null;
      computed_at: string;
      window_start: string;
      window_end: string;
      age_seconds: string;
    }>(sql`
      SELECT DISTINCT ON (dataset, metric)
             dataset, metric, unit, value, sample_rows, source_objects,
             computed_at, window_start, window_end,
             EXTRACT(EPOCH FROM (now() - computed_at))::int AS age_seconds
        FROM lakehouse_baselines
       ORDER BY dataset, metric, computed_at DESC
    `);

    if (rows.length === 0) {
      return [
        {
          id: 'baseline.none',
          area: 'baseline',
          title: 'No lake-derived baselines exist',
          available: true,
          measures: { baselines: 0 },
          source: 'lakehouse_baselines',
          detail:
            'No baseline has been computed from the lake, so nothing here can be called normal or abnormal by history. Run `python -m lakehouse.baselines` after ingestion.',
        },
      ];
    }

    return rows.map<Observation>(row => ({
      id: `baseline.${row.dataset}.${row.metric}`,
      area: 'baseline',
      title: `Baseline ${row.metric} for ${row.dataset}`,
      available: true,
      measures: {
        value: Number(row.value),
        unit: row.unit,
        sampleRows: count(row.sample_rows),
        objects: (row.source_objects ?? []).length,
        windowStart: String(row.window_start),
        windowEnd: String(row.window_end),
        ageSeconds: count(row.age_seconds),
      },
      source: `lakehouse_baselines from ${(row.source_objects ?? []).length} verified lake object(s)`,
      detail: `${row.metric} for ${row.dataset} was ${Number(row.value)} ${row.unit}, computed from ${count(
        row.sample_rows
      )} row(s) in ${(row.source_objects ?? []).length} stored object(s) covering ${String(
        row.window_start
      )} to ${String(row.window_end)}.`,
    }));
  } catch (error) {
    return [
      failure('baseline.none', 'baseline', 'Lake-derived baselines', 'lakehouse_baselines', error),
    ];
  }
}

export async function collectEvidence(): Promise<EvidenceBundle> {
  const groups = await Promise.all([
    lakehouseObservations(),
    eventObservations(),
    ledgerObservations(),
    paymentObservations(),
    controlObservations(),
    telemetryObservations(),
    baselineObservations(),
  ]);
  const observations = groups.flat();
  const availableCount = observations.filter(observation => observation.available).length;
  const unavailableCount = observations.length - availableCount;

  return {
    collectedAt: new Date().toISOString(),
    observations,
    availableCount,
    unavailableCount,
    detail:
      unavailableCount === 0
        ? `${availableCount} observation(s), all read successfully.`
        : `${availableCount} observation(s) read; ${unavailableCount} could not be read and are unknown rather than healthy.`,
  };
}
