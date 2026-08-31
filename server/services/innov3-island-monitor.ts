/**
 * Island-mode monitor (innovation 18)
 *
 * Answers, for one user: "if the grid drops right now, how long does what I
 * have registered keep me running?" The answer is computed by the shared,
 * previously-established `assessResilience` logic (server/services/
 * microgrid-resilience.ts) from:
 *
 *   - usable stored energy: each registered battery's assets.capacity (Wh),
 *     its last measured state of charge inside the staleness bound, and its
 *     registered usable floor (der_capabilities.min_soc) — never an assumed
 *     battery size or an assumed reserve;
 *   - the drain: measured demand minus measured generation across the
 *     user's assets, using the platform's sign conventions (meter positive
 *     = import, battery positive = discharging).
 *
 * When storage or consumption cannot be established, the assessment is
 * persisted with `assessmentAvailable: false` and the reason — no figure
 * is reported.
 *
 * Island EVENTS are not detected: the platform has no per-site grid-status
 * telemetry field (grid_monitoring.grid_status is system-level and marks
 * stress, not a local outage). Every row records that honestly in
 * `eventDetection` / `eventDetectionReason` rather than inferring outages
 * from missing readings.
 */

import { desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../db';
import {
  assessResilience,
  RESILIENCE_TELEMETRY_STALENESS_MINUTES,
  type ResilienceAssessment,
  type StorageAssetState,
} from './microgrid-resilience';
import { islandAssessments, type IslandAssessmentRow } from '../../drizzle/innov3-control-schema';
import type { SqlRow } from '../sql-row';

/** Why event detection is unavailable — recorded verbatim on every row. */
export const EVENT_DETECTION_UNAVAILABLE = 'unavailable';
export const EVENT_DETECTION_REASON =
  'The platform has no per-site grid-status telemetry field (grid_monitoring.grid_status is system-level stress, not a local outage), so island events cannot be detected for a single user; this monitor records autonomy assessments only.';

/** The batteries registered to one user, with last measured SoC inside the
 * staleness bound and the registered limits that decide usable energy.
 * Mirrors loadCommunityStorage (server/services/critical-loads.ts), scoped
 * to a user instead of a community. */
async function loadUserStorage(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  userId: number
): Promise<StorageAssetState[]> {
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
    WHERE a."userId" = ${userId}
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
 * Measured generation and demand across the user's assets from the latest
 * reading of each inside the staleness bound. Same conventions as the
 * community monitor: meter positive = import, battery positive =
 * discharging; demand = generation + battery net + grid import, floored at
 * zero. Null when nothing reported recently — silence is not zero.
 */
async function loadUserBalance(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  userId: number
): Promise<{ totalGenerationKw: number | null; totalLoadKw: number | null }> {
  const result = await db.execute<SqlRow>(sql`
    SELECT DISTINCT ON (a.id)
      a.id AS asset_id,
      a."assetType" AS asset_type,
      t.power
    FROM assets a
    JOIN telemetry t ON t."assetId" = a.id
    WHERE a."userId" = ${userId}
      AND a.status = 'active'
      AND t.timestamp > NOW() - (${RESILIENCE_TELEMETRY_STALENESS_MINUTES}::text || ' minutes')::interval
    ORDER BY a.id, t.timestamp DESC
  `);
  const readings = result.rows ?? [];
  if (readings.length === 0) return { totalGenerationKw: null, totalLoadKw: null };

  let nonStorageGenerationKw = 0;
  let batteryNetKw = 0;
  let gridNetImportKw = 0;
  for (const row of readings) {
    const powerKw = row.power == null ? null : Number(row.power) / 1000;
    const assetType = String(row.asset_type);
    if (assetType === 'battery') {
      if (powerKw !== null) batteryNetKw += powerKw;
    } else if (assetType === 'meter') {
      if (powerKw !== null) gridNetImportKw += powerKw;
    } else if (powerKw !== null) {
      nonStorageGenerationKw += Math.max(0, powerKw);
    }
  }

  return {
    totalGenerationKw: Math.round(nonStorageGenerationKw * 100) / 100,
    totalLoadKw:
      Math.round(Math.max(0, nonStorageGenerationKw + batteryNetKw + gridNetImportKw) * 100) / 100,
  };
}

/**
 * Critical-load coverage is registered per community (critical_loads), not
 * per user; that limitation is reworded rather than dropped.
 */
const COMMUNITY_CRITICAL_LOADS_LIMITATION = 'No critical load has been declared for this community';
const USER_CRITICAL_LOADS_LIMITATION =
  'Critical-load coverage is registered per community, not per user; it is not part of this assessment';

export interface IslandAssessmentResult {
  row: IslandAssessmentRow;
  assessment: ResilienceAssessment;
}

/**
 * Assess and persist the user's island autonomy. The row is the record of
 * what the platform could honestly say at that moment — available or not.
 */
export async function assessUser(userId: number): Promise<IslandAssessmentResult> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const [storage, balance] = await Promise.all([loadUserStorage(db, userId), loadUserBalance(db, userId)]);

  const assessment = assessResilience({
    totalGenerationKw: balance.totalGenerationKw,
    totalLoadKw: balance.totalLoadKw,
    storage,
    criticalLoads: [],
  });

  const autonomy = assessment.autonomy;
  const available = autonomy.hours !== null;
  const limitations = assessment.limitations.map((l) =>
    l === COMMUNITY_CRITICAL_LOADS_LIMITATION ? USER_CRITICAL_LOADS_LIMITATION : l
  );

  const inserted = await db
    .insert(islandAssessments)
    .values({
      userId,
      assessedAt: new Date(),
      assessmentAvailable: available,
      unavailableReason: available ? null : autonomy.reason,
      autonomyHoursX100: available ? Math.round(autonomy.hours! * 100) : null,
      autonomyBasis: available ? autonomy.basis : null,
      netDrainWatts: autonomy.netDrainKw !== null ? Math.round(autonomy.netDrainKw * 1000) : null,
      usableEnergyWh: assessment.storage.usableEnergyWh,
      registeredBatteries: assessment.storage.registeredBatteries,
      assessedBatteries: assessment.storage.assessedBatteries,
      telemetryStalenessMinutes: RESILIENCE_TELEMETRY_STALENESS_MINUTES,
      limitations,
      eventDetection: EVENT_DETECTION_UNAVAILABLE,
      eventDetectionReason: EVENT_DETECTION_REASON,
    })
    .returning();

  return { row: inserted[0], assessment };
}

export async function getAssessment(userId: number, id: number): Promise<IslandAssessmentRow> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const rows = await db
    .select()
    .from(islandAssessments)
    .where(eq(islandAssessments.id, id))
    .limit(1);
  const row = rows[0];
  if (!row || row.userId !== userId) throw new Error(`Assessment ${id} not found`);
  return row;
}

export async function listAssessments(userId: number, limit: number): Promise<IslandAssessmentRow[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(islandAssessments)
    .where(eq(islandAssessments.userId, userId))
    .orderBy(desc(islandAssessments.assessedAt))
    .limit(limit);
}
