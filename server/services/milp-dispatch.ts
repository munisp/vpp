/**
 * Client for the MILP dispatch optimizer service (services/optimizer).
 *
 * The service solves a mixed-integer linear program over the whole horizon and
 * every asset at once. It never returns a schedule it did not prove optimal, so
 * any non-2xx response here is a failure to propagate, not a cue to fall back to
 * a heuristic and present the result as optimized.
 */

import { inArray, eq } from 'drizzle-orm';

import { getDb } from '../db';
import { gridNodeAssets, gridNodes } from '../../drizzle/locational-flexibility-schema';
import { observing } from './degraded-operation';
import {
  studyFeasibility,
  worstViolation,
  type FeasibilityStatus,
  type FeasibilityViolation,
} from './network-feasibility';

export type MilpObjective =
  | 'minimize_cost'
  | 'maximize_revenue'
  | 'minimize_emissions'
  | 'maximize_self_consumption'
  | 'balance_grid';

export interface MilpBatterySpec {
  capacity_wh: number;
  max_charge_w: number;
  max_discharge_w: number;
  initial_soc_percent: number;
  soc_min_percent?: number;
  soc_max_percent?: number;
  charge_efficiency?: number;
  discharge_efficiency?: number;
  cycle_cost_cents_per_kwh?: number;
  terminal_soc_percent?: number | null;
}

export interface MilpGenerationSpec {
  available_w: number[];
  curtailable?: boolean;
}

export interface MilpAsset {
  asset_id: string;
  asset_type: 'battery' | 'generation' | 'flexible_load';
  battery?: MilpBatterySpec;
  generation?: MilpGenerationSpec;
  flexible_load?: {
    baseline_w: number[];
    sheddable_fraction?: number;
    shed_cost_cents_per_kwh?: number;
  };
}

export interface MilpDispatchRequest {
  interval_minutes: number;
  site: {
    site_id: string;
    assets: MilpAsset[];
    load_w: number[];
    max_import_w: number;
    max_export_w: number;
    unserved_load_cost_cents_per_kwh?: number;
  };
  prices: {
    import_cents_per_kwh: number[];
    export_cents_per_kwh: number[];
    grid_emissions_g_per_kwh?: number[] | null;
  };
  objective: MilpObjective;
  grid_target_w?: number[] | null;
  solver_time_limit_seconds?: number;
  solver_relative_gap?: number;
}

export interface MilpAssetSetpoint {
  asset_id: string;
  power_w: number;
  soc_percent: number | null;
  curtailed_w: number | null;
  shed_w: number | null;
}

export interface MilpIntervalPlan {
  index: number;
  offset_minutes: number;
  grid_import_w: number;
  grid_export_w: number;
  unserved_load_w: number;
  setpoints: MilpAssetSetpoint[];
}

export interface MilpDispatchResponse {
  status: 'optimal' | 'infeasible' | 'unbounded' | 'not_solved' | 'not_converged';
  solver: string;
  objective: MilpObjective;
  interval_minutes: number;
  horizon: number;
  totals: {
    objective_value_cents: number;
    import_cost_cents: number;
    export_revenue_cents: number;
    cycle_cost_cents: number;
    unserved_load_cost_cents: number;
    shed_cost_cents: number;
    emissions_g: number | null;
    imported_wh: number;
    exported_wh: number;
    curtailed_wh: number;
    unserved_wh: number;
  };
  intervals: MilpIntervalPlan[];
  diagnostics: Record<string, string | number | boolean>;
}

export class MilpOptimizerError extends Error {
  readonly statusCode?: number;
  readonly solveStatus?: string;

  constructor(message: string, options?: { statusCode?: number; solveStatus?: string }) {
    super(message);
    this.name = 'MilpOptimizerError';
    this.statusCode = options?.statusCode;
    this.solveStatus = options?.solveStatus;
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

export function getOptimizerServiceUrl(): string | undefined {
  const url = process.env.OPTIMIZER_SERVICE_URL?.trim();
  return url ? url.replace(/\/$/, '') : undefined;
}

export function isMilpOptimizerConfigured(): boolean {
  return getOptimizerServiceUrl() !== undefined;
}

/**
 * Production must not run dispatch on the heuristic engine: its per-asset,
 * per-interval rules ignore intertemporal state and cannot honour SoC or grid
 * limits over a horizon.
 */
export function assertMilpOptimizerConfigured(): void {
  if (isMilpOptimizerConfigured()) return;
  if (process.env.NODE_ENV === 'production') {
    throw new MilpOptimizerError(
      'OPTIMIZER_SERVICE_URL is not set: the MILP dispatch optimizer is required in production'
    );
  }
}

/**
 * Every call to the optimizer is recorded as an observation of it, on both the
 * success and the failure path, so `dependencyPostures()` reports what real
 * traffic saw rather than what a health endpoint claims. An HTTP answer counts
 * as `faulted` (it is up, but not usable); a transport failure or timeout counts
 * as `unreachable`.
 */
async function post<TRequest, TResponse>(
  path: string,
  body: TRequest,
  timeoutMs: number
): Promise<TResponse> {
  return observing(
    {
      dependency: 'optimizer',
      observedBy: 'server',
      operation: `POST ${path}`,
      faultedWhen: error => error instanceof MilpOptimizerError && error.statusCode !== undefined,
    },
    () => postOnce<TRequest, TResponse>(path, body, timeoutMs)
  );
}

async function postOnce<TRequest, TResponse>(
  path: string,
  body: TRequest,
  timeoutMs: number
): Promise<TResponse> {
  const baseUrl = getOptimizerServiceUrl();
  if (!baseUrl) {
    throw new MilpOptimizerError('OPTIMIZER_SERVICE_URL is not set');
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = process.env.OPTIMIZER_AUTH_TOKEN;
  if (token) headers['x-optimizer-token'] = token;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      let solveStatus: string | undefined;
      try {
        const parsed = JSON.parse(text) as { detail?: { status?: string } | string };
        if (parsed.detail && typeof parsed.detail === 'object') {
          solveStatus = parsed.detail.status;
        }
      } catch {
        // Non-JSON error body; the raw text is still reported below.
      }
      throw new MilpOptimizerError(
        `optimizer ${path} failed with HTTP ${response.status}: ${text}`,
        { statusCode: response.status, solveStatus }
      );
    }

    return JSON.parse(text) as TResponse;
  } catch (error) {
    if (error instanceof MilpOptimizerError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new MilpOptimizerError(`optimizer ${path} timed out after ${timeoutMs}ms`);
    }
    throw new MilpOptimizerError(
      `optimizer ${path} is unreachable: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function solveMilpDispatch(
  request: MilpDispatchRequest,
  options?: { timeoutMs?: number }
): Promise<MilpDispatchResponse> {
  const result = await post<MilpDispatchRequest, MilpDispatchResponse>(
    '/optimize/dispatch',
    request,
    options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );
  if (result.status !== 'optimal') {
    throw new MilpOptimizerError(
      `optimizer returned status ${result.status} without a proven-optimal schedule`,
      { solveStatus: result.status }
    );
  }
  return result;
}

/**
 * The network verdict on a solved plan.
 *
 * `no_linked_node` is separate from `model_unavailable`: the first says the
 * platform does not know where these assets are on the network, the second says
 * it knows where they are but not what the network there is made of. Both leave
 * the plan network-unchecked, and neither may be reported as a plan the network
 * can carry.
 */
export interface PlanNetworkCheck {
  status: FeasibilityStatus | 'no_linked_node';
  /** True only for a solved study inside every limit. */
  checked: boolean;
  studyId: number | null;
  nodeCode: string | null;
  reason: string | null;
  limitingElement: string | null;
  violations: FeasibilityViolation[];
  /** The violation furthest past its limit, when there is one. */
  worst: FeasibilityViolation | null;
  /** Interval index the study was run for: the plan's heaviest. */
  intervalIndex: number | null;
}

/**
 * Check a solved plan against the network it would run over.
 *
 * The whole horizon is not solved bus-by-bus: the binding case is the interval
 * where the plan pushes the most power through a node, so that interval is the
 * one studied, per node. A plan that survives its own worst interval survives
 * the rest; a plan that fails it must not be issued whichever other intervals
 * are comfortable.
 */
export async function checkPlanAgainstNetwork(
  plan: MilpDispatchResponse,
  options: { assetIds: number[]; subjectReference?: string }
): Promise<PlanNetworkCheck> {
  const empty = {
    checked: false,
    studyId: null,
    nodeCode: null,
    limitingElement: null,
    violations: [] as FeasibilityViolation[],
    worst: null,
    intervalIndex: null,
  };
  if (options.assetIds.length === 0) {
    return {
      ...empty,
      status: 'no_linked_node',
      reason: 'the plan contains no assets to locate on the network',
    };
  }

  const located = await nodesForAssets(options.assetIds);
  if (located.size === 0) {
    return {
      ...empty,
      status: 'no_linked_node',
      reason:
        'no asset in this plan is linked to a grid node, so there is no place on the network to check it against',
    };
  }

  // Worst interval per node, in the net-injection direction the solver reports:
  // a setpoint is positive when the asset exports.
  const worstByNode = new Map<number, { intervalIndex: number; deltaW: number }>();
  for (const interval of plan.intervals) {
    const perNode = new Map<number, number>();
    for (const setpoint of interval.setpoints) {
      const nodeId = located.get(Number(setpoint.asset_id));
      if (nodeId === undefined) continue;
      perNode.set(nodeId, (perNode.get(nodeId) ?? 0) + setpoint.power_w);
    }
    for (const [nodeId, deltaW] of perNode) {
      const current = worstByNode.get(nodeId);
      if (current === undefined || Math.abs(deltaW) > Math.abs(current.deltaW)) {
        worstByNode.set(nodeId, { intervalIndex: interval.index, deltaW });
      }
    }
  }

  let firstUnchecked: PlanNetworkCheck | null = null;
  let lastFeasible: PlanNetworkCheck | null = null;

  for (const [nodeId, worst] of worstByNode) {
    const nodeCode = await gridNodeCode(nodeId);
    const study = await studyFeasibility({
      subject: 'dispatch',
      subjectReference: options.subjectReference,
      nodeId,
      candidate:
        nodeCode === null
          ? []
          : [{ bus: nodeCode, delta_p_w: worst.deltaW, reference: `dispatch-node-${nodeId}` }],
    });
    const result: PlanNetworkCheck = {
      status: study.status,
      checked: study.status === 'feasible',
      studyId: study.studyId,
      nodeCode,
      reason: study.reason,
      limitingElement: study.limitingElement,
      violations: study.violations,
      worst: worstViolation(study.violations),
      intervalIndex: worst.intervalIndex,
    };
    // A violation anywhere decides the plan; there is no averaging a transformer.
    if (study.status === 'violations') return result;
    if (study.status === 'feasible') lastFeasible = result;
    else if (firstUnchecked === null) firstUnchecked = result;
  }

  return (
    firstUnchecked ??
    lastFeasible ?? {
      ...empty,
      status: 'model_unavailable',
      reason: 'no node in this plan produced a study',
    }
  );
}

/** Which node each asset sits behind, for the assets that have a declared link. */
async function nodesForAssets(assetIds: number[]): Promise<Map<number, number>> {
  const db = await getDb();
  if (!db) return new Map();
  const rows = await db
    .select({ assetId: gridNodeAssets.assetId, nodeId: gridNodeAssets.nodeId })
    .from(gridNodeAssets)
    .where(inArray(gridNodeAssets.assetId, assetIds));
  return new Map(rows.map(row => [row.assetId, row.nodeId]));
}

async function gridNodeCode(nodeId: number): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select({ code: gridNodes.code })
    .from(gridNodes)
    .where(eq(gridNodes.id, nodeId))
    .limit(1);
  return rows[0]?.code ?? null;
}

export interface CoordinationRequest {
  sites: Array<{ request: MilpDispatchRequest }>;
  shared_import_limit_w: number[];
  shared_export_limit_w?: number[] | null;
  /**
   * Aggregate net import the grid wants the fleet to follow. Two-sided, unlike
   * the cap: the coordination price may go negative to pay sites for absorbing
   * energy in an interval the fleet is under target.
   */
  shared_import_target_w?: number[] | null;
  max_iterations?: number;
  tolerance_w?: number;
  step_size_cents_per_kwh?: number;
}

export interface CoordinationResponse {
  status: MilpDispatchResponse['status'];
  solver: string;
  iterations: number;
  max_violation_w: number;
  converged: boolean;
  /** Coordination component of the price per interval, signed, cents/kWh. */
  shadow_prices_cents_per_kwh: number[];
  /** Aggregate net import of the plans the sites returned, per interval. */
  aggregate_net_w: number[];
  /** Signed distance from the target; null when the request carried only a cap. */
  target_deviation_w: number[] | null;
  sites: MilpDispatchResponse[];
  diagnostics: Record<string, string | number | boolean>;
}

/**
 * Coordinate several sites over a shared grid connection.
 *
 * Returns a non-converged result rather than throwing, because the caller needs
 * the residual to decide: an unconverged *cap* plan still breaches a physical
 * limit, whereas an unconverged *target* plan merely misses a profile. Neither
 * may be presented as a plan that met the request.
 */
export async function solveCoordination(
  request: CoordinationRequest,
  options?: { timeoutMs?: number }
): Promise<CoordinationResponse> {
  return post<CoordinationRequest, CoordinationResponse>(
    '/optimize/coordinate',
    request,
    options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );
}

export async function optimizerHealth(): Promise<{ solver: string; available_solvers: string[] }> {
  const baseUrl = getOptimizerServiceUrl();
  if (!baseUrl) throw new MilpOptimizerError('OPTIMIZER_SERVICE_URL is not set');
  const response = await fetch(`${baseUrl}/health`);
  if (!response.ok) {
    throw new MilpOptimizerError(`optimizer health check failed with HTTP ${response.status}`);
  }
  return (await response.json()) as { solver: string; available_solvers: string[] };
}
