/**
 * Design studies: costing a site that has not been built.
 *
 * A developer, agency or community asks what to build — how much PV, how much
 * storage, what it costs, what it displaces, how long it takes to pay back — and
 * the honest version of that answer is entirely determined by its inputs. So the
 * shape of this service is: refuse without a load profile, name the source of
 * every profile used, freeze the whole assumption set beside the answer, version
 * it, and check the recommendation against the feeder if there is a model of one.
 *
 * The sizing search itself runs in `services/optimizer`, which already solves
 * dispatch: there is exactly one solver in the platform, and this is a client of
 * it. When it cannot be reached, a version is still stored — with status
 * `service_unavailable` and no sizing — because "the study was not run" is
 * evidence and a missing row is not.
 *
 * What this service will not do:
 *  - invent a load profile for an unmetered site (`refused`, with the reason);
 *  - report a tariff, diesel price, capex or emissions intensity nobody stated;
 *  - report a recommendation as network-approved when no power flow was solved.
 */

import { createHash } from 'node:crypto';

import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';

import { getDb } from '../db';
import {
  designStudies,
  designStudyVersions,
  type DesignStudy,
  type DesignStudyVersion,
} from '../../drizzle/design-study-schema';
import { gridNodeAssets, gridNodes } from '../../drizzle/locational-flexibility-schema';
import { MilpOptimizerError, getOptimizerServiceUrl, postToOptimizer } from './milp-dispatch';
import { studyFeasibility, type FeasibilityStatus } from './network-feasibility';
import type { SqlRow } from '../sql-row';

export type ProfileSource = 'metered' | 'declared' | 'sourced' | 'synthetic';
export type DesignStudyStatus =
  | 'optimal'
  | 'no_feasible_candidate'
  | 'service_unavailable'
  | 'refused';

export class DesignStudyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesignStudyError';
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
/** Cents per kWh x100 and months are the stored scales; kept in one place. */
export const SCALES = {
  centsPerKwhX100: 100,
  monthsPerYear: 12,
  partsPerMillion: 1_000_000,
} as const;

/* ------------------------------------------------------------------ requests */

export interface ProfileInput {
  source: ProfileSource;
  /** Watts per interval, in submission order. */
  loadW: number[];
  reference?: string;
}

export interface ResourceInput {
  kind: 'solar_pv' | 'wind';
  source: ProfileSource;
  /** Fraction of nameplate per interval, in the load profile's order. */
  capacityFactor: number[];
  reference?: string;
}

export interface BackupInput {
  kind: 'genset' | 'grid';
  maxW: number;
  energyCostCentsPerKwh: number;
  fuelLitresPerKwh?: number;
  emissionsGPerKwh?: number;
  /** Per-interval availability. Absent means assumed available throughout. */
  available?: boolean[];
}

export interface EconomicsInput {
  discountRatePercent: number;
  projectYears: number;
  pvCapexCentsPerKw?: number;
  windCapexCentsPerKw?: number;
  batteryCapexCentsPerKwh?: number;
  inverterCapexCentsPerKw?: number;
  backupCapexCents?: number;
  fixedOpexPercentOfCapexPerYear?: number;
  batteryReplacementYear?: number;
  batteryReplacementFraction?: number;
}

export interface SweepInput {
  pvKw?: number[];
  windKw?: number[];
  batteryKwh?: number[];
  batteryPowerRatio?: number;
  batteryRoundTripEfficiency?: number;
  batteryUsableFraction?: number;
}

export interface RunStudyInput {
  reference: string;
  siteName: string;
  /** Node the site would connect at. Required to check the recommendation. */
  nodeId?: number;
  notes?: string;
  intervalMinutes: number;
  /**
   * The load. Either submitted outright, or measured from the assets behind
   * `nodeId` by setting `meterDays`. There is no third option: a site with
   * neither is refused.
   */
  load?: ProfileInput;
  meterDays?: number;
  resources: ResourceInput[];
  backup: BackupInput;
  economics: EconomicsInput;
  sweep: SweepInput;
  maxUnmetFraction: number;
  tariffCentsPerKwh?: number;
  dispatchCheck?: boolean;
  /** Solve the recommendation against the feeder. Needs `nodeId`. */
  checkNetwork?: boolean;
  requestedByUserId?: number;
  now?: Date;
  timeoutMs?: number;
}

/* ----------------------------------------------------- optimizer wire format */

interface OptimizerRequest {
  interval_minutes: number;
  load: { source: ProfileSource; load_w: number[]; reference: string | null };
  resources: {
    kind: string;
    source: ProfileSource;
    capacity_factor: number[];
    reference: string | null;
  }[];
  backup: {
    kind: string;
    max_w: number;
    energy_cost_cents_per_kwh: number;
    fuel_litres_per_kwh: number | null;
    emissions_g_per_kwh: number | null;
    available: boolean[] | null;
  };
  economics: Record<string, number>;
  sweep: Record<string, number | number[]>;
  max_unmet_fraction: number;
  tariff_cents_per_kwh: number | null;
  dispatch_check: boolean;
}

interface OptimizerCandidate {
  pv_kw: number;
  wind_kw: number;
  battery_kwh: number;
  battery_kw: number;
  demand_kwh_per_year: number;
  served_kwh_per_year: number;
  unmet_kwh_per_year: number;
  unmet_fraction: number;
  renewable_kwh_per_year: number;
  curtailed_kwh_per_year: number;
  backup_kwh_per_year: number;
  renewable_fraction: number;
  fuel_litres_per_year: number | null;
  emissions_kg_per_year: number | null;
  capex_cents: number;
  annual_fixed_opex_cents: number;
  annual_fuel_cents: number;
  lcoe_cents_per_kwh: number | null;
  payback_years: number | null;
  annual_revenue_cents: number | null;
  meets_unmet_limit: boolean;
}

interface OptimizerBaseline {
  kind: string;
  served_kwh_per_year: number;
  unmet_kwh_per_year: number;
  fuel_litres_per_year: number | null;
  emissions_kg_per_year: number | null;
  annual_energy_cents: number;
  lcoe_cents_per_kwh: number | null;
}

interface OptimizerProvenance {
  load_source: ProfileSource;
  load_reference: string | null;
  resource_sources: Record<string, ProfileSource>;
  resource_references: Record<string, string | null>;
  days_simulated: number;
  annualisation_factor: number;
  backup_availability: 'declared_per_interval' | 'assumed_always_available';
  notes: string[];
}

interface OptimizerDispatchCheck {
  ran: boolean;
  status: string | null;
  reason: string | null;
  day_index: number | null;
  rule_based_unserved_wh: number | null;
  optimised_unserved_wh: number | null;
}

interface OptimizerResponse {
  status: 'optimal' | 'no_feasible_candidate';
  reason: string | null;
  interval_minutes: number;
  recommended: OptimizerCandidate | null;
  baseline: OptimizerBaseline;
  candidates: OptimizerCandidate[];
  provenance: OptimizerProvenance;
  dispatch_check: OptimizerDispatchCheck;
  diagnostics: Record<string, string | number | boolean>;
}

/* ------------------------------------------------------------------- results */

export interface DesignStudyNetworkCheck {
  /** Null means the wires were not checked, never that they were found fine. */
  status: FeasibilityStatus | null;
  studyId: number | null;
  reason: string | null;
  limitingElement: string | null;
}

export interface DesignStudyResult {
  status: DesignStudyStatus;
  reason: string | null;
  studyId: number | null;
  versionId: number | null;
  version: number | null;
  inputDigest: string;
  recommended: OptimizerCandidate | null;
  baseline: OptimizerBaseline | null;
  candidates: OptimizerCandidate[];
  provenance: OptimizerProvenance | null;
  dispatchCheck: OptimizerDispatchCheck | null;
  network: DesignStudyNetworkCheck;
}

/* ------------------------------------------------------- metered load loading */

export interface MeteredProfile {
  loadW: number[];
  intervals: number;
  assets: number;
  from: Date;
  to: Date;
}

export type LoadedProfile =
  | { available: true; profile: MeteredProfile }
  | { available: false; reason: string };

/**
 * Build a load profile from the meters behind a node.
 *
 * Telemetry is generation-positive across the platform, so consumption is the
 * negative part; a site's load is the sum of consumption over its assets in each
 * interval. An interval no asset reported in is *not* zero load — that is a
 * silent meter, and reading it as zero would size a system for a demand the site
 * does not have. The whole profile is refused instead, naming how much of it was
 * missing, so the caller either fixes the metering or submits a declared profile
 * and wears the label.
 */
export async function loadMeteredProfile(input: {
  nodeId: number;
  days: number;
  intervalMinutes: number;
  now?: Date;
}): Promise<LoadedProfile> {
  const db = await getDb();
  if (!db) return { available: false, reason: 'no database is configured' };
  if (!Number.isInteger(input.days) || input.days < 1) {
    return { available: false, reason: 'meterDays must be a whole number of days, at least 1' };
  }
  if (1440 % input.intervalMinutes !== 0) {
    return {
      available: false,
      reason: `an interval of ${input.intervalMinutes} minutes does not divide a day evenly`,
    };
  }

  const assets = await db
    .select({ assetId: gridNodeAssets.assetId })
    .from(gridNodeAssets)
    .where(eq(gridNodeAssets.nodeId, input.nodeId));
  if (assets.length === 0) {
    return {
      available: false,
      reason: `no assets are linked to grid node ${input.nodeId}: there is no meter to read a load from`,
    };
  }

  const perDay = 1440 / input.intervalMinutes;
  const intervals = perDay * input.days;
  const now = input.now ?? new Date();
  // Whole intervals only, so the first and last bucket are not part-length.
  const stepMs = input.intervalMinutes * 60_000;
  const to = new Date(Math.floor(now.getTime() / stepMs) * stepMs);
  const from = new Date(to.getTime() - intervals * stepMs);

  const rows = await db.execute<SqlRow>(sql`
    SELECT
      FLOOR(EXTRACT(EPOCH FROM (t.timestamp - ${from}::timestamp)) / ${input.intervalMinutes * 60})::int AS bucket,
      SUM(CASE WHEN t.power < 0 THEN -t.power ELSE 0 END)::float AS load_w,
      COUNT(DISTINCT t."assetId")::int AS reporting_assets
    FROM telemetry t
    WHERE t."assetId" IN (${sql.join(
      assets.map(row => sql`${row.assetId}`),
      sql`, `
    )})
      AND t.timestamp >= ${from}
      AND t.timestamp < ${to}
      AND t.power IS NOT NULL
    GROUP BY bucket
  `);

  const loadW = new Array<number | null>(intervals).fill(null);
  for (const row of rows.rows ?? []) {
    const bucket = Number(row.bucket);
    if (!Number.isInteger(bucket) || bucket < 0 || bucket >= intervals) continue;
    loadW[bucket] = Number(row.load_w);
  }

  const missing = loadW.filter(value => value === null).length;
  if (missing > 0) {
    return {
      available: false,
      reason:
        `${missing} of ${intervals} intervals between ${from.toISOString()} and ` +
        `${to.toISOString()} have no telemetry from the ${assets.length} asset(s) at node ` +
        `${input.nodeId}: an unmetered interval is a silent meter, not zero demand. Submit a ` +
        'declared or synthetic profile if the site is not fully metered',
    };
  }
  if (loadW.every(value => value === 0)) {
    return {
      available: false,
      reason: `every metered interval at node ${input.nodeId} reads zero consumption: there is no load to size against`,
    };
  }

  return {
    available: true,
    profile: {
      loadW: loadW.map(value => value ?? 0),
      intervals,
      assets: assets.length,
      from,
      to,
    },
  };
}

/* ------------------------------------------------------------------ the study */

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, item]) => [key, canonicalise(item)]));
  }
  return value;
}

/** Digest of the frozen assumption set: same inputs, same digest, always. */
export function inputDigest(request: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalise(request))).digest('hex');
}

function optimizerRequest(input: RunStudyInput, load: ProfileInput): OptimizerRequest {
  const economics: Record<string, number> = {
    discount_rate_percent: input.economics.discountRatePercent,
    project_years: input.economics.projectYears,
  };
  const optional: [string, number | undefined][] = [
    ['pv_capex_cents_per_kw', input.economics.pvCapexCentsPerKw],
    ['wind_capex_cents_per_kw', input.economics.windCapexCentsPerKw],
    ['battery_capex_cents_per_kwh', input.economics.batteryCapexCentsPerKwh],
    ['inverter_capex_cents_per_kw', input.economics.inverterCapexCentsPerKw],
    ['backup_capex_cents', input.economics.backupCapexCents],
    [
      'fixed_opex_percent_of_capex_per_year',
      input.economics.fixedOpexPercentOfCapexPerYear,
    ],
    ['battery_replacement_year', input.economics.batteryReplacementYear],
    ['battery_replacement_fraction', input.economics.batteryReplacementFraction],
  ];
  for (const [key, value] of optional) {
    if (value !== undefined) economics[key] = value;
  }

  const sweep: Record<string, number | number[]> = {};
  if (input.sweep.pvKw !== undefined) sweep.pv_kw = input.sweep.pvKw;
  if (input.sweep.windKw !== undefined) sweep.wind_kw = input.sweep.windKw;
  if (input.sweep.batteryKwh !== undefined) sweep.battery_kwh = input.sweep.batteryKwh;
  if (input.sweep.batteryPowerRatio !== undefined) {
    sweep.battery_power_ratio = input.sweep.batteryPowerRatio;
  }
  if (input.sweep.batteryRoundTripEfficiency !== undefined) {
    sweep.battery_round_trip_efficiency = input.sweep.batteryRoundTripEfficiency;
  }
  if (input.sweep.batteryUsableFraction !== undefined) {
    sweep.battery_usable_fraction = input.sweep.batteryUsableFraction;
  }

  return {
    interval_minutes: input.intervalMinutes,
    load: {
      source: load.source,
      load_w: load.loadW,
      reference: load.reference ?? null,
    },
    resources: input.resources.map(resource => ({
      kind: resource.kind,
      source: resource.source,
      capacity_factor: resource.capacityFactor,
      reference: resource.reference ?? null,
    })),
    backup: {
      kind: input.backup.kind,
      max_w: input.backup.maxW,
      energy_cost_cents_per_kwh: input.backup.energyCostCentsPerKwh,
      fuel_litres_per_kwh: input.backup.fuelLitresPerKwh ?? null,
      emissions_g_per_kwh: input.backup.emissionsGPerKwh ?? null,
      available: input.backup.available ?? null,
    },
    economics,
    sweep,
    max_unmet_fraction: input.maxUnmetFraction,
    tariff_cents_per_kwh: input.tariffCentsPerKwh ?? null,
    dispatch_check: input.dispatchCheck ?? false,
  };
}

/**
 * Run one study for one site and store it as the next version.
 *
 * The load is resolved first, and a site with neither a submitted profile nor
 * complete metering is refused before the optimizer is called at all: there is
 * no default load, and a study on an invented one is worse than no study.
 */
export async function runDesignStudy(input: RunStudyInput): Promise<DesignStudyResult> {
  const load = await resolveLoad(input);
  if (!load.resolved) {
    return persist(input, {
      status: 'refused',
      reason: load.reason,
      request: { refused_before_call: true, node_id: input.nodeId ?? null, reason: load.reason },
      response: null,
      loadSource: input.load?.source ?? 'metered',
      loadReference: input.load?.reference ?? null,
      result: null,
      network: emptyNetworkCheck(),
    });
  }

  const request = optimizerRequest(input, load.profile);
  if (getOptimizerServiceUrl() === undefined) {
    const reason =
      'OPTIMIZER_SERVICE_URL is not set: the sizing search runs in the optimizer service, and no study was run';
    return persist(input, {
      status: 'service_unavailable',
      reason,
      request,
      response: null,
      loadSource: load.profile.source,
      loadReference: load.profile.reference ?? null,
      result: null,
      network: emptyNetworkCheck(),
    });
  }

  let response: OptimizerResponse;
  try {
    response = await postToOptimizer<OptimizerRequest, OptimizerResponse>(
      '/design/study',
      request,
      input.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
  } catch (error) {
    const reason =
      error instanceof MilpOptimizerError ? error.message : String(error);
    // A 4xx is the engine rejecting these assumptions — an inconsistent
    // profile length, a missing cost — and that is a refusal of this study,
    // not a service that was not there. Recording it as unavailable would
    // invite a pointless retry and hide the input that was wrong.
    const rejected =
      error instanceof MilpOptimizerError &&
      error.statusCode !== undefined &&
      error.statusCode >= 400 &&
      error.statusCode < 500;
    return persist(input, {
      status: rejected ? 'refused' : 'service_unavailable',
      reason: reason.slice(0, 500),
      request,
      response: null,
      loadSource: load.profile.source,
      loadReference: load.profile.reference ?? null,
      result: null,
      network: emptyNetworkCheck(),
    });
  }

  const network =
    response.status === 'optimal' && response.recommended !== null
      ? await checkNetwork(input, response.recommended)
      : emptyNetworkCheck();

  return persist(input, {
    status: response.status,
    reason: response.reason,
    request,
    response,
    loadSource: response.provenance.load_source,
    loadReference: response.provenance.load_reference,
    result: response,
    network,
  });
}

type ResolvedLoad =
  | { resolved: true; profile: ProfileInput }
  | { resolved: false; reason: string };

async function resolveLoad(input: RunStudyInput): Promise<ResolvedLoad> {
  if (input.load !== undefined) {
    if (input.load.loadW.length === 0) {
      return { resolved: false, reason: 'the submitted load profile is empty' };
    }
    return { resolved: true, profile: input.load };
  }
  if (input.meterDays === undefined || input.nodeId === undefined) {
    return {
      resolved: false,
      reason:
        'no load profile was submitted and no metered site was named: a study needs measured or ' +
        'declared demand, and this service will not substitute one',
    };
  }
  const metered = await loadMeteredProfile({
    nodeId: input.nodeId,
    days: input.meterDays,
    intervalMinutes: input.intervalMinutes,
    now: input.now,
  });
  if (!metered.available) return { resolved: false, reason: metered.reason };
  return {
    resolved: true,
    profile: {
      source: 'metered',
      loadW: metered.profile.loadW,
      reference:
        `node ${input.nodeId}, ${metered.profile.assets} asset(s), ` +
        `${metered.profile.from.toISOString()}..${metered.profile.to.toISOString()}`,
    },
  };
}

function emptyNetworkCheck(): DesignStudyNetworkCheck {
  return { status: null, studyId: null, reason: null, limitingElement: null };
}

/**
 * Solve the recommendation against the feeder it would connect to.
 *
 * The candidate injection is the recommended nameplate: the worst case the site
 * can present to the network is everything generating and nothing consuming, and
 * a feeder that survives that survives the rest. A study run without a node, or
 * one the caller did not ask to check, leaves the status null — unchecked — and
 * a `model_unavailable` answer stays `model_unavailable`.
 */
async function checkNetwork(
  input: RunStudyInput,
  recommended: OptimizerCandidate
): Promise<DesignStudyNetworkCheck> {
  if (input.checkNetwork !== true) return emptyNetworkCheck();
  if (input.nodeId === undefined) {
    return {
      status: null,
      studyId: null,
      reason: 'no grid node was named, so there is no feeder to check the recommendation against',
      limitingElement: null,
    };
  }
  const db = await getDb();
  if (!db) {
    return { status: null, studyId: null, reason: 'no database is configured', limitingElement: null };
  }
  const nodeRows = await db
    .select({ code: gridNodes.code })
    .from(gridNodes)
    .where(eq(gridNodes.id, input.nodeId))
    .limit(1);
  const code = nodeRows[0]?.code;
  if (code === undefined) {
    return {
      status: null,
      studyId: null,
      reason: `grid node ${input.nodeId} does not exist`,
      limitingElement: null,
    };
  }

  const injectionW = (recommended.pv_kw + recommended.wind_kw + recommended.battery_kw) * 1_000;
  const study = await studyFeasibility({
    subject: 'connection_enquiry',
    subjectReference: `design:${input.reference}`,
    nodeId: input.nodeId,
    candidate: [
      {
        bus: code,
        delta_p_w: injectionW,
        reference: `design study ${input.reference}: recommended nameplate injection`,
      },
    ],
    requestedByUserId: input.requestedByUserId,
    now: input.now,
  });
  return {
    status: study.status,
    studyId: study.studyId,
    reason: study.reason,
    limitingElement: study.limitingElement,
  };
}

interface PersistInput {
  status: DesignStudyStatus;
  reason: string | null;
  request: unknown;
  response: OptimizerResponse | null;
  loadSource: ProfileSource;
  loadReference: string | null;
  result: OptimizerResponse | null;
  network: DesignStudyNetworkCheck;
}

/** Round-half-up to a whole number, or null. Never a silent zero. */
function scaled(value: number | null | undefined, factor: number): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.round(value * factor);
}

async function persist(
  input: RunStudyInput,
  outcome: PersistInput
): Promise<DesignStudyResult> {
  const digest = inputDigest(outcome.request);
  const recommended = outcome.result?.recommended ?? null;
  const baseline = outcome.result?.baseline ?? null;
  const result: DesignStudyResult = {
    status: outcome.status,
    reason: outcome.reason,
    studyId: null,
    versionId: null,
    version: null,
    inputDigest: digest,
    recommended,
    baseline,
    candidates: outcome.result?.candidates ?? [],
    provenance: outcome.result?.provenance ?? null,
    dispatchCheck: outcome.result?.dispatch_check ?? null,
    network: outcome.network,
  };

  const db = await getDb();
  if (!db) return result;

  const study = await upsertStudy(input);
  result.studyId = study.id;

  const fuelSaved =
    recommended !== null &&
    baseline?.fuel_litres_per_year !== null &&
    baseline?.fuel_litres_per_year !== undefined &&
    recommended.fuel_litres_per_year !== null
      ? baseline.fuel_litres_per_year - recommended.fuel_litres_per_year
      : null;
  const emissionsSaved =
    recommended !== null &&
    baseline?.emissions_kg_per_year !== null &&
    baseline?.emissions_kg_per_year !== undefined &&
    recommended.emissions_kg_per_year !== null
      ? baseline.emissions_kg_per_year - recommended.emissions_kg_per_year
      : null;

  const values = {
    studyId: study.id,
    version: 0,
    status: outcome.status,
    reason: outcome.reason?.slice(0, 500) ?? null,
    inputDigest: digest,
    request: outcome.request,
    response: outcome.response,
    loadSource: outcome.loadSource,
    loadReference: outcome.loadReference?.slice(0, 200) ?? null,
    recommendedPvW: recommended === null ? null : Math.round(recommended.pv_kw * 1_000),
    recommendedWindW: recommended === null ? null : Math.round(recommended.wind_kw * 1_000),
    recommendedBatteryWh:
      recommended === null ? null : Math.round(recommended.battery_kwh * 1_000),
    recommendedBatteryW: recommended === null ? null : Math.round(recommended.battery_kw * 1_000),
    unmetPpm:
      recommended === null ? null : Math.round(recommended.unmet_fraction * SCALES.partsPerMillion),
    lcoeCentsPerKwhX100:
      recommended === null
        ? null
        : scaled(recommended.lcoe_cents_per_kwh, SCALES.centsPerKwhX100),
    paybackMonths:
      recommended === null ? null : scaled(recommended.payback_years, SCALES.monthsPerYear),
    capexCents: recommended === null ? null : Math.round(recommended.capex_cents),
    fuelLitresSavedPerYear: scaled(fuelSaved, 1),
    emissionsKgSavedPerYear: scaled(emissionsSaved, 1),
    networkStudyId: outcome.network.studyId,
    networkStatus: outcome.network.studyId === null ? null : outcome.network.status,
    createdByUserId: input.requestedByUserId ?? null,
  };

  // Version numbers are allocated from the rows that exist, and the unique
  // constraint on (study, version) is the arbiter: two studies started at once
  // cannot both be version 3.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const latest = await db
      .select({ version: designStudyVersions.version })
      .from(designStudyVersions)
      .where(eq(designStudyVersions.studyId, study.id))
      .orderBy(desc(designStudyVersions.version))
      .limit(1);
    const version = (latest[0]?.version ?? 0) + 1;
    try {
      const inserted = await db
        .insert(designStudyVersions)
        .values({ ...values, version })
        .returning({ id: designStudyVersions.id, version: designStudyVersions.version });
      result.versionId = inserted[0]?.id ?? null;
      result.version = inserted[0]?.version ?? null;
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/design_study_versions_study_version_unique/.test(message)) {
        // The study still stands on what it concluded, but losing the record of
        // it must be visible: a refusal nobody can find is not evidence.
        console.error(
          `[design-study] could not store version for ${input.reference}: ${message}`
        );
        return result;
      }
    }
  }
  console.error(
    `[design-study] gave up allocating a version number for ${input.reference} after 5 attempts`
  );
  return result;
}

async function upsertStudy(input: RunStudyInput): Promise<DesignStudy> {
  const db = await getDb();
  if (!db) throw new DesignStudyError('Database not available');
  const values = {
    reference: input.reference.trim(),
    siteName: input.siteName.trim(),
    nodeId: input.nodeId ?? null,
    notes: input.notes?.slice(0, 500) ?? null,
    createdByUserId: input.requestedByUserId ?? null,
  };
  const rows = await db
    .insert(designStudies)
    .values(values)
    .onConflictDoUpdate({
      target: designStudies.reference,
      set: {
        siteName: values.siteName,
        nodeId: values.nodeId,
        notes: values.notes,
        updatedAt: new Date(),
      },
    })
    .returning();
  const study = rows[0];
  if (study === undefined) throw new DesignStudyError('Design study insert returned no row');
  return study;
}

/* -------------------------------------------------------------------- reading */

export interface StudySummary {
  id: number;
  reference: string;
  siteName: string;
  nodeId: number | null;
  versions: number;
  latestVersion: number | null;
  latestStatus: DesignStudyStatus | null;
  latestAt: Date | null;
  updatedAt: Date;
}

export async function listStudies(limit = 100): Promise<StudySummary[]> {
  const db = await getDb();
  if (!db) return [];
  const studies = await db
    .select()
    .from(designStudies)
    .orderBy(desc(designStudies.updatedAt))
    .limit(limit);
  if (studies.length === 0) return [];

  const versions = await db
    .select({
      studyId: designStudyVersions.studyId,
      version: designStudyVersions.version,
      status: designStudyVersions.status,
      createdAt: designStudyVersions.createdAt,
    })
    .from(designStudyVersions)
    .where(
      inArray(
        designStudyVersions.studyId,
        studies.map(study => study.id)
      )
    )
    .orderBy(desc(designStudyVersions.version));

  return studies.map(study => {
    const own = versions.filter(row => row.studyId === study.id);
    const latest = own[0];
    return {
      id: study.id,
      reference: study.reference,
      siteName: study.siteName,
      nodeId: study.nodeId,
      versions: own.length,
      latestVersion: latest?.version ?? null,
      latestStatus: latest?.status ?? null,
      latestAt: latest?.createdAt ?? null,
      updatedAt: study.updatedAt,
    };
  });
}

/** Versions of one study, newest first. Nothing here is ever rewritten. */
export async function studyVersions(
  studyId: number,
  limit = 50
): Promise<DesignStudyVersion[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(designStudyVersions)
    .where(eq(designStudyVersions.studyId, studyId))
    .orderBy(desc(designStudyVersions.version))
    .limit(limit);
}

export async function getStudyVersion(versionId: number): Promise<DesignStudyVersion | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(designStudyVersions)
    .where(eq(designStudyVersions.id, versionId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Versions sharing a digest: the same question asked twice.
 *
 * Two of these with different sizings mean the engine is not deterministic,
 * which is a defect rather than a business change, and this is how it is found.
 */
export async function versionsWithDigest(
  digest: string,
  limit = 20
): Promise<DesignStudyVersion[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(designStudyVersions)
    .where(eq(designStudyVersions.inputDigest, digest))
    .orderBy(desc(designStudyVersions.createdAt))
    .limit(limit);
}

/** Studies created in a window, for the planning surfaces. */
export async function studiesBetween(from: Date, to: Date): Promise<DesignStudyVersion[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(designStudyVersions)
    .where(
      and(gte(designStudyVersions.createdAt, from), lte(designStudyVersions.createdAt, to))
    )
    .orderBy(desc(designStudyVersions.createdAt));
}
