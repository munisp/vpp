/**
 * Capacity bid builder (innovation 17)
 *
 * Builds a capacity bid from the user's REAL registered flexible capacity:
 * the sum of per-asset flexible power (a battery's registered
 * der_capabilities.max_power_export, a generator's registered nameplate
 * watts) minus real, recorded commitments overlapping the delivery window
 * (active service_enrollments and outstanding dispatch_setpoints).
 *
 * Honesty rule: when any flexible asset's power cannot be established from
 * registered data, the total is unknown — the bid is persisted with
 * `bidAvailable: false` and reason 'unknown_capacity', and cannot be
 * submitted. A bid built on an assumed nameplate is a commitment the
 * platform cannot keep on the user's behalf.
 *
 * Lifecycle: draft -> submitted -> awarded/rejected. An outcome is only
 * ever recorded by an operator (recordOutcome) with a note and their
 * identity — the platform never infers an award.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../db';
import { assets } from '../../drizzle/schema';
import { derCapabilities, serviceEnrollments } from '../../drizzle/nextgen-vpp-schema';
import { capacityBids, type CapacityBidRow } from '../../drizzle/innov3-control-schema';
import type { SqlRow } from '../sql-row';

export class CapacityBidError extends Error {}

/** Asset types whose output the user can flex on demand. */
const FLEXIBLE_ASSET_TYPES = ['battery', 'generator'] as const;

export type BidUnavailableReason = 'no_flexible_assets' | 'unknown_capacity';

interface AssetBasis {
  assetId: number;
  name: string;
  assetType: string;
  /** Registered flexible power, watts. Null when not registered. */
  flexiblePowerW: number | null;
  /** Where the figure came from. */
  source: 'der_capabilities.max_power_export' | 'assets.capacity' | null;
}

interface CommitmentBasis {
  kind: 'service_enrollment' | 'dispatch_setpoint';
  id: number;
  assetId: number | null;
  watts: number;
  windowStart: string;
  windowEnd: string;
}

export interface BidBasis {
  assets: AssetBasis[];
  commitments: CommitmentBasis[];
  knownCapacityW: number | null;
  committedCapacityW: number;
  offeredCapacityW: number | null;
}

async function computeBasis(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  userId: number,
  deliveryStart: Date,
  deliveryEnd: Date
): Promise<{ basis: BidBasis; bidAvailable: boolean; unavailableReason: BidUnavailableReason | null }> {
  const flexibleAssets = await db
    .select({
      id: assets.id,
      name: assets.name,
      assetType: assets.assetType,
      capacity: assets.capacity,
      maxPowerExport: derCapabilities.maxPowerExport,
    })
    .from(assets)
    .leftJoin(derCapabilities, eq(derCapabilities.assetId, assets.id))
    .where(
      and(
        eq(assets.userId, userId),
        eq(assets.status, 'active'),
        inArray(assets.assetType, [...FLEXIBLE_ASSET_TYPES])
      )
    );

  if (flexibleAssets.length === 0) {
    return {
      basis: { assets: [], commitments: [], knownCapacityW: null, committedCapacityW: 0, offeredCapacityW: null },
      bidAvailable: false,
      unavailableReason: 'no_flexible_assets',
    };
  }

  const assetBasis: AssetBasis[] = flexibleAssets.map((a) => {
    if (a.assetType === 'battery') {
      // For storage, flexible POWER is the registered discharge limit. The
      // assets.capacity column is energy (Wh) for batteries and must not be
      // read as watts.
      return {
        assetId: a.id,
        name: a.name,
        assetType: a.assetType,
        flexiblePowerW: a.maxPowerExport,
        source: a.maxPowerExport !== null ? 'der_capabilities.max_power_export' : null,
      };
    }
    // Generators are nameplated in watts in assets.capacity.
    return {
      assetId: a.id,
      name: a.name,
      assetType: a.assetType,
      flexiblePowerW: a.capacity,
      source: 'assets.capacity',
    };
  });

  // One unassessable flexible asset makes the total unknown: summing the rest
  // and calling it the capacity would silently omit whatever that asset can do.
  const anyUnknown = assetBasis.some((a) => a.flexiblePowerW === null || (a.flexiblePowerW ?? 0) <= 0);
  const knownCapacityW = anyUnknown
    ? null
    : assetBasis.reduce((sum, a) => sum + (a.flexiblePowerW ?? 0), 0);

  // Real, recorded commitments overlapping the delivery window.
  const commitments: CommitmentBasis[] = [];

  const enrollments = await db
    .select({
      id: serviceEnrollments.id,
      assetId: serviceEnrollments.assetId,
      enrolledCapacityKw: serviceEnrollments.enrolledCapacityKw,
      effectiveFrom: serviceEnrollments.effectiveFrom,
      effectiveUntil: serviceEnrollments.effectiveUntil,
    })
    .from(serviceEnrollments)
    .where(and(eq(serviceEnrollments.userId, userId), eq(serviceEnrollments.status, 'active')));

  for (const e of enrollments) {
    const overlaps =
      e.effectiveFrom <= deliveryEnd && (e.effectiveUntil === null || e.effectiveUntil >= deliveryStart);
    if (overlaps) {
      commitments.push({
        kind: 'service_enrollment',
        id: e.id,
        assetId: e.assetId,
        watts: e.enrolledCapacityKw * 1000,
        windowStart: e.effectiveFrom.toISOString(),
        windowEnd: e.effectiveUntil ? e.effectiveUntil.toISOString() : deliveryEnd.toISOString(),
      });
    }
  }

  // Outstanding dispatch setpoints for the user's assets in the window.
  const setpointResult = await db.execute<SqlRow>(sql`
    SELECT ds.id, ds.asset_id, ds.target_power_watts, ds.interval_start, ds.interval_end
    FROM dispatch_setpoints ds
    JOIN assets a ON a.id = ds.asset_id
    WHERE a."userId" = ${userId}
      AND ds.status IN ('scheduled', 'dispatched', 'acknowledged', 'executing')
      AND ds.interval_start <= ${deliveryEnd}
      AND ds.interval_end >= ${deliveryStart}
      AND ds.target_power_watts > 0
  `);
  for (const row of setpointResult.rows ?? []) {
    commitments.push({
      kind: 'dispatch_setpoint',
      id: Number(row.id),
      assetId: row.asset_id === null ? null : Number(row.asset_id),
      watts: Number(row.target_power_watts),
      windowStart: new Date(String(row.interval_start)).toISOString(),
      windowEnd: new Date(String(row.interval_end)).toISOString(),
    });
  }

  const committedCapacityW = commitments.reduce((sum, c) => sum + c.watts, 0);
  const offeredCapacityW =
    knownCapacityW === null ? null : Math.max(0, knownCapacityW - committedCapacityW);

  return {
    basis: { assets: assetBasis, commitments, knownCapacityW, committedCapacityW, offeredCapacityW },
    bidAvailable: knownCapacityW !== null,
    unavailableReason: knownCapacityW === null ? 'unknown_capacity' : null,
  };
}

/**
 * Build (and persist) a draft bid. Unavailable bids are persisted too —
 * the refusal is part of the record, with the reason and the basis that
 * could not be summed.
 */
export async function buildBid(
  userId: number,
  params: { deliveryStart: Date; deliveryEnd: Date; priceCentsPerKwh?: number }
): Promise<CapacityBidRow> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  if (!(params.deliveryEnd > params.deliveryStart)) {
    throw new CapacityBidError('deliveryEnd must be after deliveryStart');
  }
  if (params.priceCentsPerKwh !== undefined && params.priceCentsPerKwh < 0) {
    throw new CapacityBidError('priceCentsPerKwh cannot be negative');
  }

  const { basis, bidAvailable, unavailableReason } = await computeBasis(
    db,
    userId,
    params.deliveryStart,
    params.deliveryEnd
  );

  const inserted = await db
    .insert(capacityBids)
    .values({
      userId,
      deliveryStart: params.deliveryStart,
      deliveryEnd: params.deliveryEnd,
      status: 'draft',
      bidAvailable,
      unavailableReason,
      knownCapacityW: basis.knownCapacityW,
      committedCapacityW: basis.committedCapacityW,
      offeredCapacityW: basis.offeredCapacityW,
      priceCentsPerKwh: params.priceCentsPerKwh ?? null,
      basisJson: basis,
    })
    .returning();
  return inserted[0];
}

async function getOwnedBid(userId: number, bidId: number): Promise<CapacityBidRow> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const rows = await db
    .select()
    .from(capacityBids)
    .where(and(eq(capacityBids.id, bidId), eq(capacityBids.userId, userId)))
    .limit(1);
  const bid = rows[0];
  if (!bid) throw new CapacityBidError(`Bid ${bidId} not found`);
  return bid;
}

/**
 * Submit a draft. Refused when the bid is unavailable (nothing real behind
 * the number) or offers zero watts.
 */
export async function submitBid(userId: number, bidId: number): Promise<CapacityBidRow> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const bid = await getOwnedBid(userId, bidId);

  if (bid.status === 'submitted') return bid; // idempotent
  if (bid.status !== 'draft') {
    throw new CapacityBidError(`Bid ${bidId} is ${bid.status}; only a draft can be submitted`);
  }
  if (!bid.bidAvailable || bid.offeredCapacityW === null) {
    throw new CapacityBidError(
      `Bid ${bidId} is not submittable: capacity could not be established (${bid.unavailableReason ?? 'unknown_capacity'})`
    );
  }
  if (bid.offeredCapacityW <= 0) {
    throw new CapacityBidError(`Bid ${bidId} offers zero watts after commitments; there is nothing to submit`);
  }

  const updated = await db
    .update(capacityBids)
    .set({ status: 'submitted', submittedAt: new Date() })
    .where(eq(capacityBids.id, bidId))
    .returning();
  return updated[0];
}

/** Withdraw a draft or submitted bid. */
export async function withdrawBid(userId: number, bidId: number): Promise<CapacityBidRow> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const bid = await getOwnedBid(userId, bidId);
  if (bid.status !== 'draft' && bid.status !== 'submitted') {
    throw new CapacityBidError(`Bid ${bidId} is ${bid.status}; it cannot be withdrawn`);
  }
  const updated = await db
    .update(capacityBids)
    .set({ status: 'withdrawn' })
    .where(eq(capacityBids.id, bidId))
    .returning();
  return updated[0];
}

/**
 * Operator: record the real outcome of a submitted bid. The platform never
 * infers an award — this is the only path to awarded/rejected, and it
 * requires the operator's identity and a note pointing at the real input
 * (e.g. the program's award notice).
 */
export async function recordOutcome(
  operatorUserId: number,
  bidId: number,
  outcome: 'awarded' | 'rejected',
  note: string
): Promise<CapacityBidRow> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  if (!note || note.trim().length === 0) {
    throw new CapacityBidError('An outcome note is required: record what the outcome is based on');
  }
  const rows = await db.select().from(capacityBids).where(eq(capacityBids.id, bidId)).limit(1);
  const bid = rows[0];
  if (!bid) throw new CapacityBidError(`Bid ${bidId} not found`);
  if (bid.status !== 'submitted') {
    throw new CapacityBidError(`Bid ${bidId} is ${bid.status}; an outcome can only be recorded on a submitted bid`);
  }
  const updated = await db
    .update(capacityBids)
    .set({
      status: outcome,
      outcomeRecordedAt: new Date(),
      outcomeRecordedBy: operatorUserId,
      outcomeNote: note.trim().slice(0, 500),
    })
    .where(eq(capacityBids.id, bidId))
    .returning();
  return updated[0];
}

export async function getBid(userId: number, bidId: number): Promise<CapacityBidRow> {
  return getOwnedBid(userId, bidId);
}

export async function listBids(userId: number, limit: number): Promise<CapacityBidRow[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(capacityBids)
    .where(eq(capacityBids.userId, userId))
    .orderBy(desc(capacityBids.createdAt))
    .limit(limit);
}
