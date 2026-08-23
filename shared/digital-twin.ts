/**
 * The digital twin: what each piece of equipment is, and what was last measured
 * flowing through it.
 *
 * A twin is the easiest place in a platform to invent facts. A rendered plant
 * with animated flows is read as the plant *right now*, so an asset that stopped
 * reporting an hour ago, or one that has never reported at all, must not appear
 * as a component sitting quietly at zero — a measured zero and an absent
 * measurement look identical on a diagram and mean opposite things. Every node
 * and every edge here therefore carries the evidence behind it:
 *
 *   measured — a reading inside its freshness bound
 *   stale    — the last reading, past that bound: what *was* true
 *   never    — nothing has ever been recorded for this component
 *
 * Only `measured` edges carry a flow figure, and only they may be animated.
 * Stale and never-observed edges are drawn, because the equipment exists and
 * hiding it would make the plant look smaller than it is, but they are drawn as
 * unknowns.
 *
 * This module is pure and shared by the server, the PWA and the mobile app so a
 * component means the same thing wherever it is rendered.
 */

/** Freshness of the evidence behind a node, an edge or a figure. */
export type EvidenceState = 'measured' | 'stale' | 'never';

export type TwinNodeKind =
  | 'grid'
  | 'site'
  | 'solar'
  | 'wind'
  | 'battery'
  | 'meter'
  | 'generator'
  | 'ev_charger'
  | 'load'
  | 'other';

/** Which way energy was last measured moving on an edge. */
export type FlowDirection =
  /** Into the site bus: generation, discharge, or import from the grid. */
  | 'in'
  /** Out of the site bus: consumption, charging, or export to the grid. */
  | 'out'
  /** Measured, and not moving. This is a fact, unlike `unknown`. */
  | 'idle'
  /** Not measured recently enough to say. Never rendered as movement. */
  | 'unknown';

/** One measurement of one asset, in domain units, already unscaled. */
export interface TwinObservation {
  /** When the reading was taken, or `null` if nothing was ever recorded. */
  observedAt: Date | null;
  /** Signed watts, positive meaning the asset's own natural direction. */
  powerWatts: number | null;
  energyWh: number | null;
  stateOfChargePercent: number | null;
  voltageVolts: number | null;
  frequencyHz: number | null;
  temperatureCelsius: number | null;
  /** Readings behind this observation window; 0 means the asset was silent. */
  samples: number;
}

export interface TwinDeviceRecord {
  /** The device registry row id. */
  id: number;
  /** The identifier the device itself presents (MAC, serial). */
  deviceId: string;
  deviceType: string;
  manufacturer: string | null;
  model: string | null;
  firmwareVersion: string | null;
  /** The registry's own status column — an operator/agent claim, not a probe. */
  status: string;
  lastSeen: Date | null;
  enabled: boolean;
  /** How often the device is configured to report, in seconds. */
  telemetryIntervalSeconds: number;
}

export interface TwinAssetRecord {
  id: number;
  userId: number;
  name: string;
  /** `assets.assetType` as stored. Unrecognised types render as `other`. */
  assetType: string;
  /** Watts for generation, watt-hours for storage, as `assets.capacity` is. */
  capacity: number;
  status: string;
  observation: TwinObservation;
  devices: TwinDeviceRecord[];
}

export interface TwinInput {
  /** A stable label for the bus these assets sit behind. */
  siteLabel: string;
  assets: TwinAssetRecord[];
  generatedAt: Date;
  /**
   * How old a reading may be and still describe the present. Per asset this is
   * the device's reporting interval where one is registered; this is the floor
   * for assets with no registered device.
   */
  stalenessSeconds: number;
}

export interface TwinNode {
  id: string;
  kind: TwinNodeKind;
  label: string;
  /** `assets.id` for equipment nodes; absent for the grid and the site bus. */
  assetId?: number;
  evidence: EvidenceState;
  /** Age of the evidence in seconds, `null` when nothing was ever recorded. */
  ageSeconds: number | null;
  /** Signed watts as measured, `null` unless `evidence === 'measured'`. */
  powerWatts: number | null;
  /** Last reading even when stale, so operators can see what it was. */
  lastPowerWatts: number | null;
  stateOfChargePercent: number | null;
  capacity: number;
  /** Registry rows for the hardware behind this node. */
  devices: TwinDeviceRecord[];
  /** One sentence an operator can act on. Never implies more than is known. */
  detail: string;
}

export interface TwinEdge {
  id: string;
  from: string;
  to: string;
  direction: FlowDirection;
  /** Unsigned watts, `null` unless the flow was actually measured. */
  flowWatts: number | null;
  evidence: EvidenceState;
  /** Only ever true for a measured, moving flow. Drives animation. */
  animated: boolean;
  detail: string;
}

export interface TwinCoverage {
  assets: number;
  measured: number;
  stale: number;
  neverObserved: number;
  /** Rated capacity of the assets contributing nothing to the figures. */
  unseenCapacity: number;
}

export interface TwinGraph {
  generatedAt: Date;
  siteLabel: string;
  nodes: TwinNode[];
  edges: TwinEdge[];
  coverage: TwinCoverage;
  /**
   * Net watts across the measured equipment *behind* the meter, and nothing
   * else. A silent asset is left out rather than counted as zero, which is why
   * `coverage` has to be read next to this. Meters are excluded: a meter
   * measures the boundary, so adding it to the generation, load and storage it
   * already contains would produce a figure of nothing physical.
   */
  measuredNetPowerWatts: number;
  /** How many of the measured assets are behind the meter, i.e. in the sum above. */
  measuredBehindMeter: number;
  /**
   * Net watts at the grid boundary, from the meters that are reporting, or null
   * when no meter is currently measuring the exchange.
   */
  meteredGridPowerWatts: number | null;
  /** What this graph does not establish, in one sentence. */
  caveat: string;
}

const GRID_NODE = 'grid';
const SITE_NODE = 'site';

const KIND_BY_ASSET_TYPE: Record<string, TwinNodeKind> = {
  solar: 'solar',
  wind: 'wind',
  battery: 'battery',
  meter: 'meter',
  generator: 'generator',
  ev_charger: 'ev_charger',
  ev: 'ev_charger',
  load: 'load',
};

export function nodeKindOf(assetType: string): TwinNodeKind {
  return KIND_BY_ASSET_TYPE[assetType] ?? 'other';
}

/** Assets whose natural positive direction is out of the site, not into it. */
const CONSUMING_KINDS: ReadonlySet<TwinNodeKind> = new Set<TwinNodeKind>(['load', 'ev_charger']);

/**
 * The freshness bound for one asset: its device's reporting interval, with
 * generous headroom for a single missed report, floored at the deployment's
 * bound. A device configured to report every five seconds is stale long before
 * one polled every fifteen minutes is.
 */
export function stalenessBoundFor(asset: TwinAssetRecord, floorSeconds: number): number {
  const intervals = asset.devices
    .filter(device => device.enabled)
    .map(device => device.telemetryIntervalSeconds)
    .filter(seconds => Number.isFinite(seconds) && seconds > 0);

  if (intervals.length === 0) return floorSeconds;
  return Math.max(floorSeconds, Math.max(...intervals) * 3);
}

export function evidenceOf(
  observedAt: Date | null,
  boundSeconds: number,
  now: Date
): { evidence: EvidenceState; ageSeconds: number | null } {
  if (!observedAt) return { evidence: 'never', ageSeconds: null };

  const ageSeconds = (now.getTime() - observedAt.getTime()) / 1000;
  // A reading from the future cannot be aged, so it cannot be called current:
  // one of the two clocks is wrong and neither answer would be trustworthy.
  if (ageSeconds < -60) return { evidence: 'stale', ageSeconds };

  const age = Math.max(0, ageSeconds);
  return { evidence: age <= boundSeconds ? 'measured' : 'stale', ageSeconds: age };
}

function describeAge(ageSeconds: number | null): string {
  if (ageSeconds === null) return 'never';
  if (ageSeconds < 0) return 'timestamped in the future';
  if (ageSeconds < 60) return `${Math.round(ageSeconds)}s ago`;
  if (ageSeconds < 3600) return `${Math.round(ageSeconds / 60)}m ago`;
  if (ageSeconds < 86_400) return `${Math.round(ageSeconds / 3600)}h ago`;
  return `${Math.round(ageSeconds / 86_400)}d ago`;
}

function formatWatts(watts: number): string {
  const magnitude = Math.abs(watts);
  if (magnitude >= 1_000_000) return `${(watts / 1_000_000).toFixed(2)} MW`;
  if (magnitude >= 1_000) return `${(watts / 1_000).toFixed(2)} kW`;
  return `${Math.round(watts)} W`;
}

function nodeDetail(
  kind: TwinNodeKind,
  evidence: EvidenceState,
  ageSeconds: number | null,
  power: number | null,
  asset: TwinAssetRecord
): string {
  if (evidence === 'never') {
    return asset.devices.length === 0
      ? 'No device is registered against this asset and nothing has ever been reported for it, so nothing is known about it.'
      : 'A device is registered but has never reported, so nothing is known about this equipment.';
  }

  const measurement = power === null ? 'no power value' : formatWatts(power);
  if (evidence === 'stale') {
    return `Last reported ${describeAge(ageSeconds)} at ${measurement}. That is the last thing measured, not what is happening now.`;
  }

  if (power === null) {
    return `Reporting as of ${describeAge(ageSeconds)}, but with no power value, so the flow through this ${kind} is unknown.`;
  }
  return `Measured ${measurement} as of ${describeAge(ageSeconds)}.`;
}

/**
 * Which way a measured power figure means energy is moving, given what the
 * equipment is.
 *
 * Storage is the case worth stating: `telemetry.power` is signed, and a battery
 * at a negative figure is charging *from* the bus, not generating into it.
 */
export function flowOf(
  kind: TwinNodeKind,
  powerWatts: number | null,
  evidence: EvidenceState
): { direction: FlowDirection; flowWatts: number | null } {
  if (evidence !== 'measured' || powerWatts === null) {
    return { direction: 'unknown', flowWatts: null };
  }
  if (powerWatts === 0) return { direction: 'idle', flowWatts: 0 };

  const naturalIn = !CONSUMING_KINDS.has(kind);
  const positive = powerWatts > 0;
  const into = naturalIn ? positive : !positive;

  return { direction: into ? 'in' : 'out', flowWatts: Math.abs(powerWatts) };
}

function edgeDetail(
  label: string,
  direction: FlowDirection,
  flowWatts: number | null,
  ageSeconds: number | null,
  evidence: EvidenceState
): string {
  if (evidence === 'never') {
    return `Nothing has ever been measured through ${label}, so no flow is shown. This is not a zero flow — it is an unknown one.`;
  }
  if (evidence === 'stale') {
    return `The last measurement through ${label} was ${describeAge(ageSeconds)}; whether anything is flowing now is unknown.`;
  }
  if (direction === 'idle') {
    return `${label} measured no flow as of ${describeAge(ageSeconds)}. This is a measured zero, not missing data.`;
  }
  if (direction === 'unknown' || flowWatts === null) {
    return `${label} is reporting but sent no power value, so the flow is unknown.`;
  }
  return `${formatWatts(flowWatts)} measured ${direction === 'in' ? 'into' : 'out of'} the bus as of ${describeAge(ageSeconds)}.`;
}

/**
 * Assemble the graph. Everything derives from the records passed in; nothing is
 * inferred to fill a gap, and no node is created for equipment that is not in
 * the input.
 */
export function buildTwinGraph(input: TwinInput): TwinGraph {
  const now = input.generatedAt;
  const nodes: TwinNode[] = [];
  const edges: TwinEdge[] = [];

  let measured = 0;
  let stale = 0;
  let neverObserved = 0;
  let unseenCapacity = 0;
  let measuredNetPowerWatts = 0;
  let measuredBehindMeter = 0;
  let meteredGridPowerWatts: number | null = null;
  /** Behind-the-bus staleness, so the bus is not called live off a meter alone. */
  let staleBehindMeter = 0;
  let seenBehindMeterWithoutPower = 0;
  let assetsBehindMeter = 0;
  /** Grid exchange is only known if a meter reported it; assets do not imply it. */
  let gridEvidence: EvidenceState = 'never';
  let gridAgeSeconds: number | null = null;

  for (const asset of input.assets) {
    const kind = nodeKindOf(asset.assetType);
    const bound = stalenessBoundFor(asset, input.stalenessSeconds);
    const { evidence, ageSeconds } = evidenceOf(asset.observation.observedAt, bound, now);
    const lastPower = asset.observation.powerWatts;
    const power = evidence === 'measured' ? lastPower : null;

    if (kind !== 'meter') {
      assetsBehindMeter += 1;
      if (evidence === 'stale') staleBehindMeter += 1;
    }

    if (evidence === 'measured') {
      measured += 1;
      if (power !== null) {
        // A meter is the boundary measurement, not one more thing behind it.
        if (kind === 'meter') {
          meteredGridPowerWatts = (meteredGridPowerWatts ?? 0) + power;
        } else {
          measuredNetPowerWatts += power;
          measuredBehindMeter += 1;
        }
      } else if (kind !== 'meter') {
        // Seen, but with no power value: it belongs to the bus's evidence and
        // not to a sum it cannot contribute a number to.
        seenBehindMeterWithoutPower += 1;
      }
    } else if (evidence === 'stale') {
      stale += 1;
      unseenCapacity += asset.capacity;
    } else {
      neverObserved += 1;
      unseenCapacity += asset.capacity;
    }

    nodes.push({
      id: `asset:${asset.id}`,
      kind,
      label: asset.name,
      assetId: asset.id,
      evidence,
      ageSeconds,
      powerWatts: power,
      lastPowerWatts: lastPower,
      stateOfChargePercent:
        evidence === 'measured' ? asset.observation.stateOfChargePercent : null,
      capacity: asset.capacity,
      devices: asset.devices,
      detail: nodeDetail(kind, evidence, ageSeconds, evidence === 'measured' ? power : lastPower, asset),
    });

    const flow = flowOf(kind, power, evidence);
    // A meter measures the grid boundary, so its edge is the grid's edge; every
    // other asset sits behind the site bus.
    const isMeter = kind === 'meter';
    if (isMeter && (evidence === 'measured' || gridEvidence === 'never')) {
      gridEvidence = evidence;
      gridAgeSeconds = ageSeconds;
    }

    edges.push({
      id: `edge:asset:${asset.id}`,
      from: flow.direction === 'out' ? SITE_NODE : `asset:${asset.id}`,
      to: flow.direction === 'out' ? `asset:${asset.id}` : SITE_NODE,
      direction: flow.direction,
      flowWatts: flow.flowWatts,
      evidence,
      animated: evidence === 'measured' && (flow.direction === 'in' || flow.direction === 'out'),
      detail: edgeDetail(asset.name, flow.direction, flow.flowWatts, ageSeconds, evidence),
    });

    if (isMeter) {
      edges.push({
        id: `edge:grid:${asset.id}`,
        from: flow.direction === 'out' ? SITE_NODE : GRID_NODE,
        to: flow.direction === 'out' ? GRID_NODE : SITE_NODE,
        direction: flow.direction,
        flowWatts: flow.flowWatts,
        evidence,
        animated: evidence === 'measured' && (flow.direction === 'in' || flow.direction === 'out'),
        detail: edgeDetail(
          `the grid connection at ${asset.name}`,
          flow.direction,
          flow.flowWatts,
          ageSeconds,
          evidence
        ),
      });
    }
  }

  const coverage: TwinCoverage = {
    assets: input.assets.length,
    measured,
    stale,
    neverObserved,
    unseenCapacity,
  };

  nodes.unshift({
    id: SITE_NODE,
    kind: 'site',
    label: input.siteLabel,
    // The bus is what sits behind the meter; a reporting meter says nothing
    // about whether the equipment behind it is being seen.
    evidence:
      measuredBehindMeter + seenBehindMeterWithoutPower > 0
        ? 'measured'
        : staleBehindMeter > 0
          ? 'stale'
          : 'never',
    ageSeconds: null,
    powerWatts: measuredBehindMeter > 0 ? measuredNetPowerWatts : null,
    lastPowerWatts: measuredBehindMeter > 0 ? measuredNetPowerWatts : null,
    stateOfChargePercent: null,
    capacity: input.assets.reduce((total, asset) => total + asset.capacity, 0),
    devices: [],
    detail:
      measuredBehindMeter > 0
        ? `Net ${formatWatts(measuredNetPowerWatts)} across the ${measuredBehindMeter} of ${coverage.assets} assets reporting behind the meter. Meters are not added in — they measure the boundary, not another load — and the ${coverage.assets - measured} silent assets contribute nothing and are not assumed idle.`
        : input.assets.length === 0
          ? 'No asset is registered in this scope at all, so this is an empty registry rather than an idle plant.'
          : assetsBehindMeter === 0
            ? 'Only meters are registered here, so nothing is known about the equipment behind the bus.'
            : 'No asset behind this bus is currently reporting, so the net flow is unknown rather than zero.',
  });

  nodes.push({
    id: GRID_NODE,
    kind: 'grid',
    label: 'Grid connection',
    evidence: gridEvidence,
    ageSeconds: gridAgeSeconds,
    powerWatts: null,
    lastPowerWatts: null,
    stateOfChargePercent: null,
    capacity: 0,
    devices: [],
    detail:
      gridEvidence === 'measured'
        ? 'Exchange with the grid is measured at the meter.'
        : gridEvidence === 'stale'
          ? `The meter last reported ${describeAge(gridAgeSeconds)}; the present exchange with the grid is unknown.`
          : 'No meter is reporting, so the exchange with the grid is not measured. Import and export cannot be shown.',
  });

  return {
    generatedAt: now,
    siteLabel: input.siteLabel,
    nodes,
    edges,
    coverage,
    measuredNetPowerWatts,
    measuredBehindMeter,
    meteredGridPowerWatts,
    caveat:
      'Flows are the last telemetry each asset reported, not a device-confirmed state: a component drawn as flowing is a measurement the platform received, and a component drawn as unknown may be running unseen.',
  };
}
