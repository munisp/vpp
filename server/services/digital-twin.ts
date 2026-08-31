/**
 * Assembles the digital twin from what the database actually holds.
 *
 * Two rules shape this module. First, the twin is built only from persisted
 * rows: assets, their registered devices, and the newest telemetry row each
 * asset wrote. Nothing is polled here and nothing is synthesised, so a component
 * the platform has never heard from arrives with an empty observation rather than
 * a plausible one.
 *
 * Second, a read failure is raised. A twin rendered from an empty result set is
 * indistinguishable from a plant that is switched off, and that is precisely the
 * mistake that must never reach a control room.
 */

import { sql } from 'drizzle-orm';

import { getDb } from '../db';
import type { SqlRow } from '../sql-row';
import {
  buildTwinGraph,
  evidenceOf,
  stalenessBoundFor,
  twinAssetRecordSchema,
  type EvidenceState,
  type TwinAssetRecord,
  type TwinDeviceRecord,
  type TwinGraph,
} from '../../shared/digital-twin';

export class DigitalTwinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DigitalTwinError';
  }
}

/** Scaling used by `drizzle/schema.ts` for the columns the twin reads. */
const SOC_SCALE = 100; // percentage x100
const MILLI = 1000; // millivolts, milliamps, millihertz
const TEMPERATURE_SCALE = 100; // celsius x100

/** How old a reading may be before the twin calls it stale, absent a device interval. */
const DEFAULT_STALENESS_SECONDS = Number(process.env.DIGITAL_TWIN_STALENESS_SECONDS ?? 300);

export interface TwinScope {
  /** One participant's equipment. Omit for the whole fleet (operators only). */
  userId?: number;
}

function unscale(value: unknown, scale: number): number | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric / scale : null;
}

function integerOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function dateOrNull(value: unknown): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The newest telemetry row per asset, joined to the asset.
 *
 * `DISTINCT ON` picks the latest row per asset in one pass; a LEFT JOIN keeps
 * assets that have never reported in the result, which is the whole point — they
 * are the ones an operator most needs to see.
 */
export async function loadTwinAssets(scope: TwinScope): Promise<TwinAssetRecord[]> {
  const db = await getDb();
  if (!db) {
    throw new DigitalTwinError(
      'The database is unavailable, so no twin can be built. This is an outage, not an empty plant.'
    );
  }

  const scopeFilter = scope.userId === undefined ? sql`TRUE` : sql`a."userId" = ${scope.userId}`;

  const assetRows = await db.execute<SqlRow>(sql`
    SELECT
      a.id,
      a."userId" AS user_id,
      a.name,
      a."assetType" AS asset_type,
      a.capacity,
      a.status,
      a."approvalStatus" AS approval_status,
      a.metadata,
      t.timestamp AS observed_at,
      t.power,
      t.energy,
      t.voltage,
      t.current,
      t.frequency,
      t."stateOfCharge" AS state_of_charge,
      t.temperature
    FROM assets a
    LEFT JOIN LATERAL (
      SELECT timestamp, power, energy, voltage, current, frequency, "stateOfCharge", temperature
      FROM telemetry
      WHERE "assetId" = a.id
      ORDER BY timestamp DESC
      LIMIT 1
    ) t ON TRUE
    -- Inactive, faulted and under-maintenance assets stay in the twin: equipment
    -- that exists but is not running is exactly what an operator needs drawn.
    WHERE ${scopeFilter}
    ORDER BY a.id
  `);

  const assets = assetRows.rows ?? [];
  if (assets.length === 0) return [];

  const assetIds = assets.map(row => Number(row.id));
  const deviceRows = await db.execute<SqlRow>(sql`
    SELECT
      d.id,
      d."assetId" AS asset_id,
      d."deviceId" AS device_id,
      d."deviceType" AS device_type,
      d.manufacturer,
      d.model,
      d."firmwareVersion" AS firmware_version,
      d.status,
      d."lastSeen" AS last_seen,
      d.enabled,
      d."telemetryInterval" AS telemetry_interval
    FROM devices d
    WHERE d."assetId" IN (${sql.join(
      assetIds.map(id => sql`${id}`),
      sql`, `
    )})
    ORDER BY d.id
  `);

  const devicesByAsset = new Map<number, TwinDeviceRecord[]>();
  for (const row of deviceRows.rows ?? []) {
    const assetId = Number(row.asset_id);
    const list = devicesByAsset.get(assetId) ?? [];
    list.push({
      id: Number(row.id),
      deviceId: String(row.device_id),
      deviceType: String(row.device_type),
      manufacturer: row.manufacturer === null ? null : String(row.manufacturer),
      model: row.model === null ? null : String(row.model),
      firmwareVersion: row.firmware_version === null ? null : String(row.firmware_version),
      status: String(row.status),
      lastSeen: dateOrNull(row.last_seen),
      enabled: Boolean(row.enabled),
      telemetryIntervalSeconds: Number(row.telemetry_interval),
    });
    devicesByAsset.set(assetId, list);
  }

  return assets.map(row => {
    const id = Number(row.id);
    const candidate = {
      id,
      userId: Number(row.user_id),
      name: String(row.name),
      assetType: String(row.asset_type),
      capacity: Number(row.capacity),
      status: String(row.status),
      approvalStatus: row.approval_status == null ? undefined : String(row.approval_status),
      metadata: row.metadata == null ? null : String(row.metadata),
      observation: {
        observedAt: dateOrNull(row.observed_at),
        powerWatts: integerOrNull(row.power),
        energyWh: integerOrNull(row.energy),
        stateOfChargePercent: unscale(row.state_of_charge, SOC_SCALE),
        voltageVolts: unscale(row.voltage, MILLI),
        frequencyHz: unscale(row.frequency, MILLI),
        temperatureCelsius: unscale(row.temperature, TEMPERATURE_SCALE),
        // One row is one sample; the twin shows the latest reading, not a window.
        samples: row.observed_at ? 1 : 0,
      },
      devices: devicesByAsset.get(id) ?? [],
    };

    // A registry row that cannot be true (SoC over 100%, zero capacity, a
    // device reporting every zero seconds) is an operations incident. It is
    // raised with the asset and the field, never skipped: skipping would draw
    // the plant smaller than it is and leave the corruption invisible.
    const parsed = twinAssetRecordSchema.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue && issue.path.length > 0 ? issue.path.join('.') : 'unknown';
      throw new DigitalTwinError(
        `asset ${id} holds a registry row that cannot be true: ${field} (${issue?.message ?? 'invalid'})`
      );
    }
    return parsed.data;
  });
}

export async function getDigitalTwin(scope: TwinScope, siteLabel: string): Promise<TwinGraph> {
  const assets = await loadTwinAssets(scope);
  return buildTwinGraph({
    siteLabel,
    assets,
    generatedAt: new Date(),
    stalenessSeconds: DEFAULT_STALENESS_SECONDS,
  });
}

export interface TwinAssetEvidence {
  evidence: EvidenceState;
  ageSeconds: number | null;
}

/**
 * Per-asset freshness for the control plane, keyed by `assets.id`.
 *
 * Returns `null` when the database is unavailable — and `null` means "the twin
 * cannot say", never "all clear". Callers deciding whether to command an asset
 * must treat null as twin-unavailable, not as fresh evidence. A corrupt
 * registry row still throws: that is an ops incident, not unavailability.
 */
export async function getTwinEvidence(
  scope: TwinScope
): Promise<Map<number, TwinAssetEvidence> | null> {
  const db = await getDb();
  if (!db) return null;

  const assets = await loadTwinAssets(scope);
  const now = new Date();
  const map = new Map<number, TwinAssetEvidence>();
  for (const asset of assets) {
    const bound = stalenessBoundFor(asset, DEFAULT_STALENESS_SECONDS);
    map.set(asset.id, evidenceOf(asset.observation.observedAt, bound, now));
  }
  return map;
}
