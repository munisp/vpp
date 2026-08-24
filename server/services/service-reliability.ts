/**
 * The customer-connection register, the interruption log and the queries that
 * feed a reliability report.
 *
 * Everything here is recorded evidence: a connection exists because somebody
 * registered it, an interruption exists because a meter event, a telemetry gap,
 * an operator or a customer said so, and every row carries the reference behind
 * the claim. Nothing infers supply from platform health, and nothing treats an
 * unmonitored connection's silence as good news.
 *
 * Gap detection is deliberately conservative. It only considers connections that
 * declared a reporting interval, only opens an interruption after the meter has
 * missed several intervals, and records the last reading and the first reading
 * after the gap as its evidence — so an operator reading the report can see that
 * the outage is inferred from silence rather than measured at the meter.
 */

import { sql } from 'drizzle-orm';
import { getDb } from '../db';
import type { SqlRow } from '../sql-row';
import {
  assessReliability,
  type InterruptionRecord,
  type ReliabilityAssessment,
  type ServicePointExposure,
} from './reliability-metrics';

export class ServiceReliabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceReliabilityError';
  }
}

export const SERVICE_POINT_CLASSES = [
  'residential',
  'commercial',
  'industrial',
  'institutional',
  'public_service',
] as const;

export const SERVICE_POINT_MONITORING = ['metered_telemetry', 'reported_only', 'unmonitored'] as const;

export const INTERRUPTION_CAUSES = [
  'utility_grid_outage',
  'generation_shortfall',
  'storage_depleted',
  'equipment_fault',
  'planned_maintenance',
  'load_shedding',
  'payment_disconnection',
  'unknown',
] as const;

export const INTERRUPTION_DETECTION_SOURCES = [
  'meter_event',
  'telemetry_gap',
  'device_offline_event',
  'operator_declared',
  'customer_reported',
] as const;

export type ServicePointClass = (typeof SERVICE_POINT_CLASSES)[number];
export type ServicePointMonitoring = (typeof SERVICE_POINT_MONITORING)[number];
export type InterruptionCause = (typeof INTERRUPTION_CAUSES)[number];
export type InterruptionDetectionSource = (typeof INTERRUPTION_DETECTION_SOURCES)[number];

/**
 * Missed reporting intervals before silence is treated as an interruption. One
 * late reading is a late reading; a meter on a five-minute interval that has
 * said nothing for half an hour is either off or unreachable, and the record
 * says which evidence it rests on.
 */
export const GAP_INTERVALS_BEFORE_INTERRUPTION = 6;

export interface ServicePoint {
  id: number;
  userId: number;
  communityId: number | null;
  code: string;
  pointClass: ServicePointClass;
  monitoring: ServicePointMonitoring;
  meterAssetId: number | null;
  expectedReportIntervalSeconds: number | null;
  connectedAt: Date;
  disconnectedAt: Date | null;
  registeredBy: number;
  notes: string | null;
}

export interface ServiceInterruption {
  id: number;
  servicePointId: number;
  startedAt: Date;
  endedAt: Date | null;
  cause: InterruptionCause;
  detectionSource: InterruptionDetectionSource;
  evidenceRef: string;
  restoredEvidenceRef: string | null;
  excludeFromIndices: boolean;
  exclusionReason: string | null;
  recordedBy: number | null;
  notes: string | null;
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new ServiceReliabilityError('Database not available');
  return db;
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toServicePoint(row: SqlRow): ServicePoint {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    communityId: nullableNumber(row.community_id),
    code: String(row.code),
    pointClass: String(row.point_class) as ServicePointClass,
    monitoring: String(row.monitoring) as ServicePointMonitoring,
    meterAssetId: nullableNumber(row.meter_asset_id),
    expectedReportIntervalSeconds: nullableNumber(row.expected_report_interval_seconds),
    connectedAt: new Date(String(row.connected_at)),
    disconnectedAt: row.disconnected_at ? new Date(String(row.disconnected_at)) : null,
    registeredBy: Number(row.registered_by),
    notes: nullableString(row.notes),
  };
}

function toInterruption(row: SqlRow): ServiceInterruption {
  return {
    id: Number(row.id),
    servicePointId: Number(row.service_point_id),
    startedAt: new Date(String(row.started_at)),
    endedAt: row.ended_at ? new Date(String(row.ended_at)) : null,
    cause: String(row.cause) as InterruptionCause,
    detectionSource: String(row.detection_source) as InterruptionDetectionSource,
    evidenceRef: String(row.evidence_ref),
    restoredEvidenceRef: nullableString(row.restored_evidence_ref),
    excludeFromIndices: row.exclude_from_indices === true || row.exclude_from_indices === 't',
    exclusionReason: nullableString(row.exclusion_reason),
    recordedBy: nullableNumber(row.recorded_by),
    notes: nullableString(row.notes),
  };
}

export interface RegisterServicePointInput {
  userId: number;
  communityId?: number | null;
  code: string;
  pointClass: ServicePointClass;
  monitoring: ServicePointMonitoring;
  meterAssetId?: number | null;
  expectedReportIntervalSeconds?: number | null;
  connectedAt: Date;
  notes?: string | null;
}

/**
 * Register a customer connection. A connection claiming metered monitoring must
 * name the meter and its reporting interval: without both, a gap in reporting
 * cannot be distinguished from a meter that simply reports rarely, and the
 * connection would silently contribute a perfect record to every index.
 */
export async function registerServicePoint(
  input: RegisterServicePointInput,
  registeredBy: number
): Promise<ServicePoint> {
  const code = input.code.trim();
  if (code.length === 0) {
    throw new ServiceReliabilityError('A service point needs a connection code');
  }
  if (input.monitoring === 'metered_telemetry') {
    if (!input.meterAssetId) {
      throw new ServiceReliabilityError(
        'A metered connection must name the meter asset whose reports stand for its supply'
      );
    }
    if (!input.expectedReportIntervalSeconds || input.expectedReportIntervalSeconds <= 0) {
      throw new ServiceReliabilityError(
        'A metered connection must declare the interval its meter reports on, or a gap cannot be told from a slow meter'
      );
    }
  }

  const db = await requireDb();
  const user = await db.execute<SqlRow>(sql`SELECT id FROM users WHERE id = ${input.userId} LIMIT 1`);
  if ((user.rows ?? []).length === 0) {
    throw new ServiceReliabilityError(`User ${input.userId} does not exist`);
  }
  if (input.meterAssetId) {
    const asset = await db.execute<SqlRow>(sql`
      SELECT id FROM assets WHERE id = ${input.meterAssetId} LIMIT 1
    `);
    if ((asset.rows ?? []).length === 0) {
      throw new ServiceReliabilityError(`Asset ${input.meterAssetId} does not exist`);
    }
  }
  if (input.communityId !== null && input.communityId !== undefined) {
    const community = await db.execute<SqlRow>(sql`
      SELECT id FROM energy_communities WHERE id = ${input.communityId} LIMIT 1
    `);
    if ((community.rows ?? []).length === 0) {
      throw new ServiceReliabilityError(`Community ${input.communityId} does not exist`);
    }
  }

  const result = await db.execute<SqlRow>(sql`
    INSERT INTO service_points (
      user_id, community_id, code, point_class, monitoring, meter_asset_id,
      expected_report_interval_seconds, connected_at, registered_by, notes
    ) VALUES (
      ${input.userId}, ${input.communityId ?? null}, ${code}, ${input.pointClass},
      ${input.monitoring}, ${input.meterAssetId ?? null},
      ${input.expectedReportIntervalSeconds ?? null}, ${input.connectedAt},
      ${registeredBy}, ${input.notes ?? null}
    )
    ON CONFLICT (code) DO NOTHING
    RETURNING *
  `);
  const row = (result.rows ?? [])[0];
  if (!row) {
    throw new ServiceReliabilityError(`A service point with code "${code}" is already registered`);
  }
  return toServicePoint(row);
}

export async function listServicePoints(
  filter: { communityId?: number; userId?: number } = {}
): Promise<ServicePoint[]> {
  const db = await requireDb();
  const result = await db.execute<SqlRow>(sql`
    SELECT * FROM service_points
    WHERE 1 = 1
      ${filter.communityId === undefined ? sql`` : sql`AND community_id = ${filter.communityId}`}
      ${filter.userId === undefined ? sql`` : sql`AND user_id = ${filter.userId}`}
    ORDER BY code ASC
  `);
  return (result.rows ?? []).map(toServicePoint);
}

/**
 * Change how a connection's supply is watched.
 *
 * Exposure follows monitoring, so this moves a customer in or out of the
 * denominator from the moment it is recorded. Claiming metered monitoring still
 * requires the meter and the interval, for the same reason registration does.
 */
export async function setServicePointMonitoring(
  id: number,
  monitoring: ServicePointMonitoring,
  meter: { meterAssetId?: number | null; expectedReportIntervalSeconds?: number | null } = {}
): Promise<ServicePoint> {
  const db = await requireDb();
  const existing = await db.execute<SqlRow>(sql`
    SELECT meter_asset_id, expected_report_interval_seconds
    FROM service_points WHERE id = ${id} LIMIT 1
  `);
  const current = (existing.rows ?? [])[0];
  if (!current) {
    throw new ServiceReliabilityError(`Service point ${id} does not exist`);
  }

  const meterAssetId =
    meter.meterAssetId === undefined ? nullableNumber(current.meter_asset_id) : meter.meterAssetId;
  const intervalSeconds =
    meter.expectedReportIntervalSeconds === undefined
      ? nullableNumber(current.expected_report_interval_seconds)
      : meter.expectedReportIntervalSeconds;

  if (monitoring === 'metered_telemetry') {
    if (!meterAssetId) {
      throw new ServiceReliabilityError(
        'A metered connection must name the meter asset whose reports stand for its supply'
      );
    }
    if (!intervalSeconds || intervalSeconds <= 0) {
      throw new ServiceReliabilityError(
        'A metered connection must declare the interval its meter reports on, or a gap cannot be told from a slow meter'
      );
    }
    const asset = await db.execute<SqlRow>(sql`
      SELECT id FROM assets WHERE id = ${meterAssetId} LIMIT 1
    `);
    if ((asset.rows ?? []).length === 0) {
      throw new ServiceReliabilityError(`Asset ${meterAssetId} does not exist`);
    }
  }

  const result = await db.execute<SqlRow>(sql`
    UPDATE service_points
    SET monitoring = ${monitoring},
        meter_asset_id = ${meterAssetId},
        expected_report_interval_seconds = ${intervalSeconds},
        updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `);
  const row = (result.rows ?? [])[0];
  if (!row) {
    throw new ServiceReliabilityError(`Service point ${id} does not exist`);
  }
  return toServicePoint(row);
}

/**
 * Record that a connection was disconnected.
 *
 * Exposure stops at this instant rather than at the end of the period, so a
 * customer who left in week one is not counted as having been supplied for the
 * whole month. The row stays: past interruptions remain part of the history of
 * the periods they happened in.
 */
export async function disconnectServicePoint(
  id: number,
  disconnectedAt: Date
): Promise<ServicePoint> {
  const db = await requireDb();
  const result = await db.execute<SqlRow>(sql`
    UPDATE service_points
    SET disconnected_at = ${disconnectedAt}, updated_at = NOW()
    WHERE id = ${id} AND connected_at < ${disconnectedAt}
    RETURNING *
  `);
  const row = (result.rows ?? [])[0];
  if (!row) {
    throw new ServiceReliabilityError(
      `Service point ${id} does not exist, or was not connected before ${disconnectedAt.toISOString()}`
    );
  }
  return toServicePoint(row);
}

/** Undo a disconnection recorded in error, or record a reconnection. */
export async function reconnectServicePoint(id: number): Promise<ServicePoint> {
  const db = await requireDb();
  const result = await db.execute<SqlRow>(sql`
    UPDATE service_points
    SET disconnected_at = NULL, updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `);
  const row = (result.rows ?? [])[0];
  if (!row) {
    throw new ServiceReliabilityError(`Service point ${id} does not exist`);
  }
  return toServicePoint(row);
}

export interface RecordInterruptionInput {
  servicePointId: number;
  startedAt: Date;
  endedAt?: Date | null;
  cause: InterruptionCause;
  detectionSource: InterruptionDetectionSource;
  evidenceRef: string;
  restoredEvidenceRef?: string | null;
  excludeFromIndices?: boolean;
  exclusionReason?: string | null;
  notes?: string | null;
}

/**
 * Record one loss of supply. Evidence is mandatory and a closed row needs
 * evidence of restoration too: "the power came back at some point" with nothing
 * behind it produces a duration that reads as measured.
 */
export async function recordInterruption(
  input: RecordInterruptionInput,
  recordedBy: number | null
): Promise<ServiceInterruption> {
  const evidenceRef = input.evidenceRef.trim();
  if (evidenceRef.length === 0) {
    throw new ServiceReliabilityError('An interruption needs a reference to the evidence behind it');
  }
  if (input.endedAt) {
    if (input.endedAt <= input.startedAt) {
      throw new ServiceReliabilityError('An interruption cannot end before it started');
    }
    if (!input.restoredEvidenceRef || input.restoredEvidenceRef.trim().length === 0) {
      throw new ServiceReliabilityError(
        'Closing an interruption needs evidence that supply returned, not just an end time'
      );
    }
  }
  if (input.excludeFromIndices && !input.exclusionReason?.trim()) {
    throw new ServiceReliabilityError(
      'Excluding an interruption from the indices needs a stated reason'
    );
  }

  const db = await requireDb();
  const point = await db.execute<SqlRow>(sql`
    SELECT id, connected_at FROM service_points WHERE id = ${input.servicePointId} LIMIT 1
  `);
  const pointRow = (point.rows ?? [])[0];
  if (!pointRow) {
    throw new ServiceReliabilityError(`Service point ${input.servicePointId} does not exist`);
  }
  if (input.startedAt < new Date(String(pointRow.connected_at))) {
    throw new ServiceReliabilityError(
      'An interruption cannot start before the connection was energised'
    );
  }

  const result = await db.execute<SqlRow>(sql`
    INSERT INTO service_interruptions (
      service_point_id, started_at, ended_at, cause, detection_source, evidence_ref,
      restored_evidence_ref, exclude_from_indices, exclusion_reason, recorded_by, notes
    ) VALUES (
      ${input.servicePointId}, ${input.startedAt}, ${input.endedAt ?? null}, ${input.cause},
      ${input.detectionSource}, ${evidenceRef}, ${input.restoredEvidenceRef ?? null},
      ${input.excludeFromIndices ?? false}, ${input.exclusionReason ?? null},
      ${recordedBy}, ${input.notes ?? null}
    )
    ON CONFLICT (service_point_id, started_at) DO NOTHING
    RETURNING *
  `);
  const row = (result.rows ?? [])[0];
  if (!row) {
    throw new ServiceReliabilityError(
      `An interruption starting at ${input.startedAt.toISOString()} is already recorded for this connection`
    );
  }
  return toInterruption(row);
}

/** Close an open interruption with the evidence that supply returned. */
export async function closeInterruption(
  id: number,
  endedAt: Date,
  restoredEvidenceRef: string
): Promise<ServiceInterruption> {
  if (restoredEvidenceRef.trim().length === 0) {
    throw new ServiceReliabilityError('Closing an interruption needs evidence that supply returned');
  }
  const db = await requireDb();
  const result = await db.execute<SqlRow>(sql`
    UPDATE service_interruptions
    SET ended_at = ${endedAt},
        restored_evidence_ref = ${restoredEvidenceRef.trim()},
        updated_at = NOW()
    WHERE id = ${id} AND ended_at IS NULL AND started_at < ${endedAt}
    RETURNING *
  `);
  const row = (result.rows ?? [])[0];
  if (!row) {
    throw new ServiceReliabilityError(
      `Interruption ${id} is not open, does not exist, or did not start before ${endedAt.toISOString()}`
    );
  }
  return toInterruption(row);
}

/** Registered connections as exposure rows for the reliability computation. */
export async function loadServicePointExposure(filter: {
  communityId?: number;
  userId?: number;
}): Promise<ServicePointExposure[]> {
  const db = await requireDb();
  const result = await db.execute<SqlRow>(sql`
    SELECT id, point_class, monitoring, connected_at, disconnected_at
    FROM service_points
    WHERE 1 = 1
      ${filter.communityId === undefined ? sql`` : sql`AND community_id = ${filter.communityId}`}
      ${filter.userId === undefined ? sql`` : sql`AND user_id = ${filter.userId}`}
    ORDER BY id ASC
  `);
  return (result.rows ?? []).map((row) => ({
    servicePointId: Number(row.id),
    pointClass: String(row.point_class),
    observed: String(row.monitoring) !== 'unmonitored',
    connectedAt: new Date(String(row.connected_at)),
    disconnectedAt: row.disconnected_at ? new Date(String(row.disconnected_at)) : null,
  }));
}

/**
 * Interruptions overlapping a period. An open row is returned as open: the
 * computation clamps it and reports the figure as a lower bound rather than
 * treating the period end as a restoration.
 */
export async function loadInterruptions(
  period: { start: Date; end: Date },
  filter: { communityId?: number; userId?: number } = {}
): Promise<InterruptionRecord[]> {
  const db = await requireDb();
  const result = await db.execute<SqlRow>(sql`
    SELECT si.id, si.service_point_id, si.started_at, si.ended_at, si.cause,
           si.detection_source, si.exclude_from_indices
    FROM service_interruptions si
    JOIN service_points sp ON sp.id = si.service_point_id
    WHERE si.started_at < ${period.end}
      AND (si.ended_at IS NULL OR si.ended_at > ${period.start})
      ${filter.communityId === undefined ? sql`` : sql`AND sp.community_id = ${filter.communityId}`}
      ${filter.userId === undefined ? sql`` : sql`AND sp.user_id = ${filter.userId}`}
    ORDER BY si.started_at ASC
  `);
  return (result.rows ?? []).map((row) => ({
    id: Number(row.id),
    servicePointId: Number(row.service_point_id),
    startedAt: new Date(String(row.started_at)),
    endedAt: row.ended_at ? new Date(String(row.ended_at)) : null,
    cause: String(row.cause),
    detectionSource: String(row.detection_source),
    excludeFromIndices: row.exclude_from_indices === true || row.exclude_from_indices === 't',
  }));
}

export async function listInterruptions(
  filter: {
    communityId?: number;
    servicePointId?: number;
    userId?: number;
    openOnly?: boolean;
    limit?: number;
  } = {}
): Promise<ServiceInterruption[]> {
  const db = await requireDb();
  const result = await db.execute<SqlRow>(sql`
    SELECT si.* FROM service_interruptions si
    JOIN service_points sp ON sp.id = si.service_point_id
    WHERE 1 = 1
      ${filter.communityId === undefined ? sql`` : sql`AND sp.community_id = ${filter.communityId}`}
      ${filter.servicePointId === undefined ? sql`` : sql`AND si.service_point_id = ${filter.servicePointId}`}
      ${filter.userId === undefined ? sql`` : sql`AND sp.user_id = ${filter.userId}`}
      ${filter.openOnly ? sql`AND si.ended_at IS NULL` : sql``}
    ORDER BY si.started_at DESC
    LIMIT ${filter.limit ?? 100}
  `);
  return (result.rows ?? []).map(toInterruption);
}

export interface GapDetectionResult {
  /** Connections whose meter reported on time; nothing to record. */
  reporting: number;
  /** Interruptions opened by this run. */
  opened: ServiceInterruption[];
  /** Interruptions closed because the meter reported again. */
  closed: ServiceInterruption[];
  /** Connections skipped, with why: a detector that silently skips is a lie. */
  skipped: Array<{ servicePointId: number; reason: string }>;
}

/**
 * Turn meter silence into candidate interruptions, and a meter's return into a
 * restoration.
 *
 * Two deliberate limits. A connection with no declared interval is skipped and
 * reported as skipped, never assumed. And a gap is recorded as
 * `detection_source = 'telemetry_gap'`, whose stated meaning is that the meter
 * stopped reporting — a communications failure looks identical from here, and
 * the report says so rather than presenting it as a measured outage.
 */
export async function detectInterruptionsFromTelemetryGaps(options: {
  communityId?: number;
  now?: Date;
} = {}): Promise<GapDetectionResult> {
  const db = await requireDb();
  const now = options.now ?? new Date();
  const points = await db.execute<SqlRow>(sql`
    SELECT sp.id, sp.meter_asset_id, sp.expected_report_interval_seconds, sp.connected_at,
           recent.timestamp AS last_report_at,
           recent.id AS last_report_id,
           open_row.id AS open_interruption_id,
           open_row.started_at AS open_started_at
    FROM service_points sp
    LEFT JOIN LATERAL (
      SELECT t.id, t.timestamp
      FROM telemetry t
      WHERE t."assetId" = sp.meter_asset_id
      ORDER BY t.timestamp DESC
      LIMIT 1
    ) recent ON true
    LEFT JOIN LATERAL (
      SELECT si.id, si.started_at
      FROM service_interruptions si
      WHERE si.service_point_id = sp.id
        AND si.ended_at IS NULL
        AND si.detection_source = 'telemetry_gap'
      ORDER BY si.started_at DESC
      LIMIT 1
    ) open_row ON true
    WHERE sp.monitoring = 'metered_telemetry'
      AND sp.disconnected_at IS NULL
      ${options.communityId === undefined ? sql`` : sql`AND sp.community_id = ${options.communityId}`}
    ORDER BY sp.id ASC
  `);

  const result: GapDetectionResult = { reporting: 0, opened: [], closed: [], skipped: [] };

  for (const row of points.rows ?? []) {
    const servicePointId = Number(row.id);
    const intervalSeconds = nullableNumber(row.expected_report_interval_seconds);
    if (!intervalSeconds) {
      result.skipped.push({
        servicePointId,
        reason: 'no expected reporting interval is registered, so silence cannot be timed',
      });
      continue;
    }
    if (!row.meter_asset_id) {
      result.skipped.push({ servicePointId, reason: 'no meter asset is registered' });
      continue;
    }

    const lastReportAt = row.last_report_at ? new Date(String(row.last_report_at)) : null;
    if (!lastReportAt) {
      result.skipped.push({
        servicePointId,
        reason: 'the meter has never reported, so there is no baseline to call a gap against',
      });
      continue;
    }

    const gapSeconds = (now.getTime() - lastReportAt.getTime()) / 1000;
    const openId = nullableNumber(row.open_interruption_id);

    if (gapSeconds > intervalSeconds * GAP_INTERVALS_BEFORE_INTERRUPTION) {
      if (openId !== null) continue; // Already recorded; the gap is not new.
      result.opened.push(
        await recordInterruption(
          {
            servicePointId,
            // Supply is only known to have been present at the last reading, so
            // that instant is the earliest defensible start.
            startedAt: lastReportAt,
            cause: 'unknown',
            detectionSource: 'telemetry_gap',
            evidenceRef: `telemetry:${row.last_report_id ?? 'unknown'}@${lastReportAt.toISOString()}`,
            notes: `Meter silent for ${Math.round(gapSeconds / 60)} minutes against a ${Math.round(
              intervalSeconds / 60
            )} minute interval`,
          },
          null
        )
      );
      continue;
    }

    result.reporting += 1;
    if (openId !== null) {
      // The meter is reporting again: the gap ended at the first reading after
      // it, which is the evidence recorded for the restoration.
      const first = await db.execute<SqlRow>(sql`
        SELECT t.id, t.timestamp
        FROM telemetry t
        WHERE t."assetId" = ${Number(row.meter_asset_id)}
          AND t.timestamp > ${new Date(String(row.open_started_at))}
        ORDER BY t.timestamp ASC
        LIMIT 1
      `);
      const firstRow = (first.rows ?? [])[0];
      if (!firstRow) continue;
      result.closed.push(
        await closeInterruption(
          openId,
          new Date(String(firstRow.timestamp)),
          `telemetry:${firstRow.id}@${new Date(String(firstRow.timestamp)).toISOString()}`
        )
      );
    }
  }

  return result;
}

/**
 * The reliability report for a period: the indices, the coverage behind them and
 * the interruptions they were computed from. Recomputed on every call so a
 * restoration recorded late corrects the figure instead of leaving a stale index
 * on record.
 */
export async function reliabilityReport(
  period: { start: Date; end: Date },
  filter: { communityId?: number; userId?: number } = {}
): Promise<ReliabilityAssessment> {
  const [servicePoints, interruptions] = await Promise.all([
    loadServicePointExposure(filter),
    loadInterruptions(period, filter),
  ]);
  return assessReliability({ period, servicePoints, interruptions });
}
