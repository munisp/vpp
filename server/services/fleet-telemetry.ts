/**
 * Rolling fleet telemetry aggregates with their coverage attached.
 *
 * An aggregate over a fleet where half the assets went silent looks exactly like
 * an aggregate over a smaller fleet, which is how a VPP ends up selling capacity
 * it cannot see. Every bucket computed here carries the count and the rated
 * capacity of the assets that reported nothing, so the caller can decide whether
 * the number is worth acting on. Nothing is interpolated, no asset stands in for
 * another, and a battery with no reported state of charge contributes no
 * available energy rather than an assumed half tank.
 *
 * Failures are raised, never smoothed into zeros: "no telemetry" and "the
 * database is down" are different facts and a grid operator must not see the
 * second one rendered as an empty fleet.
 */

import { and, asc, eq, gte, sql } from 'drizzle-orm';

import { getDb } from '../db';
import { fleetTelemetryWindows } from '../../drizzle/fleet-telemetry-schema';
import type { SqlRow } from '../sql-row';

export class FleetTelemetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FleetTelemetryError';
  }
}

export type FleetScopeType = 'fleet' | 'community' | 'region';

export interface FleetScope {
  scopeType: FleetScopeType;
  /** Community id, required when scopeType is `community`. */
  scopeId?: number;
  /** Region code, required when scopeType is `region`. */
  region?: string;
}

export interface FleetWindowAggregate {
  scopeKey: string;
  bucketStartsAt: Date;
  bucketMinutes: number;
  state: 'open' | 'closed';
  meanNetPowerWatts: number;
  integratedEnergyWh: number;
  expectedAssets: number;
  reportingAssets: number;
  silentAssets: number;
  samples: number;
  reportingCapacityWh: number;
  silentCapacityWh: number;
  socKnownAssets: number;
  socUnknownAssets: number;
  availableEnergyWh: number;
  computedAt: Date;
}

export interface RollingFleetTelemetry {
  scope: FleetScope;
  scopeKey: string;
  bucketMinutes: number;
  buckets: FleetWindowAggregate[];
  /** Buckets that were asked for but have never been computed. */
  missingBuckets: number;
}

/** SoC is stored as percentage x100 (drizzle/schema.ts). */
const SOC_SCALE = 10000;

export function scopeKeyOf(scope: FleetScope): string {
  switch (scope.scopeType) {
    case 'fleet':
      return 'fleet';
    case 'community':
      if (scope.scopeId === undefined) {
        throw new FleetTelemetryError('A community aggregate needs a community id');
      }
      return `community:${scope.scopeId}`;
    case 'region':
      if (!scope.region) {
        throw new FleetTelemetryError('A region aggregate needs a region code');
      }
      return `region:${scope.region}`;
  }
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new FleetTelemetryError('Database not available');
  return db;
}

/** Floor a timestamp onto the bucket grid, so every scope shares one grid. */
export function bucketStartFor(at: Date, bucketMinutes: number): Date {
  if (!Number.isInteger(bucketMinutes) || bucketMinutes <= 0) {
    throw new FleetTelemetryError('bucketMinutes must be a positive whole number of minutes');
  }
  const bucketMs = bucketMinutes * 60_000;
  return new Date(Math.floor(at.getTime() / bucketMs) * bucketMs);
}

/**
 * SQL restricting `assets` to the scope. Region and community membership are the
 * only locational facts the schema carries: assets have no region column, so a
 * regional aggregate is the assets of the active members of the communities in
 * that region, and an asset outside every community is fleet-only. A caller
 * asking for a region gets exactly that, never the whole fleet relabelled.
 */
function scopeFilter(scope: FleetScope) {
  if (scope.scopeType === 'fleet') {
    return sql`TRUE`;
  }
  if (scope.scopeType === 'community') {
    if (scope.scopeId === undefined) {
      throw new FleetTelemetryError('A community aggregate needs a community id');
    }
    return sql`a."userId" IN (
      SELECT cm.user_id FROM community_members cm
      WHERE cm.community_id = ${scope.scopeId} AND cm.status = 'active'
    )`;
  }
  if (!scope.region) {
    throw new FleetTelemetryError('A region aggregate needs a region code');
  }
  return sql`a."userId" IN (
    SELECT cm.user_id FROM community_members cm
    JOIN energy_communities ec ON ec.id = cm.community_id
    WHERE cm.status = 'active' AND ec.region = ${scope.region}
  )`;
}

/**
 * Compute one bucket from telemetry. Per-asset means are taken first so an asset
 * that samples every ten seconds does not outvote one that samples every five
 * minutes; the fleet figure is the sum of those means.
 */
export async function computeFleetWindow(
  scope: FleetScope,
  bucketStartsAt: Date,
  bucketMinutes: number,
  now?: Date
): Promise<FleetWindowAggregate> {
  const db = await requireDb();
  const scopeKey = scopeKeyOf(scope);
  const bucketStart = bucketStartFor(bucketStartsAt, bucketMinutes);
  const bucketEnd = new Date(bucketStart.getTime() + bucketMinutes * 60_000);
  const filter = scopeFilter(scope);

  const result = await db.execute<SqlRow>(sql`
    WITH scoped AS (
      SELECT a.id, a.capacity, a."assetType" AS asset_type
      FROM assets a
      WHERE a.status = 'active' AND ${filter}
    ),
    per_asset AS (
      SELECT
        s.id,
        s.capacity,
        s.asset_type,
        COUNT(t.id)::int AS samples,
        AVG(t.power)::float AS mean_power,
        (
          SELECT t2."stateOfCharge"
          FROM telemetry t2
          WHERE t2."assetId" = s.id
            AND t2.timestamp >= ${bucketStart}
            AND t2.timestamp < ${bucketEnd}
            AND t2."stateOfCharge" IS NOT NULL
          ORDER BY t2.timestamp DESC
          LIMIT 1
        ) AS last_soc
      FROM scoped s
      LEFT JOIN telemetry t
        ON t."assetId" = s.id
        AND t.timestamp >= ${bucketStart}
        AND t.timestamp < ${bucketEnd}
      GROUP BY s.id, s.capacity, s.asset_type
    )
    SELECT
      COUNT(*)::int AS expected_assets,
      COALESCE(SUM(CASE WHEN samples > 0 THEN 1 ELSE 0 END), 0)::int AS reporting_assets,
      COALESCE(SUM(CASE WHEN samples = 0 THEN 1 ELSE 0 END), 0)::int AS silent_assets,
      COALESCE(SUM(samples), 0)::int AS samples,
      COALESCE(SUM(CASE WHEN samples > 0 THEN mean_power ELSE 0 END), 0)::float AS mean_power,
      COALESCE(SUM(CASE WHEN samples > 0 THEN capacity ELSE 0 END), 0)::bigint AS reporting_capacity_wh,
      COALESCE(SUM(CASE WHEN samples = 0 THEN capacity ELSE 0 END), 0)::bigint AS silent_capacity_wh,
      COALESCE(SUM(CASE WHEN asset_type = 'battery' AND last_soc IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS soc_known_assets,
      COALESCE(SUM(CASE WHEN asset_type = 'battery' AND last_soc IS NULL THEN 1 ELSE 0 END), 0)::int AS soc_unknown_assets,
      COALESCE(SUM(CASE WHEN asset_type = 'battery' AND last_soc IS NOT NULL
        THEN capacity::float * last_soc::float / ${SOC_SCALE} ELSE 0 END), 0)::float AS available_energy_wh
    FROM per_asset
  `);

  const row = (result.rows ?? [])[0];
  if (!row) {
    throw new FleetTelemetryError('Aggregate query returned no row');
  }

  const meanNetPowerWatts = Math.round(Number(row.mean_power));
  return {
    scopeKey,
    bucketStartsAt: bucketStart,
    bucketMinutes,
    state: bucketEnd.getTime() <= (now ?? new Date()).getTime() ? 'closed' : 'open',
    meanNetPowerWatts,
    integratedEnergyWh: Math.round((meanNetPowerWatts * bucketMinutes) / 60),
    expectedAssets: Number(row.expected_assets),
    reportingAssets: Number(row.reporting_assets),
    silentAssets: Number(row.silent_assets),
    samples: Number(row.samples),
    reportingCapacityWh: Number(row.reporting_capacity_wh),
    silentCapacityWh: Number(row.silent_capacity_wh),
    socKnownAssets: Number(row.soc_known_assets),
    socUnknownAssets: Number(row.soc_unknown_assets),
    availableEnergyWh: Math.round(Number(row.available_energy_wh)),
    computedAt: new Date(),
  };
}

/**
 * Recompute and persist the most recent buckets for a scope.
 *
 * Open buckets are stored too, marked `open`, and are recomputed on the next
 * pass: a bucket whose window has not elapsed will still be changed by
 * late-arriving telemetry, and the state column says so rather than leaving the
 * reader to guess.
 */
export async function rollUpFleetWindows(
  scope: FleetScope,
  options: { bucketMinutes: number; buckets: number; now?: Date }
): Promise<FleetWindowAggregate[]> {
  const db = await requireDb();
  const { bucketMinutes } = options;
  if (options.buckets <= 0) {
    throw new FleetTelemetryError('buckets must be positive');
  }
  const now = options.now ?? new Date();
  const currentBucket = bucketStartFor(now, bucketMinutes);

  const written: FleetWindowAggregate[] = [];
  for (let index = options.buckets - 1; index >= 0; index -= 1) {
    const bucketStart = new Date(currentBucket.getTime() - index * bucketMinutes * 60_000);
    const aggregate = await computeFleetWindow(scope, bucketStart, bucketMinutes, now);
    await db
      .insert(fleetTelemetryWindows)
      .values({
        scopeType: scope.scopeType,
        scopeKey: aggregate.scopeKey,
        scopeId: scope.scopeId ?? null,
        region: scope.region ?? null,
        bucketStartsAt: aggregate.bucketStartsAt,
        bucketMinutes,
        state: aggregate.state,
        meanNetPowerWatts: aggregate.meanNetPowerWatts,
        integratedEnergyWh: aggregate.integratedEnergyWh,
        expectedAssets: aggregate.expectedAssets,
        reportingAssets: aggregate.reportingAssets,
        silentAssets: aggregate.silentAssets,
        samples: aggregate.samples,
        reportingCapacityWh: aggregate.reportingCapacityWh,
        silentCapacityWh: aggregate.silentCapacityWh,
        socKnownAssets: aggregate.socKnownAssets,
        socUnknownAssets: aggregate.socUnknownAssets,
        availableEnergyWh: aggregate.availableEnergyWh,
        computedAt: aggregate.computedAt,
      })
      .onConflictDoUpdate({
        target: [
          fleetTelemetryWindows.scopeKey,
          fleetTelemetryWindows.bucketStartsAt,
          fleetTelemetryWindows.bucketMinutes,
        ],
        set: {
          state: aggregate.state,
          meanNetPowerWatts: aggregate.meanNetPowerWatts,
          integratedEnergyWh: aggregate.integratedEnergyWh,
          expectedAssets: aggregate.expectedAssets,
          reportingAssets: aggregate.reportingAssets,
          silentAssets: aggregate.silentAssets,
          samples: aggregate.samples,
          reportingCapacityWh: aggregate.reportingCapacityWh,
          silentCapacityWh: aggregate.silentCapacityWh,
          socKnownAssets: aggregate.socKnownAssets,
          socUnknownAssets: aggregate.socUnknownAssets,
          availableEnergyWh: aggregate.availableEnergyWh,
          computedAt: aggregate.computedAt,
        },
      });
    written.push(aggregate);
  }
  return written;
}

/**
 * Read the persisted rolling series.
 *
 * Buckets that were never rolled up are reported as `missingBuckets` instead of
 * being back-filled on read: a gap in the aggregate history is an operational
 * fact about the rollup, and hiding it would make a stalled rollup look like a
 * quiet fleet.
 */
export async function getRollingFleetTelemetry(
  scope: FleetScope,
  options: { bucketMinutes: number; buckets: number; now?: Date }
): Promise<RollingFleetTelemetry> {
  const db = await requireDb();
  const { bucketMinutes, buckets } = options;
  if (buckets <= 0) {
    throw new FleetTelemetryError('buckets must be positive');
  }
  const scopeKey = scopeKeyOf(scope);
  const now = options.now ?? new Date();
  const currentBucket = bucketStartFor(now, bucketMinutes);
  const from = new Date(currentBucket.getTime() - (buckets - 1) * bucketMinutes * 60_000);

  const rows = await db
    .select()
    .from(fleetTelemetryWindows)
    .where(
      and(
        eq(fleetTelemetryWindows.scopeKey, scopeKey),
        eq(fleetTelemetryWindows.bucketMinutes, bucketMinutes),
        gte(fleetTelemetryWindows.bucketStartsAt, from)
      )
    )
    .orderBy(asc(fleetTelemetryWindows.bucketStartsAt));

  return {
    scope,
    scopeKey,
    bucketMinutes,
    buckets: rows.map(row => ({
      scopeKey: row.scopeKey,
      bucketStartsAt: row.bucketStartsAt,
      bucketMinutes: row.bucketMinutes,
      state: row.state,
      meanNetPowerWatts: row.meanNetPowerWatts,
      integratedEnergyWh: row.integratedEnergyWh,
      expectedAssets: row.expectedAssets,
      reportingAssets: row.reportingAssets,
      silentAssets: row.silentAssets,
      samples: row.samples,
      reportingCapacityWh: row.reportingCapacityWh,
      silentCapacityWh: row.silentCapacityWh,
      socKnownAssets: row.socKnownAssets,
      socUnknownAssets: row.socUnknownAssets,
      availableEnergyWh: row.availableEnergyWh,
      computedAt: row.computedAt,
    })),
    missingBuckets: Math.max(0, buckets - rows.length),
  };
}

let rollupTimer: NodeJS.Timeout | null = null;

/**
 * Start the periodic rollup. Opt-in via FLEET_TELEMETRY_ROLLUP_MS so a
 * deployment running the rollup from a worker does not run it twice; without it
 * the aggregate series only advances when an operator asks for it.
 */
export function startFleetTelemetryRollup(): boolean {
  const raw = process.env.FLEET_TELEMETRY_ROLLUP_MS;
  if (!raw) return false;
  const intervalMs = Number(raw);
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    throw new FleetTelemetryError('FLEET_TELEMETRY_ROLLUP_MS must be at least 1000 milliseconds');
  }
  const bucketMinutes = Number(process.env.FLEET_TELEMETRY_BUCKET_MINUTES ?? 15);
  if (!Number.isInteger(bucketMinutes) || bucketMinutes <= 0) {
    throw new FleetTelemetryError('FLEET_TELEMETRY_BUCKET_MINUTES must be a positive integer');
  }
  if (rollupTimer) return true;
  rollupTimer = setInterval(() => {
    void rollUpFleetWindows({ scopeType: 'fleet' }, { bucketMinutes, buckets: 2 }).then(
      written => {
        const latest = written[written.length - 1];
        if (latest && latest.silentAssets > 0) {
          console.warn(
            `[FleetTelemetry] ${latest.silentAssets} of ${latest.expectedAssets} assets silent ` +
              `in bucket ${latest.bucketStartsAt.toISOString()} (${latest.silentCapacityWh} Wh rated unseen)`
          );
        }
      },
      error => console.error('[FleetTelemetry] rollup failed:', error)
    );
  }, intervalMs);
  return true;
}

export function stopFleetTelemetryRollup(): void {
  if (rollupTimer) {
    clearInterval(rollupTimer);
    rollupTimer = null;
  }
}
