/**
 * Multi-Service Optimization Engine
 * 
 * Constraint-aware dispatch optimizer that maximizes value across multiple
 * grid services while respecting DER capabilities and user preferences.
 * 
 * Supports objectives: minimize_cost, maximize_revenue, minimize_emissions,
 * maximize_self_consumption, balance_grid
 */

import { getDb } from '../db';
import { sql } from 'drizzle-orm';
import { createHash } from 'crypto';
import { derCapabilities, DispatchEligibility } from './der-capabilities';
import { probabilisticForecasting, ForecastResult, ForecastQuantiles } from './probabilistic-forecasting';
import { settlementLedger } from './settlement-ledger';
import { kafkaPublisher } from '../integration/kafka-publisher';
import { dispatchDeviceSetpoint } from './control-delivery';
import {
  MilpAsset,
  MilpDispatchRequest,
  MilpDispatchResponse,
  MilpOptimizerError,
  assertMilpOptimizerConfigured,
  checkPlanAgainstNetwork,
  isMilpOptimizerConfigured,
  solveMilpDispatch,
} from './milp-dispatch';
import { requireCapability } from './degraded-operation';
import { resolveRegionForUser } from './regions';
import { getTwinEvidence } from './digital-twin';
import type { SqlRow } from '../sql-row';
import { jsonSetText } from '../sql-json';

// Types for optimization
export type ObjectiveFunction = 
  | 'minimize_cost'
  | 'maximize_revenue'
  | 'minimize_emissions'
  | 'maximize_self_consumption'
  | 'balance_grid';

export interface OptimizationRequest {
  scope: {
    userId?: number;
    communityId?: number;
    assetIds?: number[];
  };
  objective: ObjectiveFunction;
  horizonHours: number;
  intervalMinutes: number;
  constraints?: {
    maxGridExport?: number;
    maxGridImport?: number;
    minSocReserve?: number; // Minimum SoC to maintain
    priorityServices?: string[];
  };
  serviceEnrollments?: number[]; // IDs of enrolled services to consider
}

export interface DispatchSetpoint {
  assetId: number;
  intervalStart: Date;
  intervalEnd: Date;
  targetPowerWatts: number; // Positive = export, negative = import
  targetSocPercent?: number;
  serviceProductId?: number;
  expectedRevenue: number;
  expectedCost: number;
  expectedEmissionsSaved: number;
  confidence: number;
  // true when expected revenue/cost were computed from the estimated fallback
  // price curve rather than a real price forecast
  economicsEstimated?: boolean;
  // true when expectedEmissionsSaved was computed from the assumed default
  // carbon-intensity curve rather than a real emissions forecast
  emissionsEstimated?: boolean;
}

export interface OptimizationResult {
  scheduleId: string;
  optimizationRunId: string;
  objective: ObjectiveFunction;
  scheduleStart: Date;
  scheduleEnd: Date;
  intervalMinutes: number;
  setpoints: DispatchSetpoint[];
  summary: {
    totalExpectedRevenue: number;
    totalExpectedCost: number;
    totalExpectedEmissionsSaved: number;
    totalEnergyExportWh: number;
    totalEnergyImportWh: number;
    serviceAllocation: Record<string, number>; // Service -> kWh
  };
  forecasts: {
    load?: ForecastResult;
    price?: ForecastResult;
    emissions?: ForecastResult;
  };
  status: 'optimized' | 'partial' | 'failed';
  warnings: string[];
  // Which engine produced the setpoints. 'heuristic' results are rule-based
  // per-asset decisions, not a proven-optimal schedule, and are refused in
  // production; callers must not present them as optimized dispatch.
  engine: 'milp' | 'heuristic';
  solver?: string;
}

interface AssetState {
  assetId: number;
  assetType: string;
  capacity: number;
  eligibility: DispatchEligibility;
  currentPower: number;
  currentSoc: number | null;
  /** Digital-twin meter evidence for this asset, when a user scope let us resolve it. */
  evidence?: 'measured' | 'stale' | 'never';
}

interface IntervalContext {
  timestamp: Date;
  loadForecast: ForecastQuantiles;
  priceForecast: ForecastQuantiles;
  emissionsForecast: ForecastQuantiles;
  solarForecast?: ForecastQuantiles;
  // true when priceForecast is the hardcoded fallback curve, not real forecast data
  priceForecastEstimated?: boolean;
  // true when emissionsForecast is the hardcoded fallback, not real forecast data.
  // Objectives that need emissions refuse before consuming this; the flag exists
  // so informational emissions figures are never silently trusted either.
  emissionsForecastEstimated?: boolean;
  emissionFactorSource?: 'forecast' | 'default';
}

/** Timestamp columns arrive as Date from pg but as a string from raw JSON rows. */
function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  throw new Error(`Expected a timestamp, got ${JSON.stringify(value)}`);
}

export class OptimizationEngine {
  
  /**
   * Run optimization for the given request
   */
  async optimize(request: OptimizationRequest): Promise<OptimizationResult> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const scheduleId = this.generateId('sched');
    const optimizationRunId = this.generateId('opt');
    const warnings: string[] = [];

    const now = new Date();
    const scheduleStart = new Date(Math.ceil(now.getTime() / (request.intervalMinutes * 60000)) * (request.intervalMinutes * 60000));
    const scheduleEnd = new Date(scheduleStart.getTime() + request.horizonHours * 3600000);

    console.log(`[Optimization] Starting ${request.objective} optimization for ${request.horizonHours}h horizon`);

    // Get assets to optimize
    const assetScope = await this.getAssetsForOptimization(request);
    const assets = assetScope.assets;
    warnings.push(...assetScope.warnings);
    if (assets.length === 0) {
      warnings.push('No eligible assets found for optimization');
      return this.createEmptyResult(scheduleId, optimizationRunId, request, scheduleStart, scheduleEnd, warnings);
    }

    // Get forecasts
    const forecasts = await this.getForecasts(request, scheduleStart, request.horizonHours, request.intervalMinutes);

    // Get service enrollments and their rates
    const serviceRates = await this.getServiceRates(request.serviceEnrollments);

    // Run optimization algorithm
    assertMilpOptimizerConfigured();
    const useMilp = isMilpOptimizerConfigured();
    let solver: string | undefined;
    let setpoints: DispatchSetpoint[];

    if (useMilp) {
      const solved = await this.runMilpOptimization(
        request,
        assets,
        forecasts,
        scheduleStart,
        request.horizonHours,
        request.intervalMinutes,
        warnings
      );
      setpoints = solved.setpoints;
      solver = solved.solver;
    } else {
      warnings.push(
        'OPTIMIZER_SERVICE_URL is not set: dispatch was produced by the rule-based heuristic engine and is not a proven-optimal schedule'
      );
      setpoints = await this.runOptimization(
        request,
        assets,
        forecasts,
        serviceRates,
        scheduleStart,
        request.horizonHours,
        request.intervalMinutes,
        warnings
      );
    }

    // Calculate summary
    const summary = this.calculateSummary(setpoints);

    // Store schedule
    await this.storeSchedule(scheduleId, optimizationRunId, request, scheduleStart, scheduleEnd, setpoints, summary);

    // Publish to Kafka for lakehouse analytics
    try {
      const totalPowerKw = setpoints.reduce((sum, s) => sum + s.targetPowerWatts / 1000, 0);
      const totalEnergyKwh = (summary.totalEnergyExportWh + summary.totalEnergyImportWh) / 1000;
      await kafkaPublisher.publishOptimizationRun({
        runId: optimizationRunId,
        objectiveType: request.objective,
        objectiveValue: summary.totalExpectedRevenue - summary.totalExpectedCost,
        constraintsSatisfied: warnings.length === 0,
        assetCount: assets.length,
        scheduleHorizonHours: request.horizonHours,
        totalPowerKw,
        totalEnergyKwh,
        userId: request.scope.userId?.toString(),
        timestamp: new Date(),
      });
    } catch (error) {
      console.error('[Optimization] Error publishing to Kafka:', error);
    }

    console.log(`[Optimization] Completed: ${setpoints.length} setpoints, revenue=${summary.totalExpectedRevenue}c, emissions saved=${summary.totalExpectedEmissionsSaved}g`);

    return {
      scheduleId,
      optimizationRunId,
      objective: request.objective,
      scheduleStart,
      scheduleEnd,
      intervalMinutes: request.intervalMinutes,
      setpoints,
      summary,
      forecasts,
      status: warnings.length > 0 ? 'partial' : 'optimized',
      warnings,
      engine: useMilp ? 'milp' : 'heuristic',
      solver,
    };
  }

  /**
   * Solve the whole horizon and every asset as one mixed-integer program.
   *
   * Unlike `runOptimization`, this respects state of charge over time, grid
   * import/export limits and charge/discharge exclusivity. Failures propagate:
   * an unreachable solver or a non-optimal solve must not silently become a
   * heuristic schedule labelled 'optimized'.
   */
  private async runMilpOptimization(
    request: OptimizationRequest,
    assets: AssetState[],
    forecasts: { load?: ForecastResult; price?: ForecastResult; emissions?: ForecastResult; solar?: ForecastResult },
    scheduleStart: Date,
    horizonHours: number,
    intervalMinutes: number,
    warnings: string[]
  ): Promise<{ setpoints: DispatchSetpoint[]; solver: string }> {
    const intervalsCount = Math.round((horizonHours * 60) / intervalMinutes);
    const contexts = Array.from({ length: intervalsCount }, (_, i) =>
      this.getIntervalContext(
        new Date(scheduleStart.getTime() + i * intervalMinutes * 60000),
        forecasts,
        i,
        intervalMinutes
      )
    );

    if (!forecasts.price) {
      warnings.push(
        'No price forecast available: the MILP was solved against an estimated fallback price curve'
      );
    }

    const needsEmissions = request.objective === 'minimize_emissions';
    if (needsEmissions && !forecasts.emissions) {
      throw new MilpOptimizerError(
        'objective minimize_emissions requires an emissions forecast; refusing to optimize against an assumed carbon intensity'
      );
    }

    const milpAssets: MilpAsset[] = [];
    const eligible = assets.filter(asset => asset.eligibility.eligible);

    for (const asset of eligible) {
      const exportW = asset.eligibility.availablePowerExport;
      const importW = asset.eligibility.availablePowerImport;

      if (asset.assetType === 'battery') {
        // `assets.capacity` is watt-hours for batteries (see drizzle/schema.ts).
        if (asset.capacity <= 0 || (exportW <= 0 && importW <= 0)) continue;
        if (asset.currentSoc === null) {
          // A battery without a measured state of charge cannot be scheduled
          // honestly — an assumed 50% SoC would produce setpoints the battery
          // may not be able to follow.
          warnings.push(
            `Asset ${asset.assetId} (battery) excluded from MILP: no measured state of charge`
          );
          continue;
        }
        // A battery sitting below its reserve must not 422 the whole fleet:
        // the solver validates initial_soc against soc_min for the entire
        // request in one shot, so one low battery would reject every asset.
        // Constrain this asset instead — soc_min raised to its current SoC
        // means it can charge back above the reserve but cannot discharge
        // until then — and record the per-asset adjustment.
        const minSocReserve = request.constraints?.minSocReserve ?? 10;
        let socMinPercent = minSocReserve;
        if (asset.currentSoc < minSocReserve) {
          socMinPercent = asset.currentSoc;
          warnings.push(
            `Asset ${asset.assetId} (battery) at ${asset.currentSoc}% SoC is below the ${minSocReserve}% reserve: ` +
              `its soc_min was raised to its current SoC, so it can charge but not discharge until it is back above the reserve`
          );
        }
        milpAssets.push({
          asset_id: String(asset.assetId),
          asset_type: 'battery',
          battery: {
            capacity_wh: asset.capacity,
            max_charge_w: Math.max(importW, 1),
            max_discharge_w: Math.max(exportW, 1),
            initial_soc_percent: asset.currentSoc,
            soc_min_percent: socMinPercent,
            soc_max_percent: 95,
          },
        });
        continue;
      }

      if (asset.assetType === 'solar' || asset.assetType === 'wind') {
        const available = contexts.map(context =>
          Math.min(asset.capacity, context.solarForecast?.p50 ?? asset.capacity)
        );
        milpAssets.push({
          asset_id: String(asset.assetId),
          asset_type: 'generation',
          generation: { available_w: available, curtailable: true },
        });
      }
    }

    // With nothing left to dispatch there is no plan to solve: fail loud here
    // rather than letting the solver 422 an empty site with no explanation of
    // which checks emptied it (the warnings above carry those reasons).
    if (milpAssets.length === 0) {
      throw new MilpOptimizerError(
        'no dispatchable assets remain after eligibility, metering and SoC checks; refusing to request a fleet dispatch for an empty site'
      );
    }

    const milpRequest: MilpDispatchRequest = {
      interval_minutes: intervalMinutes,
      site: {
        site_id: this.siteIdFor(request),
        assets: milpAssets,
        load_w: contexts.map(context => Math.max(0, context.loadForecast.p50)),
        max_import_w: request.constraints?.maxGridImport ?? this.defaultGridLimit(eligible),
        max_export_w: request.constraints?.maxGridExport ?? this.defaultGridLimit(eligible),
      },
      prices: {
        import_cents_per_kwh: contexts.map(context => context.priceForecast.p50),
        export_cents_per_kwh: contexts.map(context => context.priceForecast.p50),
        grid_emissions_g_per_kwh: forecasts.emissions
          ? contexts.map(context => context.emissionsForecast.p50)
          : null,
      },
      objective: request.objective,
      grid_target_w: request.objective === 'balance_grid' ? contexts.map(() => 0) : null,
    };

    // Refused while the optimizer is in an open outage: the alternative is a
    // heuristic schedule stored under the optimizer's name.
    await requireCapability('optimizer_dispatch');
    const result = await solveMilpDispatch(milpRequest);

    // Optimal against prices is not the same as carryable by the wires. A plan
    // that overloads an element is refused outright; a plan that could not be
    // checked is issued, but the schedule says so rather than implying the
    // network was consulted.
    const network = await checkPlanAgainstNetwork(result, {
      assetIds: eligible.map(asset => asset.assetId),
      subjectReference: `dispatch:${this.siteIdFor(request)}`,
    });
    if (network.status === 'violations') {
      throw new MilpOptimizerError(
        `refusing to issue this plan: ${
          network.limitingElement ?? 'an element'
        } is over its limit in interval ${network.intervalIndex ?? 0}` +
          (network.worst
            ? ` (${network.worst.value.toFixed(1)} against ${network.worst.limit.toFixed(1)}, ${
                network.worst.kind
              })`
            : '')
      );
    }
    if (!network.checked) {
      warnings.push(
        `network-unchecked (${network.status}): ${
          network.reason ?? 'no feasibility study was produced'
        } — this schedule has not been shown to be within network limits`
      );
    }

    return {
      setpoints: this.milpSetpoints(result, request, assets, contexts, scheduleStart, intervalMinutes),
      solver: result.solver,
    };
  }

  private siteIdFor(request: OptimizationRequest): string {
    if (request.scope.communityId) return `community-${request.scope.communityId}`;
    if (request.scope.userId) return `user-${request.scope.userId}`;
    return 'assets';
  }

  private defaultGridLimit(assets: AssetState[]): number {
    const total = assets.reduce(
      (sum, asset) =>
        sum + Math.max(asset.eligibility.availablePowerExport, asset.eligibility.availablePowerImport),
      0
    );
    return Math.max(total, 1);
  }

  private milpSetpoints(
    result: MilpDispatchResponse,
    request: OptimizationRequest,
    assets: AssetState[],
    contexts: IntervalContext[],
    scheduleStart: Date,
    intervalMinutes: number
  ): DispatchSetpoint[] {
    const byId = new Map(assets.map(asset => [String(asset.assetId), asset]));
    const setpoints: DispatchSetpoint[] = [];

    for (const interval of result.intervals) {
      const context = contexts[interval.index];
      const intervalStart = new Date(scheduleStart.getTime() + interval.index * intervalMinutes * 60000);
      const intervalEnd = new Date(intervalStart.getTime() + intervalMinutes * 60000);

      for (const setpoint of interval.setpoints) {
        const asset = byId.get(setpoint.asset_id);
        if (!asset) continue;
        const energyWh = (setpoint.power_w * intervalMinutes) / 60;
        const priceCentsPerKwh = context?.priceForecast.p50 ?? 0;
        const emissionsPerKwh = context?.emissionsForecast.p50 ?? 0;

        setpoints.push({
          assetId: asset.assetId,
          intervalStart,
          intervalEnd,
          targetPowerWatts: Math.round(setpoint.power_w),
          targetSocPercent: setpoint.soc_percent ?? undefined,
          expectedRevenue: energyWh > 0 ? Math.round((energyWh / 1000) * priceCentsPerKwh) : 0,
          expectedCost: energyWh < 0 ? Math.round((Math.abs(energyWh) / 1000) * priceCentsPerKwh) : 0,
          expectedEmissionsSaved: energyWh > 0 ? Math.round((energyWh / 1000) * emissionsPerKwh) : 0,
          confidence: Math.round(
            ((context?.priceForecast.confidence ?? 0) + (context?.loadForecast.confidence ?? 0)) / 2
          ),
          economicsEstimated: context?.priceForecastEstimated === true,
          emissionsEstimated: context?.emissionsForecastEstimated === true,
        });
      }
    }

    return setpoints;
  }

  /**
   * Get assets eligible for optimization
   */
  private async getAssetsForOptimization(
    request: OptimizationRequest
  ): Promise<{ assets: AssetState[]; warnings: string[] }> {
    const db = await getDb();
    if (!db) return { assets: [], warnings: ['Database unavailable: no assets could be loaded'] };

    let assetQuery;
    if (request.scope.assetIds && request.scope.assetIds.length > 0) {
      assetQuery = sql`
        SELECT id, "userId", "assetType", capacity, status FROM assets
        WHERE id IN (${sql.join(request.scope.assetIds.map(id => sql`${id}`), sql`, `)})
          AND status = 'active'
      `;
    } else if (request.scope.userId) {
      assetQuery = sql`
        SELECT id, "userId", "assetType", capacity, status FROM assets
        WHERE "userId" = ${request.scope.userId} AND status = 'active'
      `;
    } else if (request.scope.communityId) {
      assetQuery = sql`
        SELECT a.id, a."userId", a."assetType", a.capacity, a.status FROM assets a
        JOIN community_members cm ON cm.user_id = a."userId"
        WHERE cm.community_id = ${request.scope.communityId}
          AND cm.status = 'active' AND a.status = 'active'
      `;
    } else {
      return { assets: [], warnings: [] };
    }

    const warnings: string[] = [];

    // Digital-twin evidence: only assets with fresh meter evidence may be
    // optimized. Optimizing an asset whose state is unknown produces
    // setpoints built on nothing — exclude it and say so.
    let twinEvidence: Awaited<ReturnType<typeof getTwinEvidence>> = null;
    if (request.scope.userId) {
      twinEvidence = await getTwinEvidence({ userId: request.scope.userId });
      if (twinEvidence === null) {
        warnings.push(
          'Twin evidence unavailable: asset meter freshness could not be verified for this optimization'
        );
      }
    }

    const assetsResult = await db.execute<SqlRow>(assetQuery);
    const assets: AssetState[] = [];
    const excludedNoEvidence: number[] = [];

    for (const row of assetsResult.rows || []) {
      const eligibility = await derCapabilities.calculateEligibility(row.id);

      // Get current telemetry
      const telemetryResult = await db.execute<SqlRow>(sql`
        SELECT power, "stateOfCharge" FROM telemetry
        WHERE "assetId" = ${row.id}
        ORDER BY timestamp DESC LIMIT 1
      `);
      const telemetry = telemetryResult.rows[0];

      const evidence = twinEvidence?.get(row.id)?.evidence;
      if (evidence === 'stale' || evidence === 'never') {
        excludedNoEvidence.push(row.id);
        continue;
      }

      assets.push({
        assetId: row.id,
        assetType: row.assetType,
        capacity: row.capacity,
        eligibility,
        currentPower: telemetry?.power || 0,
        // stateOfCharge is stored as percent * 100 (drizzle/schema.ts). A
        // truly empty battery reads 0 — a real measurement, not a missing
        // one — so only null/undefined means "unmeasured".
        currentSoc:
          telemetry?.stateOfCharge !== null && telemetry?.stateOfCharge !== undefined
            ? telemetry.stateOfCharge / 100
            : null,
        evidence,
      });
    }

    if (excludedNoEvidence.length > 0) {
      warnings.push(
        `${excludedNoEvidence.length} asset(s) excluded from optimization: no fresh meter evidence ` +
          `(ids ${excludedNoEvidence.join(', ')}); a setpoint built on an unknown state would be commanding blind`
      );
    }

    return { assets, warnings };
  }

  /**
   * Get forecasts needed for optimization
   */
  private async getForecasts(
    request: OptimizationRequest,
    startTime: Date,
    horizonHours: number,
    intervalMinutes: number
  ): Promise<{
    load?: ForecastResult;
    price?: ForecastResult;
    emissions?: ForecastResult;
    solar?: ForecastResult;
  }> {
    // Region is derived from the requesting user's real profile country —
    // never hardcoded. When the region cannot be resolved, region-dependent
    // forecasts (price/emissions) are omitted so downstream guards fire
    // loudly instead of optimizing against assumed data.
    const region = request.scope.userId
      ? await resolveRegionForUser(request.scope.userId)
      : null;

    const canForecastLoad = !!request.scope.userId || !!region;
    const [loadForecast, priceForecast, emissionsForecast] = await Promise.all([
      canForecastLoad
        ? probabilisticForecasting.forecastLoad(
            request.scope.userId ? { userId: request.scope.userId } : { region: region! },
            horizonHours,
            intervalMinutes
          )
        : Promise.resolve(undefined),
      region
        ? probabilisticForecasting.forecastPrice(region, horizonHours, 60)
        : Promise.resolve(undefined),
      region
        ? probabilisticForecasting.forecastEmissions(region, horizonHours, 60)
        : Promise.resolve(undefined),
    ]);

    // Get solar forecast if user has solar assets
    let solarForecast: ForecastResult | undefined;
    if (request.scope.userId) {
      try {
        solarForecast = await probabilisticForecasting.forecastSolarGeneration(
          { userId: request.scope.userId },
          horizonHours,
          intervalMinutes
        );
      } catch (e) {
        // Solar forecast optional
      }
    }

    // Propagate unavailable forecasts as absent. An unavailable forecast has
    // an empty series (never fabricated), and downstream guards key off
    // presence — e.g. minimize_emissions refuses loudly when emissions is
    // absent instead of optimizing against an assumed carbon intensity.
    return {
      load: loadForecast?.forecastAvailable ? loadForecast : undefined,
      price: priceForecast?.forecastAvailable ? priceForecast : undefined,
      emissions: emissionsForecast?.forecastAvailable ? emissionsForecast : undefined,
      solar: solarForecast && solarForecast.forecastAvailable ? solarForecast : undefined,
    };
  }

  /**
   * Get service rates for enrolled services
   */
  private async getServiceRates(enrollmentIds?: number[]): Promise<Map<number, { rate: number; serviceType: string }>> {
    const db = await getDb();
    if (!db || !enrollmentIds || enrollmentIds.length === 0) return new Map();

    const result = await db.execute<SqlRow>(sql`
      SELECT se.id, gsp.base_rate_cents, gsp.service_type
      FROM service_enrollments se
      JOIN grid_service_products gsp ON gsp.id = se.service_product_id
      WHERE se.id IN (${sql.join(enrollmentIds.map(id => sql`${id}`), sql`, `)})
        AND se.status = 'active'
    `);

    const rates = new Map<number, { rate: number; serviceType: string }>();
    for (const row of result.rows || []) {
      rates.set(row.id, { rate: row.base_rate_cents, serviceType: row.service_type });
    }
    return rates;
  }

  /**
   * Run the optimization algorithm
   */
  private async runOptimization(
    request: OptimizationRequest,
    assets: AssetState[],
    forecasts: { load?: ForecastResult; price?: ForecastResult; emissions?: ForecastResult; solar?: ForecastResult },
    serviceRates: Map<number, { rate: number; serviceType: string }>,
    scheduleStart: Date,
    horizonHours: number,
    intervalMinutes: number,
    warnings: string[]
  ): Promise<DispatchSetpoint[]> {
    const setpoints: DispatchSetpoint[] = [];
    const intervalsCount = (horizonHours * 60) / intervalMinutes;

    if (!forecasts.price) {
      warnings.push('No price forecast available: expected revenue/cost figures use an estimated fallback price curve with reduced confidence');
    }

    if (!forecasts.emissions) {
      warnings.push('No emissions forecast available: expectedEmissionsSaved figures use the assumed default carbon-intensity curve and are flagged emissionsEstimated on every setpoint');
    }

    // Same refusal as the MILP path: never dispatch against the assumed
    // 400 gCO2/kWh fallback when the objective IS emissions.
    if (request.objective === 'minimize_emissions' && !forecasts.emissions) {
      throw new Error(
        'EMISSIONS_FORECAST_UNAVAILABLE: objective minimize_emissions requires a real emissions forecast; ' +
          'refusing to optimize against an assumed carbon intensity'
      );
    }

    // Track battery SoC through the schedule
    const batterySoc: Map<number, number> = new Map();
    for (const asset of assets) {
      if (asset.assetType === 'battery' && asset.currentSoc !== null) {
        batterySoc.set(asset.assetId, asset.currentSoc);
      }
    }

    for (let i = 0; i < intervalsCount; i++) {
      const intervalStart = new Date(scheduleStart.getTime() + i * intervalMinutes * 60000);
      const intervalEnd = new Date(intervalStart.getTime() + intervalMinutes * 60000);

      // Get forecast values for this interval
      const context = this.getIntervalContext(intervalStart, forecasts, i, intervalMinutes);

      // Optimize each asset for this interval
      for (const asset of assets) {
        if (!asset.eligibility.eligible) continue;

        // Never dispatch a battery without a measured SoC: the SoC reserve
        // guards and tracking would silently fabricate state. getAssetsForOptimization
        // already excludes null-SoC batteries with a loud warning; this guard
        // keeps the heuristic fallback honest too.
        if (asset.assetType === 'battery' && !batterySoc.has(asset.assetId)) continue;

        const setpoint = this.optimizeAssetInterval(
          request.objective,
          asset,
          context,
          intervalStart,
          intervalEnd,
          intervalMinutes,
          batterySoc.get(asset.assetId),
          request.constraints
        );

        if (setpoint) {
          setpoints.push(setpoint);

          // Update battery SoC tracking (guaranteed present — null-SoC
          // batteries are excluded above, so no fabricated state here).
          // `assets.capacity` is already watt-hours for batteries (drizzle/schema.ts).
          // The floor is the configured reserve: the export clamp above makes
          // breaching it impossible, and the tracker must agree with that
          // constraint rather than imposing its own hardcoded one.
          if (asset.assetType === 'battery' && asset.capacity > 0) {
            const currentSoc = batterySoc.get(asset.assetId)!;
            const minSoc = request.constraints?.minSocReserve ?? 10;
            const energyWh = (setpoint.targetPowerWatts * intervalMinutes) / 60;
            const socChange = (energyWh / asset.capacity) * 100;
            batterySoc.set(asset.assetId, Math.max(minSoc, Math.min(90, currentSoc - socChange)));
          }
        }
      }
    }

    return setpoints;
  }

  /**
   * Get forecast context for an interval
   */
  private getIntervalContext(
    timestamp: Date,
    forecasts: { load?: ForecastResult; price?: ForecastResult; emissions?: ForecastResult; solar?: ForecastResult },
    intervalIndex: number,
    intervalMinutes: number
  ): IntervalContext {
    // Find matching forecast points. Load and solar are forecast at the
    // dispatch resolution; price and emissions are HOURLY (see getForecasts,
    // which requests them at 60 minutes), so the hourly row for dispatch
    // interval `i` is floor(i * intervalMinutes / 60) — not i/4, which only
    // holds for 15-minute dispatch.
    const hourlyIndex = Math.floor((intervalIndex * intervalMinutes) / 60);
    const loadPoint = forecasts.load?.points[intervalIndex];
    const pricePoint = forecasts.price?.points[hourlyIndex];
    const emissionsPoint = forecasts.emissions?.points[hourlyIndex];
    const solarPoint = forecasts.solar?.points[intervalIndex];

    // When no real price forecast exists we fall back to a static curve, but it
    // is explicitly flagged `priceForecastEstimated: true` with heavily reduced
    // confidence so downstream revenue figures are never silently trusted.
    const priceForecastEstimated = !pricePoint;
    // Same honesty rule as the price fallback: the static 400 gCO2/kWh curve is
    // explicitly flagged. minimize_emissions refuses outright before this point
    // when no real emissions forecast exists, so the fallback is only ever used
    // for informational emissions-saved estimates.
    const emissionsForecastEstimated = !emissionsPoint;

    return {
      timestamp,
      loadForecast: loadPoint?.values || { p10: 0, p50: 0, p90: 0, mean: 0, confidence: 50 },
      priceForecast: pricePoint?.values || { p10: 30, p50: 45, p90: 60, mean: 45, confidence: 20 },
      emissionsForecast: emissionsPoint?.values || { p10: 350, p50: 400, p90: 450, mean: 400, confidence: 50 },
      solarForecast: solarPoint?.values,
      priceForecastEstimated,
      emissionsForecastEstimated,
      emissionFactorSource: emissionsForecastEstimated ? 'default' : 'forecast',
    };
  }

  /**
   * Optimize a single asset for a single interval
   */
  private optimizeAssetInterval(
    objective: ObjectiveFunction,
    asset: AssetState,
    context: IntervalContext,
    intervalStart: Date,
    intervalEnd: Date,
    intervalMinutes: number,
    currentSoc: number | undefined,
    constraints?: OptimizationRequest['constraints']
  ): DispatchSetpoint | null {
    const hour = intervalStart.getHours();
    let targetPower = 0;
    let expectedRevenue = 0;
    let expectedCost = 0;
    let expectedEmissionsSaved = 0;

    // Get available power considering constraints
    let maxExport = asset.eligibility.availablePowerExport;
    let maxImport = asset.eligibility.availablePowerImport;

    if (constraints?.maxGridExport) {
      maxExport = Math.min(maxExport, constraints.maxGridExport);
    }
    if (constraints?.maxGridImport) {
      maxImport = Math.min(maxImport, constraints.maxGridImport);
    }

    // Apply SoC reserve constraint for batteries. The reserve is an energy
    // budget, not a binary switch: a battery just above minSoc may export
    // only the power that keeps it at or above the reserve at the end of
    // this interval. `capacity` is watt-hours for batteries (drizzle/schema.ts)
    // and currentSoc/minSoc are percents, so the exportable energy is
    // (soc - minSoc)/100 * capacity Wh, and dividing by the interval length
    // in hours turns it into watts. Below or at the reserve this clamps to
    // zero — a true constraint result, not an assumed one.
    if (asset.assetType === 'battery' && currentSoc !== undefined) {
      const minSoc = constraints?.minSocReserve ?? 20;
      const intervalHours = intervalMinutes / 60;
      const exportableWh = Math.max(0, ((currentSoc - minSoc) / 100) * asset.capacity);
      const maxExportByReserve = intervalHours > 0 ? exportableWh / intervalHours : 0;
      maxExport = Math.min(maxExport, maxExportByReserve);
      if (currentSoc >= 90) {
        maxImport = 0; // Can't import if at maximum SoC
      }
    }

    // Optimization logic based on objective
    switch (objective) {
      case 'maximize_revenue':
        targetPower = this.optimizeForRevenue(asset, context, maxExport, maxImport, hour);
        break;

      case 'minimize_cost':
        targetPower = this.optimizeForCost(asset, context, maxExport, maxImport, hour);
        break;

      case 'minimize_emissions':
        targetPower = this.optimizeForEmissions(asset, context, maxExport, maxImport, hour);
        break;

      case 'maximize_self_consumption':
        targetPower = this.optimizeForSelfConsumption(asset, context, maxExport, maxImport, hour);
        break;

      case 'balance_grid':
        targetPower = this.optimizeForGridBalance(asset, context, maxExport, maxImport, hour);
        break;
    }

    // Skip if no meaningful dispatch
    if (Math.abs(targetPower) < 100) return null; // Minimum 100W threshold

    // Calculate expected outcomes
    const energyWh = (targetPower * intervalMinutes) / 60;
    const pricePerKwh = context.priceForecast.p50;
    const emissionsPerKwh = context.emissionsForecast.p50;

    if (targetPower > 0) {
      // Exporting
      expectedRevenue = Math.round((energyWh / 1000) * pricePerKwh);
      expectedEmissionsSaved = Math.round((energyWh / 1000) * emissionsPerKwh);
    } else {
      // Importing
      expectedCost = Math.round((Math.abs(energyWh) / 1000) * pricePerKwh);
    }

    return {
      assetId: asset.assetId,
      intervalStart,
      intervalEnd,
      targetPowerWatts: Math.round(targetPower),
      targetSocPercent: asset.assetType === 'battery' ? currentSoc : undefined,
      expectedRevenue,
      expectedCost,
      expectedEmissionsSaved,
      confidence: Math.round((context.priceForecast.confidence + context.loadForecast.confidence) / 2),
      economicsEstimated: context.priceForecastEstimated === true,
      emissionsEstimated: context.emissionsForecastEstimated === true,
    };
  }

  /**
   * Optimize for maximum revenue
   */
  private optimizeForRevenue(
    asset: AssetState,
    context: IntervalContext,
    maxExport: number,
    maxImport: number,
    hour: number
  ): number {
    const price = context.priceForecast.p50;
    const avgPrice = 45; // Average price in cents/kWh

    // Export during high price periods
    if (price > avgPrice * 1.2) {
      return maxExport; // Full export during high prices
    }
    
    // Import during low price periods (for batteries)
    if (price < avgPrice * 0.8 && asset.assetType === 'battery') {
      return -maxImport; // Charge during low prices
    }

    // Solar always exports when generating
    if (asset.assetType === 'solar' && context.solarForecast) {
      return Math.min(maxExport, context.solarForecast.p50);
    }

    return 0;
  }

  /**
   * Optimize for minimum cost
   */
  private optimizeForCost(
    asset: AssetState,
    context: IntervalContext,
    maxExport: number,
    maxImport: number,
    hour: number
  ): number {
    const price = context.priceForecast.p50;
    const avgPrice = 45;

    // Reduce import during high price periods
    if (price > avgPrice * 1.2 && asset.assetType === 'battery') {
      return maxExport * 0.5; // Discharge to reduce grid import
    }

    // Charge during low price periods
    if (price < avgPrice * 0.8 && asset.assetType === 'battery') {
      return -maxImport;
    }

    // Solar reduces cost by self-consumption
    if (asset.assetType === 'solar' && context.solarForecast) {
      const load = context.loadForecast.p50;
      const solar = context.solarForecast.p50;
      // Export only excess after self-consumption
      return Math.max(0, Math.min(maxExport, solar - load));
    }

    return 0;
  }

  /**
   * Optimize for minimum emissions
   */
  private optimizeForEmissions(
    asset: AssetState,
    context: IntervalContext,
    maxExport: number,
    maxImport: number,
    hour: number
  ): number {
    const emissions = context.emissionsForecast.p50;
    const avgEmissions = 400; // Average emissions in g/kWh

    // Export during high emissions periods (displace dirty generation)
    if (emissions > avgEmissions * 1.1) {
      return maxExport;
    }

    // Import during low emissions periods (charge with clean energy)
    if (emissions < avgEmissions * 0.9 && asset.assetType === 'battery') {
      return -maxImport;
    }

    // Solar always helps reduce emissions
    if (asset.assetType === 'solar' && context.solarForecast) {
      return Math.min(maxExport, context.solarForecast.p50);
    }

    return 0;
  }

  /**
   * Optimize for maximum self-consumption
   */
  private optimizeForSelfConsumption(
    asset: AssetState,
    context: IntervalContext,
    maxExport: number,
    maxImport: number,
    hour: number
  ): number {
    const load = context.loadForecast.p50;
    const solar = context.solarForecast?.p50 || 0;

    if (asset.assetType === 'solar') {
      // Match solar to load, minimize export
      return Math.min(maxExport, Math.max(0, solar - load));
    }

    if (asset.assetType === 'battery') {
      // Charge during solar surplus
      if (solar > load) {
        return -Math.min(maxImport, solar - load);
      }
      // Discharge during solar deficit
      if (load > solar) {
        return Math.min(maxExport, load - solar);
      }
    }

    return 0;
  }

  /**
   * Optimize for grid balance
   */
  private optimizeForGridBalance(
    asset: AssetState,
    context: IntervalContext,
    maxExport: number,
    maxImport: number,
    hour: number
  ): number {
    const load = context.loadForecast.p50;
    const avgLoad = 500; // Average load in watts

    // Export during high load periods
    if (load > avgLoad * 1.2) {
      return maxExport * 0.8;
    }

    // Import during low load periods (for batteries)
    if (load < avgLoad * 0.8 && asset.assetType === 'battery') {
      return -maxImport * 0.5;
    }

    return 0;
  }

  /**
   * Calculate summary statistics for setpoints
   */
  private calculateSummary(setpoints: DispatchSetpoint[]): OptimizationResult['summary'] {
    let totalExpectedRevenue = 0;
    let totalExpectedCost = 0;
    let totalExpectedEmissionsSaved = 0;
    let totalEnergyExportWh = 0;
    let totalEnergyImportWh = 0;
    const serviceAllocation: Record<string, number> = {};

    for (const sp of setpoints) {
      totalExpectedRevenue += sp.expectedRevenue;
      totalExpectedCost += sp.expectedCost;
      totalExpectedEmissionsSaved += sp.expectedEmissionsSaved;

      const durationMinutes = (sp.intervalEnd.getTime() - sp.intervalStart.getTime()) / 60000;
      const energyWh = (sp.targetPowerWatts * durationMinutes) / 60;

      if (energyWh > 0) {
        totalEnergyExportWh += energyWh;
      } else {
        totalEnergyImportWh += Math.abs(energyWh);
      }

      // Track service allocation
      const service = sp.serviceProductId ? `service_${sp.serviceProductId}` : 'unallocated';
      serviceAllocation[service] = (serviceAllocation[service] || 0) + Math.abs(energyWh) / 1000;
    }

    return {
      totalExpectedRevenue,
      totalExpectedCost,
      totalExpectedEmissionsSaved,
      totalEnergyExportWh: Math.round(totalEnergyExportWh),
      totalEnergyImportWh: Math.round(totalEnergyImportWh),
      serviceAllocation,
    };
  }

  /**
   * Store optimization schedule
   */
  private async storeSchedule(
    scheduleId: string,
    optimizationRunId: string,
    request: OptimizationRequest,
    scheduleStart: Date,
    scheduleEnd: Date,
    setpoints: DispatchSetpoint[],
    summary: OptimizationResult['summary']
  ): Promise<void> {
    const db = await getDb();
    if (!db) return;

    try {
      // Insert schedule
      const scheduleResult = await db.execute<SqlRow>(sql`
        INSERT INTO dispatch_schedules (
          schedule_id, schedule_start, schedule_end, interval_minutes,
          optimization_run_id, objective_function, status,
          total_expected_revenue, total_expected_cost, total_expected_emissions_saved,
          metadata, created_at, updated_at
        ) VALUES (
          ${scheduleId}, ${scheduleStart}, ${scheduleEnd}, ${request.intervalMinutes},
          ${optimizationRunId}, ${request.objective}, 'optimized',
          ${summary.totalExpectedRevenue}, ${summary.totalExpectedCost}, ${summary.totalExpectedEmissionsSaved},
          ${JSON.stringify({ scope: request.scope, constraints: request.constraints })},
          NOW(), NOW()
        )
        RETURNING id
      `);

      const dbScheduleId = Number(scheduleResult.rows[0].id);

      // Insert setpoints
      for (const sp of setpoints) {
        await db.execute<SqlRow>(sql`
          INSERT INTO dispatch_setpoints (
            schedule_id, asset_id, interval_start, interval_end,
            target_power_watts, target_soc_percent, service_product_id,
            status, metadata, created_at
          ) VALUES (
            ${dbScheduleId}, ${sp.assetId}, ${sp.intervalStart}, ${sp.intervalEnd},
            ${sp.targetPowerWatts}, ${sp.targetSocPercent || null}, ${sp.serviceProductId || null},
            'scheduled', ${JSON.stringify({ expectedRevenue: sp.expectedRevenue, expectedCost: sp.expectedCost, confidence: sp.confidence })},
            NOW()
          )
        `);
      }
    } catch (error) {
      console.error('[Optimization] Error storing schedule:', error);
    }
  }

  /**
   * Create empty result when no optimization possible
   */
  private createEmptyResult(
    scheduleId: string,
    optimizationRunId: string,
    request: OptimizationRequest,
    scheduleStart: Date,
    scheduleEnd: Date,
    warnings: string[]
  ): OptimizationResult {
    return {
      scheduleId,
      optimizationRunId,
      objective: request.objective,
      scheduleStart,
      scheduleEnd,
      intervalMinutes: request.intervalMinutes,
      setpoints: [],
      summary: {
        totalExpectedRevenue: 0,
        totalExpectedCost: 0,
        totalExpectedEmissionsSaved: 0,
        totalEnergyExportWh: 0,
        totalEnergyImportWh: 0,
        serviceAllocation: {},
      },
      forecasts: {},
      status: 'failed',
      warnings,
      engine: isMilpOptimizerConfigured() ? 'milp' : 'heuristic',
    };
  }

  /**
   * Execute a dispatch schedule
   */
  async executeSchedule(scheduleId: string): Promise<{
    success: boolean;
    dispatchedCount: number;
    queuedCount: number;
    errors: string[];
  }> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const errors: string[] = [];
    let dispatchedCount = 0;
    let queuedCount = 0;

    // Explicit columns: `ds.*, dsp.*` collides on id/status/metadata, and the
    // updates below key off dsp.id.
    const scheduleResult = await db.execute<SqlRow>(sql`
      SELECT dsp.id, dsp.asset_id, dsp.target_power_watts,
             dsp.interval_start, dsp.interval_end
      FROM dispatch_schedules ds
      JOIN dispatch_setpoints dsp ON dsp.schedule_id = ds.id
      WHERE ds.schedule_id = ${scheduleId}
        AND dsp.status = 'scheduled'
        AND dsp.interval_start <= NOW()
        AND dsp.interval_end > NOW()
    `);

    const setpoints = scheduleResult.rows || [];

    for (const sp of setpoints) {
      try {
        // Bounded by the setpoint's own interval: the device stops obeying when
        // the interval it was optimized for ends, whether or not the next
        // dispatch arrives.
        const result = await this.dispatchToDevice(
          Number(sp.asset_id),
          Number(sp.target_power_watts),
          toDate(sp.interval_start),
          toDate(sp.interval_end)
        );

        if (result.dispatched) {
          // Mark 'dispatched' ONLY when the command actually reached the broker
          await db.execute<SqlRow>(sql`
            UPDATE dispatch_setpoints
            SET status = 'dispatched', dispatched_at = NOW()
            WHERE id = ${sp.id}
          `);
          dispatchedCount++;
        } else {
          // Command recorded but NOT sent. The setpoint stays in 'scheduled'
          // status (the dispatch_setpoints enum has no 'queued' value) with the
          // dispatch error recorded in metadata — it is never marked dispatched.
          const dispatchError = result.error || 'Unknown dispatch failure';
          errors.push(`Asset ${sp.asset_id}: not dispatched (unsent): ${dispatchError}`);
          queuedCount++;

          await db.execute<SqlRow>(sql`
            UPDATE dispatch_setpoints
            SET metadata = ${jsonSetText(sql`metadata`, {
              dispatchError,
              dispatchStatus: 'unsent',
            })}
            WHERE id = ${sp.id}
          `);
        }
      } catch (error: any) {
        errors.push(`Asset ${sp.asset_id}: ${error.message}`);

        await db.execute<SqlRow>(sql`
          UPDATE dispatch_setpoints
          SET status = 'failed', metadata = ${jsonSetText(sql`metadata`, { error: error.message })}
          WHERE id = ${sp.id}
        `);
      }
    }

    // Update schedule status
    if (dispatchedCount > 0) {
      await db.execute<SqlRow>(sql`
        UPDATE dispatch_schedules
        SET status = 'dispatching', updated_at = NOW()
        WHERE schedule_id = ${scheduleId}
      `);
    }

    console.log(`[Optimization] Executed schedule ${scheduleId}: ${dispatchedCount} dispatched, ${queuedCount} queued, ${errors.length} errors`);

    return {
      success: errors.length === 0,
      dispatchedCount,
      queuedCount,
      errors,
    };
  }

  /**
   * Dispatch a bounded setpoint to a device via MQTT.
   *
   * Goes through the control-delivery path, so the command carries its validity
   * window and its fallback policy and is recorded as a control assignment the
   * expiry sweep can close out. An optimizer setpoint that outlives the interval
   * it was computed for is a hazard: the device falls back to its own local
   * logic (`resume_local`) instead of holding a stale target indefinitely.
   *
   * Returns { dispatched: true } only when the broker actually took the message;
   * otherwise the command stays pending with the error recorded.
   */
  private async dispatchToDevice(
    assetId: number,
    targetPowerWatts: number,
    validFrom: Date,
    validTo: Date
  ): Promise<{ dispatched: boolean; error?: string }> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Get device info
    const deviceResult = await db.execute<SqlRow>(sql`
      SELECT d.* FROM devices d
      JOIN assets a ON a.id = d."assetId"
      WHERE a.id = ${assetId} AND d.status = 'online'
    `);

    const device = deviceResult.rows[0];
    if (!device) {
      throw new Error('Device not found or offline');
    }

    // Create device command record
    const commandResult = await db.execute<SqlRow>(sql`
      INSERT INTO device_commands (
        "deviceId", command, payload, status, "createdAt"
      ) VALUES (
        ${device.id}, 'set_power',
        ${JSON.stringify({ targetPowerWatts, timestamp: new Date().toISOString() })},
        'pending', NOW()
      )
      RETURNING id
    `);
    const commandId = Number(commandResult.rows[0].id);

    try {
      const dispatch = await dispatchDeviceSetpoint({
        deviceId: device.deviceId,
        setpointWatts: targetPowerWatts,
        validFrom,
        validTo,
        fallbackPolicy: 'resume_local',
        source: 'optimizer',
        assetId,
      });
      if (!dispatch.published) {
        throw new Error(dispatch.reason || 'MQTT publish failed');
      }

      await db.execute<SqlRow>(sql`
        UPDATE device_commands SET status = 'sent', "sentAt" = NOW() WHERE id = ${commandId}
      `);

      console.log(
        `[Optimization] Dispatched set_power=${targetPowerWatts}W to device ${device.deviceId} ` +
          `until ${dispatch.validTo.toISOString()} (assignment ${dispatch.assignmentId})`
      );
      return { dispatched: true };
    } catch (error: any) {
      const dispatchError = error?.message || String(error);

      // Command stays 'pending' (unsent) with the error recorded in response
      await db.execute<SqlRow>(sql`
        UPDATE device_commands
        SET response = ${JSON.stringify({ dispatchError, failedAt: new Date().toISOString() })}
        WHERE id = ${commandId}
      `);

      console.warn(`[Optimization] Failed to dispatch to device ${device.deviceId}, command left pending: ${dispatchError}`);
      return { dispatched: false, error: dispatchError };
    }
  }

  /**
   * Generate unique ID
   */
  private generateId(prefix: string): string {
    const timestamp = Date.now().toString();
    const random = Math.random().toString(36).substring(2, 10);
    return `${prefix}_${createHash('sha256').update(`${timestamp}-${random}`).digest('hex').substring(0, 12)}`;
  }
}

// Singleton instance
export const optimizationEngine = new OptimizationEngine();
