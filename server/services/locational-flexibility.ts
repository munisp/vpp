/**
 * Locational flexibility: selling capacity at a place, and proving it turned up.
 *
 * A distribution operator's problem is one substation at one hour, so three
 * things decide whether an offer is real, and all three are enforced here rather
 * than assumed:
 *
 *   1. *Place.* Only assets with a declared or utility-verified link to the node
 *      can be awarded. An unverified link is kept and reported, never cleared:
 *      relief at a feeder the asset is not behind is not relief.
 *   2. *Size.* An offer is capped by the asset's own rating, so a 3 kW inverter
 *      cannot be awarded 30 kW of turn-down.
 *   3. *Delivery.* Delivery is a measured reduction against a baseline built from
 *      that asset's own telemetry on comparable days, excluding days the asset
 *      was itself delivering flexibility in the same clock window. Without enough
 *      real baseline samples, or without telemetry inside the window, the award
 *      is `unverified` — neither delivery nor breach — and cannot be settled.
 *
 * Settlement is a separate, deliberate call that refuses anything not verified,
 * and pays on the measured reduction capped at the award, never on the award.
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { getDb } from '../db';
import { assets } from '../../drizzle/schema';
import {
  flexibilityAwards,
  flexibilityOffers,
  flexibilityRequirements,
  gridNodeAssets,
  gridNodes,
} from '../../drizzle/locational-flexibility-schema';
import { recordDegradedAction, requireCapability } from './degraded-operation';
import { settlementLedger } from './settlement-ledger';
import type { SqlRow } from '../sql-row';

/** Prices are cents per kWh x100, matching price-signal and forecast columns. */
export const PRICE_SCALE = 100;
/** Days of history the baseline looks back over. */
export const BASELINE_LOOKBACK_DAYS = 10;
/** Minimum real telemetry samples before a baseline is usable. */
export const MIN_BASELINE_SAMPLES = 6;
/** Minimum distinct historical days behind a baseline. */
export const MIN_BASELINE_DAYS = 3;
/** Minimum telemetry samples inside the window before delivery is measurable. */
export const MIN_DELIVERY_SAMPLES = 2;

export const BASELINE_METHOD = `same_window_mean_${BASELINE_LOOKBACK_DAYS}_days_excluding_awarded`;

export class LocationalFlexibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocationalFlexibilityError';
  }
}

export type GridNodeKind = 'substation' | 'feeder' | 'transformer';
export type NodeLinkSource = 'operator_declared' | 'utility_verified' | 'unverified';
export type FlexibilityDirection = 'import_reduction' | 'export_reduction';
export type DeliveryStatus =
  | 'unmeasured'
  | 'delivered'
  | 'partial'
  | 'not_delivered'
  | 'unverified';

/** Link provenance that may be cleared. Anything else is reported, not awarded. */
export const AWARDABLE_LINK_SOURCES: NodeLinkSource[] = [
  'operator_declared',
  'utility_verified',
];

export interface CreateRequirementInput {
  nodeId: number;
  direction: FlexibilityDirection;
  startsAt: Date;
  endsAt: Date;
  requiredPowerW: number;
  priceCapCentsPerKwh: number;
  currency?: string;
  notes?: string;
}

export interface SubmitOfferInput {
  requirementId: number;
  assetId: number;
  offeredPowerW: number;
  priceCentsPerKwh: number;
}

export interface ClearingResult {
  requirementId: number;
  requiredPowerW: number;
  clearedPowerW: number;
  clearingPriceCentsPerKwh: number | null;
  status: 'cleared' | 'short';
  awards: Array<{
    offerId: number;
    assetId: number;
    userId: number;
    awardedPowerW: number;
    priceCentsPerKwh: number;
  }>;
  /** Offers that could not be cleared, each with the reason. Never dropped. */
  ineligible: Array<{ offerId: number; assetId: number; reason: string }>;
  notAwarded: number[];
}

export interface MeasurementResult {
  awardId: number;
  deliveryStatus: DeliveryStatus;
  baselinePowerW: number | null;
  baselineSamples: number;
  baselineDays: number;
  measuredPowerW: number | null;
  measuredSamples: number;
  deliveredPowerW: number | null;
  creditedPowerW: number | null;
  deliveredEnergyWh: number | null;
  earnedAmount: number | null;
  /** Why the measurement is unverified, when it is. */
  unverifiedReason: string | null;
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new LocationalFlexibilityError('Database not available');
  return db;
}

function requirePositiveInt(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new LocationalFlexibilityError(`${field} must be a positive whole number`);
  }
  return value;
}

/** Register a node. Codes are the operator's, and unique. */
export async function createGridNode(input: {
  code: string;
  name: string;
  kind: GridNodeKind;
  parentNodeId?: number;
  region?: string;
  firmCapacityW?: number;
}): Promise<number> {
  const db = await requireDb();
  if (!input.code.trim() || !input.name.trim()) {
    throw new LocationalFlexibilityError('A node needs a code and a name');
  }
  const rows = await db
    .insert(gridNodes)
    .values({
      code: input.code.trim(),
      name: input.name.trim(),
      kind: input.kind,
      parentNodeId: input.parentNodeId ?? null,
      region: input.region ?? null,
      firmCapacityW: input.firmCapacityW ?? null,
    })
    .returning({ id: gridNodes.id });
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new LocationalFlexibilityError('Node insert returned no id');
  }
  return id;
}

/**
 * Record which node an asset sits behind.
 *
 * `verifiedAt` is only set for a utility-verified link, so a declared link never
 * ages into looking confirmed.
 */
export async function linkAssetToNode(input: {
  nodeId: number;
  assetId: number;
  linkSource: NodeLinkSource;
  linkedByUserId: number;
  evidence?: string;
}): Promise<void> {
  const db = await requireDb();
  if (input.linkSource === 'utility_verified' && !input.evidence?.trim()) {
    throw new LocationalFlexibilityError(
      'A utility-verified link needs evidence: a meter point reference or utility ticket'
    );
  }
  const verifiedAt = input.linkSource === 'utility_verified' ? new Date() : null;
  await db
    .insert(gridNodeAssets)
    .values({
      nodeId: input.nodeId,
      assetId: input.assetId,
      linkSource: input.linkSource,
      linkedByUserId: input.linkedByUserId,
      evidence: input.evidence?.trim() ?? null,
      verifiedAt,
    })
    .onConflictDoUpdate({
      target: gridNodeAssets.assetId,
      set: {
        nodeId: input.nodeId,
        linkSource: input.linkSource,
        linkedByUserId: input.linkedByUserId,
        evidence: input.evidence?.trim() ?? null,
        verifiedAt,
        updatedAt: new Date(),
      },
    });
}

export async function createRequirement(
  input: CreateRequirementInput,
  createdByUserId: number
): Promise<number> {
  const db = await requireDb();
  requirePositiveInt(input.requiredPowerW, 'requiredPowerW');
  if (!Number.isInteger(input.priceCapCentsPerKwh) || input.priceCapCentsPerKwh < 0) {
    throw new LocationalFlexibilityError('priceCapCentsPerKwh must be zero or more');
  }
  if (input.endsAt.getTime() <= input.startsAt.getTime()) {
    throw new LocationalFlexibilityError('A requirement window must end after it starts');
  }

  const node = await db
    .select({ id: gridNodes.id })
    .from(gridNodes)
    .where(eq(gridNodes.id, input.nodeId))
    .limit(1);
  if (node.length === 0) {
    throw new LocationalFlexibilityError(`Unknown grid node ${input.nodeId}`);
  }

  const rows = await db
    .insert(flexibilityRequirements)
    .values({
      nodeId: input.nodeId,
      direction: input.direction,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      requiredPowerW: input.requiredPowerW,
      priceCapCentsPerKwh: input.priceCapCentsPerKwh,
      currency: input.currency ?? 'TZS',
      notes: input.notes ?? null,
      createdByUserId,
    })
    .returning({ id: flexibilityRequirements.id });
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new LocationalFlexibilityError('Requirement insert returned no id');
  }
  return id;
}

/**
 * Offer capacity from one owned asset.
 *
 * The offer is refused, not silently trimmed, when it exceeds the asset's rating
 * or when the asset is not linked to the requirement's node: an offer the fleet
 * cannot physically honour at that place is not an offer.
 */
export async function submitOffer(
  input: SubmitOfferInput,
  userId: number,
  now?: Date
): Promise<number> {
  const db = await requireDb();
  requirePositiveInt(input.offeredPowerW, 'offeredPowerW');
  if (!Number.isInteger(input.priceCentsPerKwh) || input.priceCentsPerKwh < 0) {
    throw new LocationalFlexibilityError('priceCentsPerKwh must be zero or more');
  }

  const requirementRows = await db
    .select()
    .from(flexibilityRequirements)
    .where(eq(flexibilityRequirements.id, input.requirementId))
    .limit(1);
  const requirement = requirementRows[0];
  if (!requirement) {
    throw new LocationalFlexibilityError(`Unknown requirement ${input.requirementId}`);
  }
  if (requirement.status !== 'open') {
    throw new LocationalFlexibilityError(
      `Requirement ${input.requirementId} is ${requirement.status} and takes no more offers`
    );
  }
  if (requirement.startsAt.getTime() <= (now ?? new Date()).getTime()) {
    throw new LocationalFlexibilityError(
      'The delivery window has already started: offers close when it does'
    );
  }

  const assetRows = await db
    .select({
      id: assets.id,
      userId: assets.userId,
      capacity: assets.capacity,
      status: assets.status,
    })
    .from(assets)
    .where(eq(assets.id, input.assetId))
    .limit(1);
  const asset = assetRows[0];
  if (!asset) {
    throw new LocationalFlexibilityError(`Unknown asset ${input.assetId}`);
  }
  if (asset.userId !== userId) {
    throw new LocationalFlexibilityError('That asset belongs to another owner');
  }
  if (asset.status !== 'active') {
    throw new LocationalFlexibilityError(`Asset ${input.assetId} is ${asset.status}, not active`);
  }
  if (input.offeredPowerW > asset.capacity) {
    throw new LocationalFlexibilityError(
      `Offered ${input.offeredPowerW} W exceeds the asset's ${asset.capacity} W rating`
    );
  }

  const linkRows = await db
    .select({
      nodeId: gridNodeAssets.nodeId,
      linkSource: gridNodeAssets.linkSource,
    })
    .from(gridNodeAssets)
    .where(eq(gridNodeAssets.assetId, input.assetId))
    .limit(1);
  const link = linkRows[0];
  if (!link || link.nodeId !== requirement.nodeId) {
    throw new LocationalFlexibilityError(
      `Asset ${input.assetId} is not linked to node ${requirement.nodeId}`
    );
  }

  const rows = await db
    .insert(flexibilityOffers)
    .values({
      requirementId: input.requirementId,
      assetId: input.assetId,
      userId,
      offeredPowerW: input.offeredPowerW,
      priceCentsPerKwh: input.priceCentsPerKwh,
      linkSource: link.linkSource,
    })
    .returning({ id: flexibilityOffers.id });
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new LocationalFlexibilityError('Offer insert returned no id');
  }
  return id;
}

/**
 * Clear a requirement in merit order: cheapest eligible capacity first, ties
 * broken by the larger block then the earlier offer, and the last award trimmed
 * to the remaining need.
 *
 * `short` rather than `cleared` when eligible capacity ran out, so an
 * under-served constraint is never reported as a met one.
 */
export async function clearRequirement(
  requirementId: number,
  now?: Date
): Promise<ClearingResult> {
  const db = await requireDb();
  const requirementRows = await db
    .select()
    .from(flexibilityRequirements)
    .where(eq(flexibilityRequirements.id, requirementId))
    .limit(1);
  const requirement = requirementRows[0];
  if (!requirement) {
    throw new LocationalFlexibilityError(`Unknown requirement ${requirementId}`);
  }
  if (requirement.status !== 'open') {
    throw new LocationalFlexibilityError(
      `Requirement ${requirementId} is already ${requirement.status}`
    );
  }

  const offerRows = await db.execute<SqlRow>(sql`
    SELECT
      o.id,
      o.asset_id,
      o.user_id,
      o.offered_power_w,
      o.price_cents_per_kwh,
      o.link_source,
      a.capacity AS asset_capacity,
      a.status::text AS asset_status,
      l.node_id AS linked_node_id,
      l.link_source::text AS current_link_source
    FROM flexibility_offers o
    JOIN assets a ON a.id = o.asset_id
    LEFT JOIN grid_node_assets l ON l.asset_id = o.asset_id
    WHERE o.requirement_id = ${requirementId} AND o.status = 'submitted'
    ORDER BY o.price_cents_per_kwh ASC, o.offered_power_w DESC, o.id ASC
  `);

  const awards: ClearingResult['awards'] = [];
  const ineligible: ClearingResult['ineligible'] = [];
  const notAwarded: number[] = [];
  let remaining = requirement.requiredPowerW;
  let clearingPrice: number | null = null;

  for (const row of offerRows.rows ?? []) {
    const offerId = Number(row.id);
    const assetId = Number(row.asset_id);
    const price = Number(row.price_cents_per_kwh);
    const linkSource = String(row.current_link_source ?? '') as NodeLinkSource;
    const reason = ineligibilityReason({
      assetStatus: String(row.asset_status ?? ''),
      linkedNodeId: row.linked_node_id === null ? null : Number(row.linked_node_id),
      requirementNodeId: requirement.nodeId,
      linkSource,
      price,
      priceCap: requirement.priceCapCentsPerKwh,
    });
    if (reason) {
      ineligible.push({ offerId, assetId, reason });
      continue;
    }

    if (remaining <= 0) {
      notAwarded.push(offerId);
      continue;
    }

    // Capped by the asset's rating as it stands now, not as it stood at bid time.
    const offerable = Math.min(Number(row.offered_power_w), Number(row.asset_capacity));
    const awardedPowerW = Math.min(offerable, remaining);
    if (awardedPowerW <= 0) {
      ineligible.push({ offerId, assetId, reason: 'Asset rating leaves no offerable capacity' });
      continue;
    }
    remaining -= awardedPowerW;
    clearingPrice = price;
    awards.push({
      offerId,
      assetId,
      userId: Number(row.user_id),
      awardedPowerW,
      priceCentsPerKwh: price,
    });
  }

  for (const award of awards) {
    await db.insert(flexibilityAwards).values({
      requirementId,
      offerId: award.offerId,
      assetId: award.assetId,
      userId: award.userId,
      awardedPowerW: award.awardedPowerW,
      priceCentsPerKwh: award.priceCentsPerKwh,
    });
    await db
      .update(flexibilityOffers)
      .set({ status: 'awarded', updatedAt: new Date() })
      .where(eq(flexibilityOffers.id, award.offerId));
  }
  for (const entry of ineligible) {
    await db
      .update(flexibilityOffers)
      .set({ status: 'ineligible', ineligibleReason: entry.reason, updatedAt: new Date() })
      .where(eq(flexibilityOffers.id, entry.offerId));
  }
  if (notAwarded.length > 0) {
    await db
      .update(flexibilityOffers)
      .set({ status: 'not_awarded', updatedAt: new Date() })
      .where(inArray(flexibilityOffers.id, notAwarded));
  }

  const clearedPowerW = requirement.requiredPowerW - remaining;
  const status = remaining > 0 ? 'short' : 'cleared';
  await db
    .update(flexibilityRequirements)
    .set({
      status,
      clearedPowerW,
      clearingPriceCentsPerKwh: clearingPrice,
      clearedAt: now ?? new Date(),
      updatedAt: new Date(),
    })
    .where(eq(flexibilityRequirements.id, requirementId));

  return {
    requirementId,
    requiredPowerW: requirement.requiredPowerW,
    clearedPowerW,
    clearingPriceCentsPerKwh: clearingPrice,
    status,
    awards,
    ineligible,
    notAwarded,
  };
}

/** The single reason an offer cannot be cleared, or null when it can. */
export function ineligibilityReason(input: {
  assetStatus: string;
  linkedNodeId: number | null;
  requirementNodeId: number;
  linkSource: NodeLinkSource;
  price: number;
  priceCap: number;
}): string | null {
  if (input.assetStatus !== 'active') {
    return `Asset is ${input.assetStatus}, not active`;
  }
  if (input.linkedNodeId === null) {
    return 'Asset is no longer linked to any grid node';
  }
  if (input.linkedNodeId !== input.requirementNodeId) {
    return `Asset has moved to node ${input.linkedNodeId}`;
  }
  if (!AWARDABLE_LINK_SOURCES.includes(input.linkSource)) {
    return 'Node link is unverified: the asset may not be behind this node';
  }
  if (input.price > input.priceCap) {
    return `Ask ${input.price} is above the operator's cap ${input.priceCap}`;
  }
  return null;
}

/**
 * Measure one award against telemetry.
 *
 * The baseline is the asset's mean net power in the same clock window on the
 * previous `BASELINE_LOOKBACK_DAYS` days, excluding any day the asset was itself
 * awarded flexibility overlapping that window — otherwise a site that turns down
 * every evening slowly lowers the baseline it is paid against.
 */
export async function measureAward(awardId: number, now?: Date): Promise<MeasurementResult> {
  const db = await requireDb();
  const rows = await db.execute<SqlRow>(sql`
    SELECT
      w.id,
      w.asset_id,
      w.awarded_power_w,
      w.price_cents_per_kwh,
      r.direction::text AS direction,
      r.starts_at,
      r.ends_at
    FROM flexibility_awards w
    JOIN flexibility_requirements r ON r.id = w.requirement_id
    WHERE w.id = ${awardId}
    LIMIT 1
  `);
  const award = (rows.rows ?? [])[0];
  if (!award) {
    throw new LocationalFlexibilityError(`Unknown award ${awardId}`);
  }

  const startsAt = new Date(String(award.starts_at));
  const endsAt = new Date(String(award.ends_at));
  const at = now ?? new Date();
  if (endsAt.getTime() > at.getTime()) {
    throw new LocationalFlexibilityError(
      'The delivery window has not elapsed: measuring it now would grade an unfinished window'
    );
  }

  const assetId = Number(award.asset_id);
  const direction = String(award.direction) as FlexibilityDirection;
  // The window's own length, not a rounded number of minutes: rounding pays a
  // 90-second window for two minutes and a 25-second window for nothing.
  const durationHours = (endsAt.getTime() - startsAt.getTime()) / 3_600_000;
  const lookbackFrom = new Date(startsAt.getTime() - BASELINE_LOOKBACK_DAYS * 86_400_000);
  // Clock window as text, so the comparison is a plain time comparison rather
  // than a cast of a timestamp parameter, and a window crossing midnight is a
  // union of two ranges instead of an empty one.
  const startTime = clockTimeOf(startsAt);
  const endTime = clockTimeOf(endsAt);
  const sameWindow =
    startTime < endTime
      ? sql`(t.timestamp::time >= ${startTime}::time AND t.timestamp::time < ${endTime}::time)`
      : sql`(t.timestamp::time >= ${startTime}::time OR t.timestamp::time < ${endTime}::time)`;

  const measurement = await db.execute<SqlRow>(sql`
    WITH window_samples AS (
      SELECT t.power
      FROM telemetry t
      WHERE t."assetId" = ${assetId}
        AND t.timestamp >= ${startsAt}
        AND t.timestamp < ${endsAt}
        AND t.power IS NOT NULL
    ),
    baseline_samples AS (
      SELECT t.power, date_trunc('day', t.timestamp) AS day
      FROM telemetry t
      WHERE t."assetId" = ${assetId}
        AND t.timestamp >= ${lookbackFrom}
        AND t.timestamp < ${startsAt}
        AND t.power IS NOT NULL
        -- same clock window on earlier days
        AND ${sameWindow}
        -- excluding days this asset was itself delivering in that window
        AND NOT EXISTS (
          SELECT 1
          FROM flexibility_awards w2
          JOIN flexibility_requirements r2 ON r2.id = w2.requirement_id
          WHERE w2.asset_id = ${assetId}
            AND t.timestamp >= r2.starts_at
            AND t.timestamp < r2.ends_at
        )
    )
    SELECT
      (SELECT COUNT(*) FROM window_samples)::int AS measured_samples,
      (SELECT AVG(power) FROM window_samples)::float AS measured_power,
      (SELECT COUNT(*) FROM baseline_samples)::int AS baseline_samples,
      (SELECT COUNT(DISTINCT day) FROM baseline_samples)::int AS baseline_days,
      (SELECT AVG(power) FROM baseline_samples)::float AS baseline_power
  `);
  const row = (measurement.rows ?? [])[0];
  if (!row) {
    throw new LocationalFlexibilityError('Measurement query returned no row');
  }

  const measuredSamples = Number(row.measured_samples);
  const baselineSamples = Number(row.baseline_samples);
  const baselineDays = Number(row.baseline_days);
  const measuredPowerW =
    row.measured_power === null ? null : Math.round(Number(row.measured_power));
  const baselinePowerW =
    row.baseline_power === null ? null : Math.round(Number(row.baseline_power));

  const unverifiedReason = unverifiedMeasurementReason({
    measuredSamples,
    baselineSamples,
    baselineDays,
  });

  const result: MeasurementResult = {
    awardId,
    deliveryStatus: 'unverified',
    baselinePowerW,
    baselineSamples,
    baselineDays,
    measuredPowerW,
    measuredSamples,
    deliveredPowerW: null,
    creditedPowerW: null,
    deliveredEnergyWh: null,
    earnedAmount: null,
    unverifiedReason,
  };

  if (!unverifiedReason && measuredPowerW !== null && baselinePowerW !== null) {
    const deliveredPowerW = Math.max(
      0,
      reductionWatts(direction, baselinePowerW, measuredPowerW)
    );
    const awardedPowerW = Number(award.awarded_power_w);
    const creditedPowerW = Math.min(deliveredPowerW, awardedPowerW);
    const deliveredEnergyWh = Math.round(creditedPowerW * durationHours);
    const earnedAmount = Math.round(
      ((deliveredEnergyWh / 1000) * Number(award.price_cents_per_kwh)) / PRICE_SCALE
    );
    result.deliveredPowerW = deliveredPowerW;
    result.creditedPowerW = creditedPowerW;
    result.deliveredEnergyWh = deliveredEnergyWh;
    result.earnedAmount = earnedAmount;
    result.deliveryStatus =
      deliveredPowerW <= 0 ? 'not_delivered' : creditedPowerW >= awardedPowerW ? 'delivered' : 'partial';
  }

  await db
    .update(flexibilityAwards)
    .set({
      deliveryStatus: result.deliveryStatus,
      baselinePowerW: result.baselinePowerW,
      baselineSamples: result.baselineSamples,
      measuredPowerW: result.measuredPowerW,
      measuredSamples: result.measuredSamples,
      deliveredPowerW: result.deliveredPowerW,
      deliveredEnergyWh: result.deliveredEnergyWh,
      earnedAmount: result.earnedAmount,
      measuredAt: at,
      measurement: {
        windowStartsAt: startsAt.toISOString(),
        windowEndsAt: endsAt.toISOString(),
        durationMinutes: durationHours * 60,
        direction,
        baselineMethod: BASELINE_METHOD,
        baselineDays: result.baselineDays,
        creditedPowerW: result.creditedPowerW,
        unverifiedReason: result.unverifiedReason,
      },
      updatedAt: new Date(),
    })
    .where(eq(flexibilityAwards.id, awardId));

  return result;
}

/** UTC clock time of a timestamp, matching the timestamp columns' own basis. */
export function clockTimeOf(at: Date): string {
  return at.toISOString().slice(11, 19);
}

/** Signed reduction the requirement asked for, watts. Telemetry is generation-positive. */
export function reductionWatts(
  direction: FlexibilityDirection,
  baselinePowerW: number,
  measuredPowerW: number
): number {
  // Net import is the negation of generation-positive power, so reducing import
  // means measured power rose above baseline; reducing export means it fell.
  return direction === 'import_reduction'
    ? measuredPowerW - baselinePowerW
    : baselinePowerW - measuredPowerW;
}

/** Why a measurement cannot be trusted, or null when it can. */
export function unverifiedMeasurementReason(input: {
  measuredSamples: number;
  baselineSamples: number;
  baselineDays: number;
}): string | null {
  if (input.measuredSamples < MIN_DELIVERY_SAMPLES) {
    return `Only ${input.measuredSamples} telemetry samples in the delivery window (need ${MIN_DELIVERY_SAMPLES})`;
  }
  if (input.baselineSamples < MIN_BASELINE_SAMPLES) {
    return `Only ${input.baselineSamples} baseline samples (need ${MIN_BASELINE_SAMPLES})`;
  }
  if (input.baselineDays < MIN_BASELINE_DAYS) {
    return `Baseline covers ${input.baselineDays} comparable days (need ${MIN_BASELINE_DAYS})`;
  }
  return null;
}

/** Measure every award on a requirement, leaving each award's own verdict intact. */
export async function measureRequirement(
  requirementId: number,
  now?: Date
): Promise<MeasurementResult[]> {
  const db = await requireDb();
  const awardRows = await db
    .select({ id: flexibilityAwards.id })
    .from(flexibilityAwards)
    .where(eq(flexibilityAwards.requirementId, requirementId))
    .orderBy(asc(flexibilityAwards.id));

  const results: MeasurementResult[] = [];
  for (const award of awardRows) {
    results.push(await measureAward(award.id, now));
  }
  return results;
}

/**
 * Settle one measured award into the hash-chained ledger.
 *
 * Refuses anything not measured as delivery, refuses a second settlement of the
 * same award, and pays the measured reduction rather than the award: a site that
 * delivered 60% of its block is paid for 60%.
 *
 * The award is claimed with a conditional update before the ledger event is
 * written, so two concurrent settlements of one award cannot both pass the
 * "not settled yet" check and pay it twice. The claim is released if the ledger
 * write fails, leaving the award settleable again.
 */
export async function settleAward(
  awardId: number
): Promise<{ awardId: number; settlementEventId: number; amount: number }> {
  // Delivered energy is measured from telemetry. If that path is down — or has
  // not been seen recently enough to know — the amount below is arithmetic on
  // stale rows, not a measurement, so the payout is refused rather than made.
  const posture = await requireCapability('flexibility_settlement');
  const db = await requireDb();
  const rows = await db.execute<SqlRow>(sql`
    SELECT
      w.id,
      w.user_id,
      w.asset_id,
      w.requirement_id,
      w.delivery_status::text AS delivery_status,
      w.delivered_energy_wh,
      w.delivered_power_w,
      w.awarded_power_w,
      w.price_cents_per_kwh,
      w.settlement_event_id,
      r.currency,
      r.direction::text AS direction,
      r.starts_at,
      r.ends_at
    FROM flexibility_awards w
    JOIN flexibility_requirements r ON r.id = w.requirement_id
    WHERE w.id = ${awardId}
    LIMIT 1
  `);
  const award = (rows.rows ?? [])[0];
  if (!award) {
    throw new LocationalFlexibilityError(`Unknown award ${awardId}`);
  }
  if (award.settlement_event_id !== null) {
    throw new LocationalFlexibilityError(
      `Award ${awardId} was already settled as event ${award.settlement_event_id}`
    );
  }
  const status = String(award.delivery_status);
  if (status !== 'delivered' && status !== 'partial') {
    throw new LocationalFlexibilityError(
      `Award ${awardId} is ${status}: only measured delivery can be settled`
    );
  }
  const energyWh = Number(award.delivered_energy_wh ?? 0);
  if (energyWh <= 0) {
    throw new LocationalFlexibilityError(`Award ${awardId} measured no delivered energy`);
  }

  const currency = String(award.currency) as 'NGN' | 'TZS' | 'USD';
  const startsAt = new Date(String(award.starts_at));
  const endsAt = new Date(String(award.ends_at));
  // The ledger records whole minutes; a window shorter than one is recorded as
  // the minute it fell inside rather than as no duration at all. The money comes
  // from the measured energy, not from this figure.
  const windowMs = endsAt.getTime() - startsAt.getTime();
  const durationMinutes = windowMs > 0 ? Math.max(1, Math.round(windowMs / 60_000)) : 0;
  const priceCentsPerKwh = Number(award.price_cents_per_kwh);
  // Cents-per-kWh x100 in the market tables; the ledger stores plain rate units.
  const ratePerUnit = Math.round(priceCentsPerKwh / PRICE_SCALE);
  const grossAmount = Math.round(((energyWh / 1000) * priceCentsPerKwh) / PRICE_SCALE);

  // Claim the award before any money is written. Whoever wins this conditional
  // update owns the settlement; a loser sees no row and stops, instead of
  // writing a second paid ledger event for the same delivered window.
  const claimedAt = new Date();
  const claim = await db.execute<SqlRow>(sql`
    UPDATE flexibility_awards
    SET settled_at = ${claimedAt}, updated_at = ${claimedAt}
    WHERE id = ${awardId} AND settlement_event_id IS NULL AND settled_at IS NULL
    RETURNING id
  `);
  if ((claim.rows ?? []).length === 0) {
    throw new LocationalFlexibilityError(
      `Award ${awardId} is already being settled or has been settled`
    );
  }

  let event: { id: number };
  try {
    event = await settlementLedger.createEvent({
      eventType: 'service_delivered',
      userId: Number(award.user_id),
      sourceType: 'flexibility_award',
      sourceId: awardId,
      energyWh,
      powerKw: Number(award.delivered_power_w ?? 0) / 1000,
      durationMinutes,
      ratePerUnit,
      grossAmount,
      fees: 0,
      netAmount: grossAmount,
      currency,
      measurementMethod: 'baseline_comparison',
      baselineMethod: BASELINE_METHOD,
      eventData: {
        serviceType: 'locational_flexibility',
        requirementId: Number(award.requirement_id),
        assetId: Number(award.asset_id),
        direction: String(award.direction),
        awardedPowerW: Number(award.awarded_power_w),
        deliveredPowerW: Number(award.delivered_power_w ?? 0),
        deliveryStatus: status,
      },
    });
  } catch (error) {
    // No ledger event was written, so the claim must not stand: releasing it
    // leaves the award settleable rather than stranding a delivered window as
    // settled-but-unpaid.
    await db.execute(sql`
      UPDATE flexibility_awards
      SET settled_at = NULL, updated_at = ${new Date()}
      WHERE id = ${awardId} AND settlement_event_id IS NULL
    `);
    throw error;
  }

  await db
    .update(flexibilityAwards)
    .set({
      settlementEventId: event.id,
      updatedAt: new Date(),
    })
    .where(eq(flexibilityAwards.id, awardId));

  if (posture.posture === 'degraded') {
    // The deployment chose to keep paying while blind to the meter path. The
    // payment stands, but it is written down as unproven so an auditor can find
    // every amount that was paid without a current measurement path.
    await recordDegradedAction({
      capability: 'flexibility_settlement',
      subject: `flexibility_award:${awardId}`,
      missingDependencies: posture.missing,
      evidenceLimit: posture.evidenceLimit ?? 'delivery measurement path unavailable',
    });
  }

  return { awardId, settlementEventId: event.id, amount: grossAmount };
}

export interface RequirementView {
  id: number;
  nodeId: number;
  nodeCode: string;
  nodeName: string;
  region: string | null;
  direction: FlexibilityDirection;
  status: string;
  startsAt: Date;
  endsAt: Date;
  requiredPowerW: number;
  clearedPowerW: number;
  priceCapCentsPerKwh: number;
  clearingPriceCentsPerKwh: number | null;
  currency: string;
  offers: number;
  /** Offers stored but not clearable, e.g. an unverified node link. */
  ineligibleOffers: number;
  awards: number;
  /** Awarded capacity whose delivery could not be measured. */
  unverifiedAwards: number;
  deliveredEnergyWh: number;
}

/** Requirements at a node, or across all nodes in a region. */
export async function listRequirements(filter: {
  nodeId?: number;
  region?: string;
  limit?: number;
}): Promise<RequirementView[]> {
  const db = await requireDb();
  const limit = filter.limit ?? 50;
  const nodeFilter =
    filter.nodeId !== undefined
      ? sql`r.node_id = ${filter.nodeId}`
      : filter.region !== undefined
        ? sql`n.region = ${filter.region}`
        : sql`TRUE`;

  const rows = await db.execute<SqlRow>(sql`
    SELECT
      r.id,
      r.node_id,
      n.code AS node_code,
      n.name AS node_name,
      n.region,
      r.direction::text AS direction,
      r.status::text AS status,
      r.starts_at,
      r.ends_at,
      r.required_power_w,
      r.cleared_power_w,
      r.price_cap_cents_per_kwh,
      r.clearing_price_cents_per_kwh,
      r.currency,
      (SELECT COUNT(*) FROM flexibility_offers o WHERE o.requirement_id = r.id)::int AS offers,
      (SELECT COUNT(*) FROM flexibility_offers o
        WHERE o.requirement_id = r.id AND o.status = 'ineligible')::int AS ineligible_offers,
      (SELECT COUNT(*) FROM flexibility_awards w WHERE w.requirement_id = r.id)::int AS awards,
      (SELECT COUNT(*) FROM flexibility_awards w
        WHERE w.requirement_id = r.id AND w.delivery_status = 'unverified')::int AS unverified_awards,
      (SELECT COALESCE(SUM(w.delivered_energy_wh), 0) FROM flexibility_awards w
        WHERE w.requirement_id = r.id)::bigint AS delivered_energy_wh
    FROM flexibility_requirements r
    JOIN grid_nodes n ON n.id = r.node_id
    WHERE ${nodeFilter}
    ORDER BY r.starts_at DESC
    LIMIT ${limit}
  `);

  return (rows.rows ?? []).map(row => ({
    id: Number(row.id),
    nodeId: Number(row.node_id),
    nodeCode: String(row.node_code),
    nodeName: String(row.node_name),
    region: row.region === null ? null : String(row.region),
    direction: String(row.direction) as FlexibilityDirection,
    status: String(row.status),
    startsAt: new Date(String(row.starts_at)),
    endsAt: new Date(String(row.ends_at)),
    requiredPowerW: Number(row.required_power_w),
    clearedPowerW: Number(row.cleared_power_w),
    priceCapCentsPerKwh: Number(row.price_cap_cents_per_kwh),
    clearingPriceCentsPerKwh:
      row.clearing_price_cents_per_kwh === null
        ? null
        : Number(row.clearing_price_cents_per_kwh),
    currency: String(row.currency),
    offers: Number(row.offers),
    ineligibleOffers: Number(row.ineligible_offers),
    awards: Number(row.awards),
    unverifiedAwards: Number(row.unverified_awards),
    deliveredEnergyWh: Number(row.delivered_energy_wh),
  }));
}

export interface OwnerAwardView {
  awardId: number;
  requirementId: number;
  assetId: number;
  nodeCode: string;
  direction: FlexibilityDirection;
  startsAt: Date;
  endsAt: Date;
  awardedPowerW: number;
  priceCentsPerKwh: number;
  currency: string;
  deliveryStatus: DeliveryStatus;
  baselinePowerW: number | null;
  measuredPowerW: number | null;
  measuredSamples: number;
  deliveredPowerW: number | null;
  deliveredEnergyWh: number | null;
  earnedAmount: number | null;
  settled: boolean;
  unverifiedReason: string | null;
}

/** One owner's awards, with the measurement behind each figure. */
export async function listOwnerAwards(
  userId: number,
  limit = 25
): Promise<OwnerAwardView[]> {
  const db = await requireDb();
  const rows = await db.execute<SqlRow>(sql`
    SELECT
      w.id,
      w.requirement_id,
      w.asset_id,
      n.code AS node_code,
      r.direction::text AS direction,
      r.starts_at,
      r.ends_at,
      r.currency,
      w.awarded_power_w,
      w.price_cents_per_kwh,
      w.delivery_status::text AS delivery_status,
      w.baseline_power_w,
      w.measured_power_w,
      w.measured_samples,
      w.delivered_power_w,
      w.delivered_energy_wh,
      w.earned_amount,
      w.settlement_event_id,
      w.measurement
    FROM flexibility_awards w
    JOIN flexibility_requirements r ON r.id = w.requirement_id
    JOIN grid_nodes n ON n.id = r.node_id
    WHERE w.user_id = ${userId}
    ORDER BY r.starts_at DESC
    LIMIT ${limit}
  `);

  return (rows.rows ?? []).map(row => {
    const measurement = (row.measurement ?? null) as { unverifiedReason?: string | null } | null;
    return {
      awardId: Number(row.id),
      requirementId: Number(row.requirement_id),
      assetId: Number(row.asset_id),
      nodeCode: String(row.node_code),
      direction: String(row.direction) as FlexibilityDirection,
      startsAt: new Date(String(row.starts_at)),
      endsAt: new Date(String(row.ends_at)),
      awardedPowerW: Number(row.awarded_power_w),
      priceCentsPerKwh: Number(row.price_cents_per_kwh),
      currency: String(row.currency),
      deliveryStatus: String(row.delivery_status) as DeliveryStatus,
      baselinePowerW: row.baseline_power_w === null ? null : Number(row.baseline_power_w),
      measuredPowerW: row.measured_power_w === null ? null : Number(row.measured_power_w),
      measuredSamples: Number(row.measured_samples),
      deliveredPowerW: row.delivered_power_w === null ? null : Number(row.delivered_power_w),
      deliveredEnergyWh:
        row.delivered_energy_wh === null ? null : Number(row.delivered_energy_wh),
      earnedAmount: row.earned_amount === null ? null : Number(row.earned_amount),
      settled: row.settlement_event_id !== null,
      unverifiedReason: measurement?.unverifiedReason ?? null,
    };
  });
}

export interface NodeHeadroomView {
  nodeId: number;
  code: string;
  name: string;
  kind: GridNodeKind;
  region: string | null;
  firmCapacityW: number | null;
  linkedAssets: number;
  /** Assets whose link nobody has verified: capacity we cannot sell here. */
  unverifiedAssets: number;
  /**
   * Assets that could actually be awarded here: verified link and active. An
   * inactive asset counts as linked but not as awardable, which is why this is
   * not `linkedAssets - unverifiedAssets`.
   */
  awardableAssets: number;
  /** Rated capacity of awardable assets, watts. Not a measured availability. */
  awardableRatedW: number;
  unverifiedRatedW: number;
  openRequirements: number;
}

/**
 * What a node could offer on paper. Rated capacity is not availability: an asset
 * rated 5 kW that is silent or empty delivers nothing, which is why awards are
 * still measured one by one.
 */
export async function listNodeHeadroom(region?: string): Promise<NodeHeadroomView[]> {
  const db = await requireDb();
  const regionFilter = region === undefined ? sql`TRUE` : sql`n.region = ${region}`;
  const rows = await db.execute<SqlRow>(sql`
    SELECT
      n.id,
      n.code,
      n.name,
      n.kind::text AS kind,
      n.region,
      n.firm_capacity_w,
      COUNT(l.id)::int AS linked_assets,
      COALESCE(SUM(CASE WHEN l.link_source = 'unverified' THEN 1 ELSE 0 END), 0)::int AS unverified_assets,
      -- Counted on exactly the condition the awardable watts are summed on, so a
      -- verified but inactive asset raises neither figure.
      COALESCE(SUM(CASE WHEN l.link_source <> 'unverified' AND a.status = 'active'
        THEN 1 ELSE 0 END), 0)::int AS awardable_assets,
      COALESCE(SUM(CASE WHEN l.link_source <> 'unverified' AND a.status = 'active'
        THEN a.capacity ELSE 0 END), 0)::bigint AS awardable_rated_w,
      COALESCE(SUM(CASE WHEN l.link_source = 'unverified' THEN a.capacity ELSE 0 END), 0)::bigint AS unverified_rated_w,
      (SELECT COUNT(*) FROM flexibility_requirements r
        WHERE r.node_id = n.id AND r.status = 'open')::int AS open_requirements
    FROM grid_nodes n
    LEFT JOIN grid_node_assets l ON l.node_id = n.id
    LEFT JOIN assets a ON a.id = l.asset_id
    WHERE ${regionFilter}
    GROUP BY n.id, n.code, n.name, n.kind, n.region, n.firm_capacity_w
    ORDER BY n.code ASC
  `);

  return (rows.rows ?? []).map(row => ({
    nodeId: Number(row.id),
    code: String(row.code),
    name: String(row.name),
    kind: String(row.kind) as GridNodeKind,
    region: row.region === null ? null : String(row.region),
    firmCapacityW: row.firm_capacity_w === null ? null : Number(row.firm_capacity_w),
    linkedAssets: Number(row.linked_assets),
    unverifiedAssets: Number(row.unverified_assets),
    awardableAssets: Number(row.awardable_assets),
    awardableRatedW: Number(row.awardable_rated_w),
    unverifiedRatedW: Number(row.unverified_rated_w),
    openRequirements: Number(row.open_requirements),
  }));
}

/** Open requirements an owner's assets could offer into, by node link. */
export async function listOpenRequirementsForOwner(
  userId: number,
  now?: Date
): Promise<
  Array<{
    requirementId: number;
    assetId: number;
    assetName: string;
    assetCapacityW: number;
    nodeCode: string;
    linkSource: NodeLinkSource;
    direction: FlexibilityDirection;
    startsAt: Date;
    endsAt: Date;
    requiredPowerW: number;
    priceCapCentsPerKwh: number;
    currency: string;
    alreadyOffered: boolean;
  }>
> {
  const db = await requireDb();
  const at = now ?? new Date();
  const rows = await db.execute<SqlRow>(sql`
    SELECT
      r.id AS requirement_id,
      a.id AS asset_id,
      a.name AS asset_name,
      a.capacity AS asset_capacity,
      n.code AS node_code,
      l.link_source::text AS link_source,
      r.direction::text AS direction,
      r.starts_at,
      r.ends_at,
      r.required_power_w,
      r.price_cap_cents_per_kwh,
      r.currency,
      EXISTS (
        SELECT 1 FROM flexibility_offers o
        WHERE o.requirement_id = r.id AND o.asset_id = a.id
      ) AS already_offered
    FROM flexibility_requirements r
    JOIN grid_nodes n ON n.id = r.node_id
    JOIN grid_node_assets l ON l.node_id = r.node_id
    JOIN assets a ON a.id = l.asset_id
    WHERE r.status = 'open'
      AND r.starts_at > ${at}
      AND a."userId" = ${userId}
      AND a.status = 'active'
    ORDER BY r.starts_at ASC
  `);

  return (rows.rows ?? []).map(row => ({
    requirementId: Number(row.requirement_id),
    assetId: Number(row.asset_id),
    assetName: String(row.asset_name),
    assetCapacityW: Number(row.asset_capacity),
    nodeCode: String(row.node_code),
    linkSource: String(row.link_source) as NodeLinkSource,
    direction: String(row.direction) as FlexibilityDirection,
    startsAt: new Date(String(row.starts_at)),
    endsAt: new Date(String(row.ends_at)),
    requiredPowerW: Number(row.required_power_w),
    priceCapCentsPerKwh: Number(row.price_cap_cents_per_kwh),
    currency: String(row.currency),
    alreadyOffered: Boolean(row.already_offered),
  }));
}
