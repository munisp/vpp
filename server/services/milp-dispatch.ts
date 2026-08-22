/**
 * Client for the MILP dispatch optimizer service (services/optimizer).
 *
 * The service solves a mixed-integer linear program over the whole horizon and
 * every asset at once. It never returns a schedule it did not prove optimal, so
 * any non-2xx response here is a failure to propagate, not a cue to fall back to
 * a heuristic and present the result as optimized.
 */

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

async function post<TRequest, TResponse>(
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

export async function optimizerHealth(): Promise<{ solver: string; available_solvers: string[] }> {
  const baseUrl = getOptimizerServiceUrl();
  if (!baseUrl) throw new MilpOptimizerError('OPTIMIZER_SERVICE_URL is not set');
  const response = await fetch(`${baseUrl}/health`);
  if (!response.ok) {
    throw new MilpOptimizerError(`optimizer health check failed with HTTP ${response.status}`);
  }
  return (await response.json()) as { solver: string; available_solvers: string[] };
}
