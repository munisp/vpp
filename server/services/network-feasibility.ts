/**
 * Network feasibility: asking whether the wires can carry what the market just
 * decided to do.
 *
 * The platform sells flexibility at a node and dispatches setpoints behind it,
 * and until now nothing checked either against the network they run over. A
 * transformer does not care that an award cleared at a good price.
 *
 * This is the client half. The power flow itself is solved by
 * `services/gridmodel` (pandapower); here the electrical model is read out of
 * PostgreSQL, the study is stored as evidence, and — the part that matters — a
 * study that could not be run is reported as `model_unavailable` or
 * `service_unavailable`, never as `feasible`. A caller that cannot get a real
 * answer must label its decision network-unchecked; nothing in this file lets it
 * claim otherwise.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';

import { getDb } from '../db';
import { gridNodeAssets, gridNodes } from '../../drizzle/locational-flexibility-schema';
import {
  gridNetworkLines,
  gridNetworkTransformers,
  networkFeasibilityStudies,
} from '../../drizzle/network-model-schema';
import { observing } from './degraded-operation';
import type { SqlRow } from '../sql-row';

/** Statuses this layer can report. The first four come from the solver service. */
export type FeasibilityStatus =
  | 'feasible'
  | 'violations'
  | 'model_unavailable'
  | 'not_converged'
  /** The solver service itself could not be reached or refused. */
  | 'service_unavailable';

export type FeasibilitySubject = 'dispatch' | 'flexibility_clearing' | 'connection_enquiry';

export type ViolationKind =
  | 'bus_undervoltage'
  | 'bus_overvoltage'
  | 'line_loading'
  | 'transformer_loading';

export interface FeasibilityViolation {
  kind: ViolationKind;
  element: string;
  value: number;
  limit: number;
  candidate_references: string[];
}

export interface FeasibilityBusResult {
  code: string;
  vm_pu: number;
  va_degree: number;
  p_w: number;
  q_var: number;
  vm_pu_min: number;
  vm_pu_max: number;
}

export interface FeasibilityElementResult {
  code: string;
  kind: 'line' | 'transformer';
  loading_percent: number;
  limit_percent: number;
}

export interface HostingCapacityResult {
  bus: string;
  direction: 'injection' | 'consumption';
  headroom_w: number;
  limiting_element: string | null;
  limiting_kind: ViolationKind | null;
  capped: boolean;
  searched_to_w: number;
}

interface ServiceResponse {
  status: 'feasible' | 'violations' | 'model_unavailable' | 'not_converged';
  study_reference: string | null;
  reason: string | null;
  buses: FeasibilityBusResult[];
  elements: FeasibilityElementResult[];
  violations: FeasibilityViolation[];
  hosting_capacity: HostingCapacityResult[];
  diagnostics: Record<string, string | number | boolean>;
}

export interface NetworkInjection {
  bus: string;
  p_w: number;
  q_var?: number;
  reference?: string;
}

export interface CandidateChange {
  bus: string;
  /** Signed in the net-injection direction: positive exports, negative consumes. */
  delta_p_w: number;
  delta_q_var?: number;
  reference?: string;
}

export interface HostingCapacityQuery {
  bus: string;
  direction?: 'injection' | 'consumption';
  limit_w?: number;
}

export interface NetworkModelPayload {
  buses: {
    code: string;
    nominal_kv: number;
    kind: 'source' | 'node';
    vm_pu_min?: number;
    vm_pu_max?: number;
  }[];
  lines: {
    code: string;
    from_bus: string;
    to_bus: string;
    length_km: number;
    r_ohm_per_km: number;
    x_ohm_per_km: number;
    c_nf_per_km: number;
    max_i_ka: number;
    parallel: number;
  }[];
  transformers: {
    code: string;
    hv_bus: string;
    lv_bus: string;
    sn_mva: number;
    vn_hv_kv: number;
    vn_lv_kv: number;
    vk_percent: number;
    vkr_percent: number;
    pfe_kw: number;
    i0_percent: number;
  }[];
}

/** The model as loaded, or the reason there is no usable model. */
export type LoadedNetworkModel =
  | { available: true; network: NetworkModelPayload; nodeIdsByCode: Map<string, number> }
  | { available: false; reason: string };

export class NetworkFeasibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkFeasibilityError';
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;

export function getGridModelServiceUrl(): string | undefined {
  const url = process.env.GRIDMODEL_SERVICE_URL?.trim();
  return url ? url.replace(/\/$/, '') : undefined;
}

export function isNetworkFeasibilityConfigured(): boolean {
  return getGridModelServiceUrl() !== undefined;
}

/**
 * Scale conversions between the integer columns and the solver's engineering
 * units, kept in one place so a factor of a thousand cannot appear in only one
 * of the two call sites.
 */
export const SCALES = {
  /** `nominal_volts` -> kV. */
  voltsToKv: 1_000,
  /** `voltage_*_pu_x1000` -> per unit. */
  puX1000: 1_000,
  /** `length_m` -> km. */
  metresToKm: 1_000,
  /** `*_mohm_per_km` (milliohms) -> ohms per km. */
  milliohmsToOhms: 1_000,
  /** `max_current_ma` (milliamps) -> kA. */
  milliampsToKiloamps: 1_000_000,
  /** `rated_kva` -> MVA. */
  kvaToMva: 1_000,
  /** `*_percent_x100` -> percent. */
  percentX100: 100,
} as const;

/**
 * Read the connected electrical model containing `nodeId`.
 *
 * The component is walked over the branch tables rather than over
 * `parent_node_id`: the market hierarchy says a feeder belongs to a substation,
 * which is not the same claim as a conductor of a known impedance joining them.
 *
 * Every node reached must carry a nominal voltage, and the component must contain
 * a source, or there is nothing to solve — reported as a reason naming the node,
 * because "unsolvable" is only actionable if an operator knows what to survey.
 */
export async function loadNetworkModel(nodeId: number): Promise<LoadedNetworkModel> {
  const db = await getDb();
  if (!db) return { available: false, reason: 'no database is configured' };

  const root = await db
    .select({ id: gridNodes.id, code: gridNodes.code })
    .from(gridNodes)
    .where(eq(gridNodes.id, nodeId))
    .limit(1);
  if (root.length === 0) {
    return { available: false, reason: `grid node ${nodeId} does not exist` };
  }

  // One recursive walk over both branch tables: a component can be joined by a
  // transformer as readily as by a line, and stopping at either would report an
  // island the network does not have.
  const component = await db.execute<SqlRow>(sql`
    WITH RECURSIVE branches AS (
      SELECT from_node_id AS a, to_node_id AS b FROM grid_network_lines
      UNION ALL
      SELECT to_node_id AS a, from_node_id AS b FROM grid_network_lines
      UNION ALL
      SELECT hv_node_id AS a, lv_node_id AS b FROM grid_network_transformers
      UNION ALL
      SELECT lv_node_id AS a, hv_node_id AS b FROM grid_network_transformers
    ),
    reached AS (
      SELECT ${nodeId}::int AS node_id
      UNION
      SELECT b.b
      FROM reached r
      JOIN branches b ON b.a = r.node_id
    )
    SELECT node_id FROM reached
  `);
  const nodeIds = (component.rows ?? []).map(row => Number(row.node_id));

  const nodeRows = await db
    .select({
      id: gridNodes.id,
      code: gridNodes.code,
      nominalVolts: gridNodes.nominalVolts,
      isSource: gridNodes.isSource,
      voltageMinPuX1000: gridNodes.voltageMinPuX1000,
      voltageMaxPuX1000: gridNodes.voltageMaxPuX1000,
    })
    .from(gridNodes)
    .where(inArray(gridNodes.id, nodeIds));

  const unmodelled = nodeRows.filter(row => row.nominalVolts === null);
  if (unmodelled.length > 0) {
    const names = unmodelled
      .slice(0, 5)
      .map(row => row.code)
      .join(', ');
    return {
      available: false,
      reason: `no nominal voltage recorded for ${unmodelled.length} node(s) in this network: ${names}`,
    };
  }
  if (!nodeRows.some(row => row.isSource)) {
    return {
      available: false,
      reason: `the network containing ${root[0].code} has no source node: nothing feeds it, so no power flow can be solved`,
    };
  }

  const lineRows =
    nodeIds.length > 0
      ? await db
          .select()
          .from(gridNetworkLines)
          .where(
            and(
              inArray(gridNetworkLines.fromNodeId, nodeIds),
              inArray(gridNetworkLines.toNodeId, nodeIds)
            )
          )
      : [];
  const transformerRows =
    nodeIds.length > 0
      ? await db
          .select()
          .from(gridNetworkTransformers)
          .where(
            and(
              inArray(gridNetworkTransformers.hvNodeId, nodeIds),
              inArray(gridNetworkTransformers.lvNodeId, nodeIds)
            )
          )
      : [];

  if (lineRows.length === 0 && transformerRows.length === 0) {
    return {
      available: false,
      reason: `no lines or transformers are recorded around ${root[0].code}: an isolated node has no network to check`,
    };
  }

  const codeById = new Map<number, string>(nodeRows.map(row => [row.id, row.code]));
  const nodeIdsByCode = new Map<string, number>(nodeRows.map(row => [row.code, row.id]));

  const network: NetworkModelPayload = {
    buses: nodeRows.map(row => ({
      code: row.code,
      // Checked above; the assertion is the loop's own precondition.
      nominal_kv: (row.nominalVolts ?? 0) / SCALES.voltsToKv,
      kind: row.isSource ? ('source' as const) : ('node' as const),
      ...(row.voltageMinPuX1000 !== null
        ? { vm_pu_min: row.voltageMinPuX1000 / SCALES.puX1000 }
        : {}),
      ...(row.voltageMaxPuX1000 !== null
        ? { vm_pu_max: row.voltageMaxPuX1000 / SCALES.puX1000 }
        : {}),
    })),
    lines: lineRows.map(row => ({
      code: row.code,
      from_bus: codeById.get(row.fromNodeId) ?? String(row.fromNodeId),
      to_bus: codeById.get(row.toNodeId) ?? String(row.toNodeId),
      length_km: row.lengthM / SCALES.metresToKm,
      r_ohm_per_km: row.resistanceMohmPerKm / SCALES.milliohmsToOhms,
      x_ohm_per_km: row.reactanceMohmPerKm / SCALES.milliohmsToOhms,
      c_nf_per_km: row.capacitanceNfPerKm,
      max_i_ka: row.maxCurrentMa / SCALES.milliampsToKiloamps,
      parallel: row.parallelCircuits,
    })),
    transformers: transformerRows.map(row => ({
      code: row.code,
      hv_bus: codeById.get(row.hvNodeId) ?? String(row.hvNodeId),
      lv_bus: codeById.get(row.lvNodeId) ?? String(row.lvNodeId),
      sn_mva: row.ratedKva / SCALES.kvaToMva,
      vn_hv_kv: row.hvVolts / SCALES.voltsToKv,
      vn_lv_kv: row.lvVolts / SCALES.voltsToKv,
      vk_percent: row.shortCircuitPercentX100 / SCALES.percentX100,
      vkr_percent: row.shortCircuitResistivePercentX100 / SCALES.percentX100,
      pfe_kw: row.ironLossW / 1_000,
      i0_percent: row.openLoopCurrentPercentX100 / SCALES.percentX100,
    })),
  };

  return { available: true, network, nodeIdsByCode };
}

/** Freshness bound on telemetry used as the base case of a study. */
export const INJECTION_STALENESS_SECONDS = 900;

export interface MeasuredInjections {
  loads: NetworkInjection[];
  generation: NetworkInjection[];
  /** Nodes in the model whose assets reported nothing recent. */
  unmeasuredNodeCodes: string[];
  /** Nodes in the model with no linked assets at all: legitimately zero. */
  assetlessNodeCodes: string[];
}

/**
 * The base case, from telemetry.
 *
 * Telemetry is generation-positive, matching `locational-flexibility`, so a
 * negative sample is consumption. A node whose assets have gone quiet is *not*
 * treated as zero load — a silent meter looks exactly like an idle one, and
 * calling it zero is how a study reports headroom on a feeder that is already
 * full. Such nodes are named, and callers refuse or label accordingly.
 */
export async function measuredInjections(
  nodeIdsByCode: Map<string, number>,
  now = new Date()
): Promise<MeasuredInjections> {
  const db = await getDb();
  if (!db) {
    return {
      loads: [],
      generation: [],
      unmeasuredNodeCodes: [...nodeIdsByCode.keys()],
      assetlessNodeCodes: [],
    };
  }

  const nodeIds = [...nodeIdsByCode.values()];
  const codeByNodeId = new Map<number, string>(
    [...nodeIdsByCode.entries()].map(([code, id]) => [id, code])
  );
  if (nodeIds.length === 0) {
    return { loads: [], generation: [], unmeasuredNodeCodes: [], assetlessNodeCodes: [] };
  }

  const linked = await db
    .select({ nodeId: gridNodeAssets.nodeId, assetId: gridNodeAssets.assetId })
    .from(gridNodeAssets)
    .where(inArray(gridNodeAssets.nodeId, nodeIds));
  const linkedNodeIds = new Set(linked.map(row => row.nodeId));

  const loads: NetworkInjection[] = [];
  const generation: NetworkInjection[] = [];
  const unmeasuredNodeCodes: string[] = [];

  const since = new Date(now.getTime() - INJECTION_STALENESS_SECONDS * 1_000);
  // Latest sample per asset inside the freshness window, summed to its node.
  // Nodes with no linked assets are not queried at all: there is no asset whose
  // silence could be mistaken for zero.
  const rows = linked.length === 0
    ? { rows: [] as SqlRow[] }
    : await db.execute<SqlRow>(sql`
    WITH latest AS (
      SELECT DISTINCT ON (t."assetId")
        t."assetId" AS asset_id,
        t.power AS power_w
      FROM telemetry t
      WHERE t."assetId" IN (${sql.join(
        linked.map(row => sql`${row.assetId}`),
        sql`, `
      )})
        AND t.timestamp >= ${since}
        AND t.timestamp <= ${now}
        AND t.power IS NOT NULL
      ORDER BY t."assetId", t.timestamp DESC
    )
    SELECT
      a.node_id::int AS node_id,
      SUM(l.power_w)::float AS power_w,
      COUNT(l.asset_id)::int AS measured_assets,
      COUNT(a.asset_id)::int AS linked_assets
    FROM grid_node_assets a
    LEFT JOIN latest l ON l.asset_id = a.asset_id
    WHERE a.node_id IN (${sql.join(
      nodeIds.map(id => sql`${id}`),
      sql`, `
    )})
    GROUP BY a.node_id
  `);

  for (const row of rows.rows ?? []) {
    const nodeId = Number(row.node_id);
    const code = codeByNodeId.get(nodeId);
    if (code === undefined) continue;
    const measuredAssets = Number(row.measured_assets);
    const linkedAssets = Number(row.linked_assets);
    if (measuredAssets < linkedAssets || measuredAssets === 0) {
      unmeasuredNodeCodes.push(code);
      continue;
    }
    const powerW = Number(row.power_w);
    if (powerW >= 0) {
      generation.push({ bus: code, p_w: powerW, reference: `node:${code}` });
    } else {
      loads.push({ bus: code, p_w: -powerW, reference: `node:${code}` });
    }
  }

  const assetlessNodeCodes = nodeIds
    .filter(id => !linkedNodeIds.has(id))
    .map(id => codeByNodeId.get(id))
    .filter((code): code is string => code !== undefined);

  return { loads, generation, unmeasuredNodeCodes, assetlessNodeCodes };
}

export interface FeasibilityStudy {
  status: FeasibilityStatus;
  /** Set when nothing was solved, or when the solver refused. */
  reason: string | null;
  /** Row id in `network_feasibility_studies`, or null if it could not be stored. */
  studyId: number | null;
  buses: FeasibilityBusResult[];
  elements: FeasibilityElementResult[];
  violations: FeasibilityViolation[];
  hostingCapacity: HostingCapacityResult[];
  /** The binding element, when there is one. */
  limitingElement: string | null;
  diagnostics: Record<string, string | number | boolean>;
}

export interface StudyInput {
  subject: FeasibilitySubject;
  subjectReference?: string;
  nodeId: number;
  candidate?: CandidateChange[];
  hostingCapacity?: HostingCapacityQuery[];
  /**
   * Base case override. Left unset, the base case is measured from telemetry;
   * passing it explicitly is for planning studies over a hypothetical load.
   */
  baseCase?: { loads: NetworkInjection[]; generation: NetworkInjection[] };
  limits?: {
    vm_pu_min?: number;
    vm_pu_max?: number;
    max_line_loading_percent?: number;
    max_transformer_loading_percent?: number;
  };
  requestedByUserId?: number;
  now?: Date;
  timeoutMs?: number;
}

/**
 * Run one study and store it.
 *
 * The failure modes are deliberately distinguishable by the caller:
 * `model_unavailable` means the operator has not surveyed this network,
 * `service_unavailable` means the solver is down, and `not_converged` means the
 * solver ran and could not answer. None of the three is a pass, and none of them
 * is a fail either — they are all "unchecked", which is why every caller has to
 * decide separately whether to proceed and say so.
 */
export async function studyFeasibility(input: StudyInput): Promise<FeasibilityStudy> {
  const now = input.now ?? new Date();
  const model = await loadNetworkModel(input.nodeId);
  if (!model.available) {
    return recordStudy(input, {
      status: 'model_unavailable',
      reason: model.reason,
      request: { node_id: input.nodeId, candidate: input.candidate ?? [] },
      response: null,
      engine: null,
      buses: 0,
      violations: [],
      hostingCapacity: [],
      busResults: [],
      elements: [],
      diagnostics: {},
    });
  }

  const measured =
    input.baseCase === undefined
      ? await measuredInjections(model.nodeIdsByCode, now)
      : null;
  const base: { loads: NetworkInjection[]; generation: NetworkInjection[] } =
    input.baseCase ?? { loads: measured?.loads ?? [], generation: measured?.generation ?? [] };
  const unmeasured: string[] = measured?.unmeasuredNodeCodes ?? [];
  if (unmeasured.length > 0) {
    return recordStudy(input, {
      status: 'model_unavailable',
      reason: `no telemetry inside the last ${INJECTION_STALENESS_SECONDS}s for every asset at ${unmeasured
        .slice(0, 5)
        .join(', ')}: a study on an unmeasured base case would report headroom that may already be used`,
      request: { node_id: input.nodeId, candidate: input.candidate ?? [] },
      response: null,
      engine: null,
      buses: 0,
      violations: [],
      hostingCapacity: [],
      busResults: [],
      elements: [],
      diagnostics: {},
    });
  }

  const payload = {
    network: model.network,
    loads: base.loads,
    generation: base.generation,
    candidate: input.candidate ?? [],
    hosting_capacity: input.hostingCapacity ?? [],
    ...(input.limits ? { limits: input.limits } : {}),
    study_reference: input.subjectReference ?? null,
  };

  let response: ServiceResponse;
  try {
    response = await postFeasibility(payload, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  } catch (error) {
    return recordStudy(input, {
      status: 'service_unavailable',
      reason: error instanceof Error ? error.message : String(error),
      request: payload,
      response: null,
      engine: null,
      buses: 0,
      violations: [],
      hostingCapacity: [],
      busResults: [],
      elements: [],
      diagnostics: {},
    });
  }

  const engineRaw = response.diagnostics.engine;
  return recordStudy(input, {
    status: response.status,
    reason: response.reason,
    request: payload,
    response,
    engine: typeof engineRaw === 'string' ? engineRaw : 'gridmodel',
    buses: response.buses.length,
    violations: response.violations,
    hostingCapacity: response.hosting_capacity,
    busResults: response.buses,
    elements: response.elements,
    diagnostics: response.diagnostics,
  });
}

async function postFeasibility(
  body: unknown,
  timeoutMs: number
): Promise<ServiceResponse> {
  return observing(
    {
      dependency: 'network_model',
      observedBy: 'server',
      operation: 'POST /feasibility',
      faultedWhen: error =>
        error instanceof NetworkFeasibilityError && /HTTP \d{3}/.test(error.message),
    },
    () => postFeasibilityOnce(body, timeoutMs)
  );
}

async function postFeasibilityOnce(
  body: unknown,
  timeoutMs: number
): Promise<ServiceResponse> {
  const baseUrl = getGridModelServiceUrl();
  if (!baseUrl) {
    throw new NetworkFeasibilityError(
      'GRIDMODEL_SERVICE_URL is not set: no network feasibility service to ask'
    );
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = process.env.GRIDMODEL_AUTH_TOKEN;
  if (token) headers['x-gridmodel-token'] = token;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const httpResponse = await fetch(`${baseUrl}/feasibility`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await httpResponse.text();
    if (!httpResponse.ok) {
      throw new NetworkFeasibilityError(
        `gridmodel /feasibility failed with HTTP ${httpResponse.status}: ${text.slice(0, 400)}`
      );
    }
    return JSON.parse(text) as ServiceResponse;
  } catch (error) {
    if (error instanceof NetworkFeasibilityError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new NetworkFeasibilityError(
        `gridmodel /feasibility timed out after ${timeoutMs}ms`
      );
    }
    throw new NetworkFeasibilityError(
      `gridmodel /feasibility is unreachable: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The violation furthest past its own limit.
 *
 * Ranked by relative excess rather than absolute, because 110% of a transformer
 * and 1.06 pu of a voltage band are not comparable in their own units.
 */
export function worstViolation(
  violations: FeasibilityViolation[]
): FeasibilityViolation | null {
  if (violations.length === 0) return null;
  const ranked = [...violations].sort((a, b) => {
    const aExcess = a.limit === 0 ? a.value : Math.abs(a.value - a.limit) / Math.abs(a.limit);
    const bExcess = b.limit === 0 ? b.value : Math.abs(b.value - b.limit) / Math.abs(b.limit);
    return bExcess - aExcess;
  });
  return ranked[0];
}

/** The element a caller names when refusing: the worst violation's subject. */
export function limitingElementOf(violations: FeasibilityViolation[]): string | null {
  return worstViolation(violations)?.element ?? null;
}

async function recordStudy(
  input: StudyInput,
  outcome: {
    status: FeasibilityStatus;
    reason: string | null;
    request: unknown;
    response: ServiceResponse | null;
    engine: string | null;
    buses: number;
    violations: FeasibilityViolation[];
    hostingCapacity: HostingCapacityResult[];
    busResults: FeasibilityBusResult[];
    elements: FeasibilityElementResult[];
    diagnostics: Record<string, string | number | boolean>;
  }
): Promise<FeasibilityStudy> {
  const limitingElement = limitingElementOf(outcome.violations);
  const study: FeasibilityStudy = {
    status: outcome.status,
    reason: outcome.reason,
    studyId: null,
    buses: outcome.busResults,
    elements: outcome.elements,
    violations: outcome.violations,
    hostingCapacity: outcome.hostingCapacity,
    limitingElement,
    diagnostics: outcome.diagnostics,
  };

  const db = await getDb();
  if (!db) return study;

  // Storing the study is what makes a refusal auditable, but a database that
  // cannot store it must not turn a solved study into a pretend-solved one: the
  // status stands and the row id is null.
  try {
    const inserted = await db
      .insert(networkFeasibilityStudies)
      .values({
        subject: input.subject,
        subjectReference: input.subjectReference ?? null,
        nodeId: input.nodeId,
        status: outcome.status,
        reason: outcome.reason?.slice(0, 500) ?? null,
        engine: outcome.engine,
        buses: outcome.buses,
        violationCount: outcome.violations.length,
        limitingElement: limitingElement?.slice(0, 80) ?? null,
        request: outcome.request,
        response: outcome.response,
        requestedByUserId: input.requestedByUserId ?? null,
      })
      .returning({ id: networkFeasibilityStudies.id });
    study.studyId = inserted[0]?.id ?? null;
  } catch {
    study.studyId = null;
  }
  return study;
}

/**
 * Record the electrical properties of an existing node.
 *
 * Deliberately additive to `grid_nodes`: the node the market clears at and the
 * bus the flow solves at are the same place, and a second node table is how the
 * two come to describe different networks.
 */
export async function setNodeElectrical(input: {
  nodeId: number;
  nominalVolts: number;
  isSource?: boolean;
  voltageMinPuX1000?: number;
  voltageMaxPuX1000?: number;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new NetworkFeasibilityError('Database not available');
  if (!Number.isInteger(input.nominalVolts) || input.nominalVolts <= 0) {
    throw new NetworkFeasibilityError('nominalVolts must be a positive whole number of volts');
  }
  const updated = await db
    .update(gridNodes)
    .set({
      nominalVolts: input.nominalVolts,
      ...(input.isSource === undefined ? {} : { isSource: input.isSource }),
      ...(input.voltageMinPuX1000 === undefined
        ? {}
        : { voltageMinPuX1000: input.voltageMinPuX1000 }),
      ...(input.voltageMaxPuX1000 === undefined
        ? {}
        : { voltageMaxPuX1000: input.voltageMaxPuX1000 }),
      updatedAt: new Date(),
    })
    .where(eq(gridNodes.id, input.nodeId))
    .returning({ id: gridNodes.id });
  if (updated.length === 0) {
    throw new NetworkFeasibilityError(`Unknown grid node ${input.nodeId}`);
  }
}

export interface RegisterLineInput {
  code: string;
  fromNodeId: number;
  toNodeId: number;
  lengthM: number;
  resistanceMohmPerKm: number;
  reactanceMohmPerKm: number;
  maxCurrentMa: number;
  capacitanceNfPerKm?: number;
  parallelCircuits?: number;
  dataSource?: string;
}

/** Register a conductor between two nodes. Re-registering the code updates it. */
export async function registerLine(input: RegisterLineInput): Promise<number> {
  const db = await getDb();
  if (!db) throw new NetworkFeasibilityError('Database not available');
  const values = {
    code: input.code.trim(),
    fromNodeId: input.fromNodeId,
    toNodeId: input.toNodeId,
    lengthM: input.lengthM,
    resistanceMohmPerKm: input.resistanceMohmPerKm,
    reactanceMohmPerKm: input.reactanceMohmPerKm,
    capacitanceNfPerKm: input.capacitanceNfPerKm ?? 0,
    maxCurrentMa: input.maxCurrentMa,
    parallelCircuits: input.parallelCircuits ?? 1,
    dataSource: input.dataSource ?? null,
  };
  const rows = await db
    .insert(gridNetworkLines)
    .values(values)
    .onConflictDoUpdate({
      target: gridNetworkLines.code,
      set: { ...values, updatedAt: new Date() },
    })
    .returning({ id: gridNetworkLines.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new NetworkFeasibilityError('Line insert returned no id');
  return id;
}

export interface RegisterTransformerInput {
  code: string;
  hvNodeId: number;
  lvNodeId: number;
  ratedKva: number;
  hvVolts: number;
  lvVolts: number;
  shortCircuitPercentX100: number;
  shortCircuitResistivePercentX100?: number;
  ironLossW?: number;
  openLoopCurrentPercentX100?: number;
  dataSource?: string;
}

/** Register a transformer between two nodes. Re-registering the code updates it. */
export async function registerTransformer(input: RegisterTransformerInput): Promise<number> {
  const db = await getDb();
  if (!db) throw new NetworkFeasibilityError('Database not available');
  const values = {
    code: input.code.trim(),
    hvNodeId: input.hvNodeId,
    lvNodeId: input.lvNodeId,
    ratedKva: input.ratedKva,
    hvVolts: input.hvVolts,
    lvVolts: input.lvVolts,
    shortCircuitPercentX100: input.shortCircuitPercentX100,
    shortCircuitResistivePercentX100: input.shortCircuitResistivePercentX100 ?? 0,
    ironLossW: input.ironLossW ?? 0,
    openLoopCurrentPercentX100: input.openLoopCurrentPercentX100 ?? 0,
    dataSource: input.dataSource ?? null,
  };
  const rows = await db
    .insert(gridNetworkTransformers)
    .values(values)
    .onConflictDoUpdate({
      target: gridNetworkTransformers.code,
      set: { ...values, updatedAt: new Date() },
    })
    .returning({ id: gridNetworkTransformers.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new NetworkFeasibilityError('Transformer insert returned no id');
  return id;
}

export interface NetworkModelSummary {
  nodeId: number;
  nodeCode: string;
  modelled: boolean;
  /** Why it cannot be solved, when it cannot. */
  reason: string | null;
  buses: number;
  lines: number;
  transformers: number;
  sourceNodeCodes: string[];
}

/** What the platform knows about the network around a node, without solving it. */
export async function networkModelSummary(nodeId: number): Promise<NetworkModelSummary> {
  const db = await getDb();
  if (!db) throw new NetworkFeasibilityError('Database not available');
  const nodeRows = await db
    .select({ code: gridNodes.code })
    .from(gridNodes)
    .where(eq(gridNodes.id, nodeId))
    .limit(1);
  const nodeCode = nodeRows[0]?.code;
  if (nodeCode === undefined) {
    throw new NetworkFeasibilityError(`Unknown grid node ${nodeId}`);
  }
  const model = await loadNetworkModel(nodeId);
  if (!model.available) {
    return {
      nodeId,
      nodeCode,
      modelled: false,
      reason: model.reason,
      buses: 0,
      lines: 0,
      transformers: 0,
      sourceNodeCodes: [],
    };
  }
  return {
    nodeId,
    nodeCode,
    modelled: true,
    reason: null,
    buses: model.network.buses.length,
    lines: model.network.lines.length,
    transformers: model.network.transformers.length,
    sourceNodeCodes: model.network.buses
      .filter(bus => bus.kind === 'source')
      .map(bus => bus.code),
  };
}

/** Studies for one subject, newest first: the evidence behind a refusal. */
export async function recentStudies(
  filter: { subject?: FeasibilitySubject; subjectReference?: string; nodeId?: number },
  limit = 50
): Promise<
  {
    id: number;
    subject: FeasibilitySubject;
    subjectReference: string | null;
    nodeId: number | null;
    status: FeasibilityStatus;
    reason: string | null;
    engine: string | null;
    buses: number;
    violationCount: number;
    limitingElement: string | null;
    createdAt: Date;
  }[]
> {
  const db = await getDb();
  if (!db) return [];
  const conditions = [
    filter.subject !== undefined
      ? eq(networkFeasibilityStudies.subject, filter.subject)
      : undefined,
    filter.subjectReference !== undefined
      ? eq(networkFeasibilityStudies.subjectReference, filter.subjectReference)
      : undefined,
    filter.nodeId !== undefined ? eq(networkFeasibilityStudies.nodeId, filter.nodeId) : undefined,
  ].filter((clause): clause is Exclude<typeof clause, undefined> => clause !== undefined);

  const rows = await db
    .select({
      id: networkFeasibilityStudies.id,
      subject: networkFeasibilityStudies.subject,
      subjectReference: networkFeasibilityStudies.subjectReference,
      nodeId: networkFeasibilityStudies.nodeId,
      status: networkFeasibilityStudies.status,
      reason: networkFeasibilityStudies.reason,
      engine: networkFeasibilityStudies.engine,
      buses: networkFeasibilityStudies.buses,
      violationCount: networkFeasibilityStudies.violationCount,
      limitingElement: networkFeasibilityStudies.limitingElement,
      createdAt: networkFeasibilityStudies.createdAt,
    })
    .from(networkFeasibilityStudies)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(sql`${networkFeasibilityStudies.createdAt} DESC`)
    .limit(limit);
  return rows;
}
