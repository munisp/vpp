/**
 * The critical-load register and the queries that feed a resilience assessment.
 *
 * A community's critical loads are declared by an operator who surveyed the
 * site; nothing here infers them. The loaders below read only registered values
 * (`assets.capacity` for battery energy, `der_capabilities` for the usable floor
 * and the discharge limit) and telemetry inside the staleness bound, so a stale
 * or absent reading arrives at the assessment as `null` rather than as a number.
 */

import { sql } from 'drizzle-orm';
import { getDb } from '../db';
import type { SqlRow } from '../sql-row';
import {
  RESILIENCE_TELEMETRY_STALENESS_MINUTES,
  type CriticalLoadState,
  type StorageAssetState,
} from './microgrid-resilience';

export class CriticalLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CriticalLoadError';
  }
}

export const CRITICAL_LOAD_CATEGORIES = [
  'health',
  'water',
  'education',
  'communications',
  'security',
  'cold_chain',
  'agriculture',
  'residential',
  'commercial',
  'other',
] as const;

export const CRITICAL_LOAD_RATING_SOURCES = [
  'nameplate',
  'commissioning_measurement',
  'operator_estimate',
] as const;

export type CriticalLoadCategory = (typeof CRITICAL_LOAD_CATEGORIES)[number];
export type CriticalLoadRatingSource = (typeof CRITICAL_LOAD_RATING_SOURCES)[number];

export interface CriticalLoad {
  id: number;
  communityId: number;
  assetId: number | null;
  label: string;
  category: CriticalLoadCategory;
  priority: number;
  ratedPowerW: number;
  ratingSource: CriticalLoadRatingSource;
  autonomyTargetHours: number | null;
  active: boolean;
  declaredBy: number;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new CriticalLoadError('Database not available');
  return db;
}

function toCriticalLoad(row: SqlRow): CriticalLoad {
  return {
    id: Number(row.id),
    communityId: Number(row.community_id),
    assetId: row.asset_id === null || row.asset_id === undefined ? null : Number(row.asset_id),
    label: String(row.label),
    category: String(row.category) as CriticalLoadCategory,
    priority: Number(row.priority),
    ratedPowerW: Number(row.rated_power_w),
    ratingSource: String(row.rating_source) as CriticalLoadRatingSource,
    autonomyTargetHours:
      row.autonomy_target_hours === null || row.autonomy_target_hours === undefined
        ? null
        : Number(row.autonomy_target_hours),
    active: row.active === true || row.active === 't',
    declaredBy: Number(row.declared_by),
    notes: row.notes === null || row.notes === undefined ? null : String(row.notes),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

export interface DeclareCriticalLoadInput {
  communityId: number;
  label: string;
  category: CriticalLoadCategory;
  ratedPowerW: number;
  ratingSource: CriticalLoadRatingSource;
  priority?: number;
  assetId?: number | null;
  autonomyTargetHours?: number | null;
  notes?: string | null;
}

/**
 * Declare a critical load. The rated power must be a positive figure the
 * declarer stands behind: a load registered at zero watts would silently
 * disappear from the coverage sum.
 */
export async function declareCriticalLoad(
  input: DeclareCriticalLoadInput,
  declaredBy: number
): Promise<CriticalLoad> {
  if (input.ratedPowerW <= 0) {
    throw new CriticalLoadError('A critical load needs a rated power greater than zero watts');
  }
  if (input.autonomyTargetHours !== null && input.autonomyTargetHours !== undefined && input.autonomyTargetHours <= 0) {
    throw new CriticalLoadError('An autonomy target must be greater than zero hours');
  }
  const db = await requireDb();

  const community = await db.execute<SqlRow>(sql`
    SELECT id FROM energy_communities WHERE id = ${input.communityId} LIMIT 1
  `);
  if ((community.rows ?? []).length === 0) {
    throw new CriticalLoadError(`Community ${input.communityId} does not exist`);
  }

  if (input.assetId !== null && input.assetId !== undefined) {
    const asset = await db.execute<SqlRow>(sql`
      SELECT id FROM assets WHERE id = ${input.assetId} LIMIT 1
    `);
    if ((asset.rows ?? []).length === 0) {
      throw new CriticalLoadError(`Asset ${input.assetId} does not exist`);
    }
  }

  const result = await db.execute<SqlRow>(sql`
    INSERT INTO critical_loads (
      community_id, asset_id, label, category, priority,
      rated_power_w, rating_source, autonomy_target_hours, active, declared_by, notes
    ) VALUES (
      ${input.communityId}, ${input.assetId ?? null}, ${input.label}, ${input.category},
      ${input.priority ?? 1}, ${input.ratedPowerW}, ${input.ratingSource},
      ${input.autonomyTargetHours ?? null}, true, ${declaredBy}, ${input.notes ?? null}
    )
    ON CONFLICT (community_id, label) DO NOTHING
    RETURNING *
  `);
  const row = (result.rows ?? [])[0];
  if (!row) {
    throw new CriticalLoadError(
      `Community ${input.communityId} already has a critical load labelled "${input.label}"`
    );
  }
  return toCriticalLoad(row);
}

export async function listCriticalLoads(
  communityId: number,
  options: { includeInactive?: boolean } = {}
): Promise<CriticalLoad[]> {
  const db = await requireDb();
  const result = await db.execute<SqlRow>(sql`
    SELECT * FROM critical_loads
    WHERE community_id = ${communityId}
      ${options.includeInactive ? sql`` : sql`AND active = true`}
    ORDER BY priority ASC, rated_power_w DESC, id ASC
  `);
  return (result.rows ?? []).map(toCriticalLoad);
}

export interface UpdateCriticalLoadInput {
  priority?: number;
  ratedPowerW?: number;
  ratingSource?: CriticalLoadRatingSource;
  autonomyTargetHours?: number | null;
  assetId?: number | null;
  active?: boolean;
  notes?: string | null;
}

export async function updateCriticalLoad(
  id: number,
  patch: UpdateCriticalLoadInput
): Promise<CriticalLoad> {
  if (patch.ratedPowerW !== undefined && patch.ratedPowerW <= 0) {
    throw new CriticalLoadError('A critical load needs a rated power greater than zero watts');
  }
  const db = await requireDb();
  const result = await db.execute<SqlRow>(sql`
    UPDATE critical_loads SET
      priority = COALESCE(${patch.priority ?? null}, priority),
      rated_power_w = COALESCE(${patch.ratedPowerW ?? null}, rated_power_w),
      rating_source = COALESCE(${patch.ratingSource ?? null}, rating_source),
      autonomy_target_hours = ${patch.autonomyTargetHours === undefined
        ? sql`autonomy_target_hours`
        : sql`${patch.autonomyTargetHours}`},
      asset_id = ${patch.assetId === undefined ? sql`asset_id` : sql`${patch.assetId}`},
      active = COALESCE(${patch.active ?? null}, active),
      notes = ${patch.notes === undefined ? sql`notes` : sql`${patch.notes}`},
      updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `);
  const row = (result.rows ?? [])[0];
  if (!row) throw new CriticalLoadError(`Critical load ${id} does not exist`);
  return toCriticalLoad(row);
}

/**
 * The batteries registered to a community's active members, with the last state
 * of charge inside the staleness bound and the registered limits that decide how
 * much of that energy is usable.
 */
export async function loadCommunityStorage(communityId: number): Promise<StorageAssetState[]> {
  const db = await requireDb();
  const result = await db.execute<SqlRow>(sql`
    SELECT
      a.id,
      a.name,
      a.capacity AS energy_capacity_wh,
      dc.min_soc,
      dc.max_power_export,
      recent."stateOfCharge" AS state_of_charge,
      recent.timestamp AS observed_at
    FROM assets a
    JOIN community_members cm ON cm.user_id = a."userId"
    LEFT JOIN der_capabilities dc ON dc.asset_id = a.id
    LEFT JOIN LATERAL (
      SELECT t."stateOfCharge", t.timestamp
      FROM telemetry t
      WHERE t."assetId" = a.id
        AND t."stateOfCharge" IS NOT NULL
        AND t.timestamp > NOW() - (${RESILIENCE_TELEMETRY_STALENESS_MINUTES}::text || ' minutes')::interval
      ORDER BY t.timestamp DESC
      LIMIT 1
    ) recent ON true
    WHERE cm.community_id = ${communityId}
      AND cm.status = 'active'
      AND a.status = 'active'
      AND a."assetType" = 'battery'
    ORDER BY a.id ASC
  `);

  return (result.rows ?? []).map((row) => ({
    assetId: Number(row.id),
    name: String(row.name),
    energyCapacityWh:
      row.energy_capacity_wh === null || row.energy_capacity_wh === undefined
        ? null
        : Number(row.energy_capacity_wh),
    stateOfChargeRaw:
      row.state_of_charge === null || row.state_of_charge === undefined
        ? null
        : Number(row.state_of_charge),
    minStateOfChargeRaw:
      row.min_soc === null || row.min_soc === undefined ? null : Number(row.min_soc),
    maxDischargePowerW:
      row.max_power_export === null || row.max_power_export === undefined
        ? null
        : Number(row.max_power_export),
    observedAt: row.observed_at ? new Date(String(row.observed_at)) : null,
  }));
}

/**
 * The active critical-load register with the metered draw of each load that has
 * a metering asset reporting inside the staleness bound.
 */
export async function loadCriticalLoadStates(communityId: number): Promise<CriticalLoadState[]> {
  const db = await requireDb();
  const result = await db.execute<SqlRow>(sql`
    SELECT
      cl.id,
      cl.label,
      cl.category,
      cl.priority,
      cl.rated_power_w,
      cl.rating_source,
      cl.autonomy_target_hours,
      cl.asset_id,
      recent.power AS measured_power_w,
      recent.timestamp AS measured_at
    FROM critical_loads cl
    LEFT JOIN LATERAL (
      SELECT t.power, t.timestamp
      FROM telemetry t
      WHERE cl.asset_id IS NOT NULL
        AND t."assetId" = cl.asset_id
        AND t.power IS NOT NULL
        AND t.timestamp > NOW() - (${RESILIENCE_TELEMETRY_STALENESS_MINUTES}::text || ' minutes')::interval
      ORDER BY t.timestamp DESC
      LIMIT 1
    ) recent ON true
    WHERE cl.community_id = ${communityId} AND cl.active = true
    ORDER BY cl.priority ASC, cl.id ASC
  `);

  return (result.rows ?? []).map((row) => ({
    id: Number(row.id),
    label: String(row.label),
    category: String(row.category),
    priority: Number(row.priority),
    ratedPowerW: Number(row.rated_power_w),
    ratingSource: String(row.rating_source),
    autonomyTargetHours:
      row.autonomy_target_hours === null || row.autonomy_target_hours === undefined
        ? null
        : Number(row.autonomy_target_hours),
    assetId: row.asset_id === null || row.asset_id === undefined ? null : Number(row.asset_id),
    // A load's own draw is a magnitude: consumption is stored as negative power
    // on some paths and positive on others, and either way it is demand.
    measuredPowerW:
      row.measured_power_w === null || row.measured_power_w === undefined
        ? null
        : Math.abs(Number(row.measured_power_w)),
    measuredAt: row.measured_at ? new Date(String(row.measured_at)) : null,
  }));
}
