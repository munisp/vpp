/**
 * Price-signal dispatch: co-optimising the grid's objective and the customer's.
 *
 * A setpoint pushed to a site assumes the aggregator knows that site's load,
 * comfort and constraints. A price does not. Here the aggregator solves for the
 * price that makes the fleet *want* the profile the grid asked for: each site
 * still runs its own MILP against its own private load and assets, and the
 * aggregator learns what the fleet intends by aggregating the returned plans.
 *
 * Three facts are kept apart, because only the third is evidence:
 *   1. the signal we published,
 *   2. the plan each site returned under it,
 *   3. what the site's meter actually did.
 *
 * A signal is not a control: it has no validity window and no fallback, and
 * following it is voluntary. Anything that must happen goes through the bounded
 * control path in control-validity.ts instead.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';

import { getDb } from '../db';
import { assets } from '../../drizzle/schema';
import {
  priceSignalIntervals,
  priceSignalSites,
  priceSignals,
} from '../../drizzle/price-signal-schema';
import { mqttBrokerService } from '../integration/mqtt-broker';
import {
  CoordinationResponse,
  MilpAsset,
  MilpDispatchRequest,
  MilpDispatchResponse,
  MilpOptimizerError,
  solveCoordination,
} from './milp-dispatch';
import { probabilisticForecasting } from './probabilistic-forecasting';
import type { SqlRow } from '../sql-row';

/** Minimum telemetry history before a site's load forecast is usable. */
export const MIN_SITE_HISTORY_SAMPLES = 48;
/** Fraction of the planned energy a site may miss and still count as following. */
export const RESPONSE_TOLERANCE_FRACTION = 0.1;
/** Floor on that tolerance so a near-zero plan is not impossible to satisfy. */
export const RESPONSE_TOLERANCE_FLOOR_WH = 250;
/** Money and price scale: cents/kWh x100, matching the forecast metric columns. */
const PRICE_SCALE = 100;

export class PriceSignalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriceSignalError';
  }
}

export interface FleetSite {
  /** Site key as sent to the optimizer, e.g. `user-42`. */
  siteRef: string;
  userId: number;
  request: MilpDispatchRequest;
}

export interface ExcludedSite {
  siteRef: string;
  userId: number;
  /** Why the site could not take part. Never silently dropped. */
  reason: string;
}

export interface FleetSignalScope {
  scopeType: 'fleet' | 'community' | 'region';
  scopeId?: number;
  region?: string;
}

export interface BuildFleetSitesInput extends FleetSignalScope {
  userIds: number[];
  horizon: number;
  intervalMinutes: number;
  /** Per-site connection limits, watts. Sites are metered, not modelled. */
  siteImportLimitW: number;
  siteExportLimitW: number;
}

export interface FleetSignalIntervalView {
  intervalIndex: number;
  startsAt: Date;
  baseImportPriceCentsPerKwh: number;
  /** Signed coordination component; negative pays sites to absorb energy. */
  signalAdjustmentCentsPerKwh: number;
  targetNetW: number | null;
  plannedNetW: number;
}

export interface FleetSignalSiteView {
  siteRef: string;
  userId: number | null;
  plannedNetWh: number;
  plannedBillCents: number;
  delivery: 'pending' | 'broker_queued' | 'failed';
  deliveryDetail: string | null;
  response: 'unmeasured' | 'followed' | 'deviated' | 'no_telemetry';
  actualNetWh: number | null;
  telemetrySamples: number;
}

export interface FleetSignalView {
  signalId: string;
  status: 'draft' | 'published' | 'scored' | 'not_converged';
  scopeType: string;
  scopeId: number | null;
  region: string | null;
  intervalMinutes: number;
  startsAt: Date;
  endsAt: Date;
  solver: string;
  iterations: number;
  maxDeviationW: number;
  intervals: FleetSignalIntervalView[];
  sites: FleetSignalSiteView[];
  publishedAt: Date | null;
  scoredAt: Date | null;
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new PriceSignalError('Database not available');
  return db;
}

/**
 * Assemble the per-site optimization problems from real site data.
 *
 * A site with no measured history is excluded rather than given an assumed load
 * profile: the seasonal model returns zeros for an empty history, and a fleet
 * plan built on zero-load sites would look solved while committing capacity that
 * does not exist.
 */
export async function buildFleetSites(
  input: BuildFleetSitesInput
): Promise<{
  sites: FleetSite[];
  excluded: ExcludedSite[];
  baseImportPricesCentsPerKwh: number[];
}> {
  const db = await requireDb();
  if (input.userIds.length === 0) {
    throw new PriceSignalError('A fleet signal needs at least one participating site');
  }

  const horizonHours = (input.horizon * input.intervalMinutes) / 60;
  const priceForecast = await probabilisticForecasting.forecastPrice(
    input.region ?? 'NG-LAGOS',
    horizonHours,
    input.intervalMinutes
  );
  if (priceForecast.points.length < input.horizon) {
    throw new PriceSignalError(
      `Price forecast covers ${priceForecast.points.length} of ${input.horizon} intervals; ` +
        'refusing to price a horizon it does not cover'
    );
  }
  const importPrices = priceForecast.points.slice(0, input.horizon).map(point => point.values.p50);

  const assetRows = await db
    .select({
      id: assets.id,
      userId: assets.userId,
      assetType: assets.assetType,
      capacity: assets.capacity,
    })
    .from(assets)
    .where(and(inArray(assets.userId, input.userIds), eq(assets.status, 'active')));

  const historyCounts = await db.execute<SqlRow>(sql`
    SELECT a."userId" AS user_id, COUNT(*)::int AS samples
    FROM telemetry t
    JOIN assets a ON a.id = t."assetId"
    WHERE a."userId" IN ${input.userIds}
      AND t.timestamp >= NOW() - INTERVAL '30 days'
    GROUP BY a."userId"
  `);
  const samplesByUser = new Map<number, number>();
  for (const row of historyCounts.rows ?? []) {
    samplesByUser.set(Number(row.user_id), Number(row.samples));
  }

  const sites: FleetSite[] = [];
  const excluded: ExcludedSite[] = [];

  for (const userId of input.userIds) {
    const siteRef = `user-${userId}`;
    const samples = samplesByUser.get(userId) ?? 0;
    if (samples < MIN_SITE_HISTORY_SAMPLES) {
      excluded.push({
        siteRef,
        userId,
        reason: `only ${samples} telemetry samples in the last 30 days (need ${MIN_SITE_HISTORY_SAMPLES}); its load is unknown`,
      });
      continue;
    }

    const siteAssets = assetRows.filter(row => row.userId === userId);
    const milpAssets: MilpAsset[] = [];
    for (const asset of siteAssets) {
      if (asset.capacity <= 0) continue;
      if (asset.assetType === 'battery') {
        milpAssets.push({
          asset_id: String(asset.id),
          asset_type: 'battery',
          // `assets.capacity` is watt-hours for batteries (drizzle/schema.ts).
          // Power limits are unmodelled here, so a 1C bound is used and the
          // battery is never asked for more than its own rating.
          battery: {
            capacity_wh: asset.capacity,
            max_charge_w: asset.capacity,
            max_discharge_w: asset.capacity,
            initial_soc_percent: 50,
          },
        });
      }
    }

    const loadForecast = await probabilisticForecasting.forecastLoad(
      { userId },
      horizonHours,
      input.intervalMinutes
    );
    const loadPoints = loadForecast.points.slice(0, input.horizon);
    if (loadPoints.length < input.horizon) {
      excluded.push({
        siteRef,
        userId,
        reason: `load forecast covers ${loadPoints.length} of ${input.horizon} intervals`,
      });
      continue;
    }
    const loadW = loadPoints.map(point => Math.max(0, point.values.p50));
    if (loadW.every(value => value === 0)) {
      excluded.push({
        siteRef,
        userId,
        reason: 'load forecast is zero across the horizon, so the site has nothing to shift',
      });
      continue;
    }

    sites.push({
      siteRef,
      userId,
      request: {
        interval_minutes: input.intervalMinutes,
        site: {
          site_id: siteRef,
          assets: milpAssets,
          load_w: loadW,
          max_import_w: input.siteImportLimitW,
          max_export_w: input.siteExportLimitW,
        },
        prices: {
          // Export is priced on the same curve as import: the platform has no
          // separate feed-in tariff feed, and inventing one would change what
          // sites are paid. Same assumption as the single-site MILP path.
          import_cents_per_kwh: importPrices,
          export_cents_per_kwh: importPrices,
        },
        objective: 'minimize_cost',
      },
    });
  }

  if (sites.length === 0) {
    throw new PriceSignalError(
      `No participating site has enough measured history to be coordinated (${excluded.length} excluded)`
    );
  }

  return { sites, excluded, baseImportPricesCentsPerKwh: importPrices };
}

function netImportW(plan: MilpDispatchResponse, index: number): number {
  const interval = plan.intervals.find(item => item.index === index);
  if (!interval) {
    throw new PriceSignalError(`Site plan is missing interval ${index}`);
  }
  return interval.grid_import_w - interval.grid_export_w;
}

export interface CoordinateFleetSignalInput extends FleetSignalScope {
  sites: FleetSite[];
  intervalMinutes: number;
  startsAt: Date;
  /** Aggregate net import the grid asked for, per interval (watts). */
  targetNetW: number[];
  /** Hard aggregate cap; the target may not exceed it. */
  sharedImportLimitW: number[];
  createdBy?: number;
  /** Tariff the fleet would have seen with no coordination, cents/kWh. */
  baseImportPricesCentsPerKwh: number[];
}

/**
 * Solve for the price that makes the fleet follow `targetNetW`, and store the
 * signal with the plans it produced.
 *
 * A coordination that did not converge is stored with status `not_converged`
 * and is never publishable: publishing a price that misses its own target moves
 * the fleet somewhere nobody asked for.
 */
export async function coordinateFleetSignal(
  input: CoordinateFleetSignalInput
): Promise<{ signalId: string; converged: boolean; result: CoordinationResponse }> {
  const db = await requireDb();
  const horizon = input.targetNetW.length;
  if (horizon === 0) {
    throw new PriceSignalError('A fleet signal needs a target profile');
  }
  if (input.sharedImportLimitW.length !== horizon) {
    throw new PriceSignalError('sharedImportLimitW must cover the same horizon as the target');
  }
  if (input.baseImportPricesCentsPerKwh.length !== horizon) {
    throw new PriceSignalError('baseImportPricesCentsPerKwh must cover the same horizon');
  }
  for (const site of input.sites) {
    if (site.request.site.load_w.length !== horizon) {
      throw new PriceSignalError(
        `Site ${site.siteRef} covers ${site.request.site.load_w.length} intervals, target covers ${horizon}`
      );
    }
  }

  const result = await solveCoordination({
    sites: input.sites.map(site => ({ request: site.request })),
    shared_import_limit_w: input.sharedImportLimitW,
    shared_import_target_w: input.targetNetW,
  });

  if (result.status !== 'optimal' && result.status !== 'not_converged') {
    throw new MilpOptimizerError(
      `coordination returned status ${result.status}; no fleet plan to price against`,
      { solveStatus: result.status }
    );
  }
  if (result.sites.length !== input.sites.length) {
    throw new PriceSignalError(
      `coordination returned ${result.sites.length} plans for ${input.sites.length} sites`
    );
  }

  const deviation = result.target_deviation_w;
  if (deviation === null) {
    throw new PriceSignalError(
      'coordination reported no target deviation, so its distance from the requested profile is unknown'
    );
  }

  const signalId = `psig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const intervalMs = input.intervalMinutes * 60_000;
  const endsAt = new Date(input.startsAt.getTime() + horizon * intervalMs);
  const status = result.converged ? 'draft' : 'not_converged';
  const maxDeviationW = Math.round(Math.max(...deviation.map(value => Math.abs(value))));

  await db.insert(priceSignals).values({
    signalId,
    scopeType: input.scopeType,
    scopeId: input.scopeId ?? null,
    region: input.region ?? null,
    status,
    intervalMinutes: input.intervalMinutes,
    startsAt: input.startsAt,
    endsAt,
    solver: result.solver,
    iterations: result.iterations,
    maxDeviationWatts: maxDeviationW,
    createdBy: input.createdBy ?? null,
  });

  await db.insert(priceSignalIntervals).values(
    Array.from({ length: horizon }, (_, index) => ({
      signalId,
      intervalIndex: index,
      startsAt: new Date(input.startsAt.getTime() + index * intervalMs),
      baseImportPriceValue: Math.round(input.baseImportPricesCentsPerKwh[index] * PRICE_SCALE),
      signalAdjustmentValue: Math.round(
        (result.shadow_prices_cents_per_kwh[index] ?? 0) * PRICE_SCALE
      ),
      targetNetWatts: Math.round(input.targetNetW[index]),
      plannedNetWatts: Math.round(result.aggregate_net_w[index] ?? 0),
    }))
  );

  const intervalHours = input.intervalMinutes / 60;
  await db.insert(priceSignalSites).values(
    input.sites.map((site, siteIndex) => {
      const plan = result.sites[siteIndex];
      const perInterval = Array.from({ length: horizon }, (_, index) =>
        Math.round(netImportW(plan, index))
      );
      return {
        signalId,
        siteRef: site.siteRef,
        userId: site.userId,
        plannedNetWatts: perInterval,
        plannedNetWh: Math.round(
          perInterval.reduce((sum, watts) => sum + watts * intervalHours, 0)
        ),
        plannedBillCents: Math.round(plan.totals.objective_value_cents),
      };
    })
  );

  return { signalId, converged: result.converged, result };
}

/**
 * Offer a stored signal to its sites.
 *
 * MQTT gives no receipt, so a successful publish is recorded as `broker_queued`
 * and never as evidence that the site received or accepted the price.
 */
export async function publishFleetSignal(
  signalId: string
): Promise<{ queued: number; failed: number }> {
  const db = await requireDb();
  const signalRows = await db
    .select()
    .from(priceSignals)
    .where(eq(priceSignals.signalId, signalId))
    .limit(1);
  const signal = signalRows[0];
  if (!signal) throw new PriceSignalError(`Signal ${signalId} not found`);
  if (signal.status === 'not_converged') {
    throw new PriceSignalError(
      `Signal ${signalId} missed its own target by ${signal.maxDeviationWatts} W and will not be published`
    );
  }
  if (signal.status === 'scored') {
    throw new PriceSignalError(`Signal ${signalId} has already been scored`);
  }

  const intervals = await db
    .select()
    .from(priceSignalIntervals)
    .where(eq(priceSignalIntervals.signalId, signalId))
    .orderBy(priceSignalIntervals.intervalIndex);
  const siteRows = await db
    .select()
    .from(priceSignalSites)
    .where(eq(priceSignalSites.signalId, signalId));

  const schedule = intervals.map(interval => ({
    starts_at: interval.startsAt.toISOString(),
    /** What the site pays per kWh in this interval if it imports. */
    import_cents_per_kwh:
      (interval.baseImportPriceValue + interval.signalAdjustmentValue) / PRICE_SCALE,
    signal_cents_per_kwh: interval.signalAdjustmentValue / PRICE_SCALE,
  }));

  let queued = 0;
  let failed = 0;
  for (const site of siteRows) {
    try {
      await mqttBrokerService.publishSiteSignal(site.siteRef, {
        signal_id: signalId,
        interval_minutes: signal.intervalMinutes,
        starts_at: signal.startsAt.toISOString(),
        ends_at: signal.endsAt.toISOString(),
        schedule,
      });
      await db
        .update(priceSignalSites)
        .set({ delivery: 'broker_queued', deliveryDetail: null, deliveredAt: new Date() })
        .where(eq(priceSignalSites.id, site.id));
      queued += 1;
    } catch (error) {
      await db
        .update(priceSignalSites)
        .set({
          delivery: 'failed',
          deliveryDetail: (error instanceof Error ? error.message : String(error)).slice(0, 255),
          deliveredAt: null,
        })
        .where(eq(priceSignalSites.id, site.id));
      failed += 1;
    }
  }

  if (queued > 0) {
    await db
      .update(priceSignals)
      .set({ status: 'published', publishedAt: new Date() })
      .where(eq(priceSignals.signalId, signalId));
  }

  return { queued, failed };
}

/**
 * Compare each site's metered energy over the window with the plan it returned.
 *
 * Telemetry is generation-positive (see community-energy.ts), so net import is
 * the negated sum. A window with no telemetry scores `no_telemetry`: that is an
 * absence of evidence, not compliance and not a breach.
 */
export async function scoreFleetSignalResponse(signalId: string): Promise<FleetSignalSiteView[]> {
  const db = await requireDb();
  const signalRows = await db
    .select()
    .from(priceSignals)
    .where(eq(priceSignals.signalId, signalId))
    .limit(1);
  const signal = signalRows[0];
  if (!signal) throw new PriceSignalError(`Signal ${signalId} not found`);
  if (signal.publishedAt === null) {
    throw new PriceSignalError(`Signal ${signalId} was never published, so no site was asked`);
  }
  if (signal.endsAt.getTime() > Date.now()) {
    throw new PriceSignalError(
      `Signal ${signalId} runs until ${signal.endsAt.toISOString()}; scoring it now would measure a partial window`
    );
  }

  const siteRows = await db
    .select()
    .from(priceSignalSites)
    .where(eq(priceSignalSites.signalId, signalId));
  const windowHours = (signal.endsAt.getTime() - signal.startsAt.getTime()) / 3_600_000;
  const scoredAt = new Date();

  for (const site of siteRows) {
    if (site.userId === null) {
      throw new PriceSignalError(
        `Site ${site.siteRef} has no user id, so its meter cannot be identified`
      );
    }
    const measured = await db.execute<SqlRow>(sql`
      SELECT COUNT(*)::int AS samples, COALESCE(SUM(t.power), 0)::float AS power_sum
      FROM telemetry t
      JOIN assets a ON a.id = t."assetId"
      WHERE a."userId" = ${site.userId}
        AND t.timestamp >= ${signal.startsAt}
        AND t.timestamp < ${signal.endsAt}
    `);
    const row = measured.rows?.[0];
    const samples = row ? Number(row.samples) : 0;

    if (samples === 0) {
      await db
        .update(priceSignalSites)
        .set({ response: 'no_telemetry', actualNetWh: null, telemetrySamples: 0, scoredAt })
        .where(eq(priceSignalSites.id, site.id));
      continue;
    }

    const meanNetW = -(Number(row?.power_sum ?? 0) / samples);
    const actualNetWh = Math.round(meanNetW * windowHours);
    const tolerance = Math.max(
      RESPONSE_TOLERANCE_FLOOR_WH,
      Math.abs(site.plannedNetWh) * RESPONSE_TOLERANCE_FRACTION
    );
    const followed = Math.abs(actualNetWh - site.plannedNetWh) <= tolerance;

    await db
      .update(priceSignalSites)
      .set({
        response: followed ? 'followed' : 'deviated',
        actualNetWh,
        telemetrySamples: samples,
        scoredAt,
      })
      .where(eq(priceSignalSites.id, site.id));
  }

  await db
    .update(priceSignals)
    .set({ status: 'scored', scoredAt })
    .where(eq(priceSignals.signalId, signalId));

  return getFleetSignal(signalId).then(view => view.sites);
}

export async function getFleetSignal(signalId: string): Promise<FleetSignalView> {
  const db = await requireDb();
  const signalRows = await db
    .select()
    .from(priceSignals)
    .where(eq(priceSignals.signalId, signalId))
    .limit(1);
  const signal = signalRows[0];
  if (!signal) throw new PriceSignalError(`Signal ${signalId} not found`);

  const intervals = await db
    .select()
    .from(priceSignalIntervals)
    .where(eq(priceSignalIntervals.signalId, signalId))
    .orderBy(priceSignalIntervals.intervalIndex);
  const siteRows = await db
    .select()
    .from(priceSignalSites)
    .where(eq(priceSignalSites.signalId, signalId));

  return {
    signalId: signal.signalId,
    status: signal.status,
    scopeType: signal.scopeType,
    scopeId: signal.scopeId,
    region: signal.region,
    intervalMinutes: signal.intervalMinutes,
    startsAt: signal.startsAt,
    endsAt: signal.endsAt,
    solver: signal.solver,
    iterations: signal.iterations,
    maxDeviationW: signal.maxDeviationWatts,
    publishedAt: signal.publishedAt,
    scoredAt: signal.scoredAt,
    intervals: intervals.map(interval => ({
      intervalIndex: interval.intervalIndex,
      startsAt: interval.startsAt,
      baseImportPriceCentsPerKwh: interval.baseImportPriceValue / PRICE_SCALE,
      signalAdjustmentCentsPerKwh: interval.signalAdjustmentValue / PRICE_SCALE,
      targetNetW: interval.targetNetWatts,
      plannedNetW: interval.plannedNetWatts,
    })),
    sites: siteRows.map(site => ({
      siteRef: site.siteRef,
      userId: site.userId,
      plannedNetWh: site.plannedNetWh,
      plannedBillCents: site.plannedBillCents,
      delivery: site.delivery,
      deliveryDetail: site.deliveryDetail,
      response: site.response,
      actualNetWh: site.actualNetWh,
      telemetrySamples: site.telemetrySamples,
    })),
  };
}

export async function listFleetSignals(limit: number): Promise<FleetSignalView[]> {
  const db = await requireDb();
  const rows = await db
    .select({ signalId: priceSignals.signalId })
    .from(priceSignals)
    .orderBy(sql`${priceSignals.startsAt} DESC`)
    .limit(limit);
  return Promise.all(rows.map(row => getFleetSignal(row.signalId)));
}
