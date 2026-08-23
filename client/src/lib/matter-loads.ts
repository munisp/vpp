/**
 * Shared vocabulary for Matter smart-home loads in the UI.
 *
 * A Matter node is somebody's water heater or heat pump, and the way an operator
 * screen misleads about one is by rendering reachability as control: "online"
 * next to a load that has never reported a watt reads as a dispatchable
 * appliance. So every node here is described by what it published — which
 * clusters, which measurements — and a node the controller acknowledges but that
 * measures nothing is labelled as such.
 */

export type NodeTone = 'good' | 'warning' | 'danger' | 'neutral';

export interface MatterCapability {
  endpointId: number;
  clusterId: number;
  cluster: string | null;
}

export interface MatterAttribute {
  path: string;
  endpointId: number;
  clusterId: number;
  attributeId: number;
  cluster: string | null;
  /** The raw reported value. `null` means the node reported no value. */
  value: unknown;
  reportedAt: string | Date;
}

export interface MatterNode {
  id: number;
  fabricId: string;
  nodeId: string;
  available: boolean;
  isBridge: boolean;
  isTestNode: boolean;
  removedAt: string | Date | null;
  lastReportedAt: string | Date;
  capabilities: MatterCapability[];
  attributes: MatterAttribute[];
}

/** Cluster ids this UI names. Anything else is shown by number. */
export const CLUSTER_LABELS: Record<string, string> = {
  on_off: 'On/Off',
  level_control: 'Level',
  thermostat: 'Thermostat',
  electrical_power_measurement: 'Power metering',
  electrical_energy_measurement: 'Energy metering',
  device_energy_management: 'Energy management',
};

export function describeCapability(capability: MatterCapability): string {
  const label = capability.cluster ? CLUSTER_LABELS[capability.cluster] : null;
  return label ?? `Cluster ${capability.clusterId}`;
}

export interface NodeVerdict {
  label: string;
  tone: NodeTone;
  meaning: string;
}

/**
 * What this node is, in terms an operator can act on.
 *
 * The order matters: a removed node is described as removed even if it was
 * reachable a minute ago, and a synthetic controller node is called out before
 * anything else, because its acknowledgements are indistinguishable from a real
 * dispatch and the only safe reading is "not a device".
 */
export function nodeVerdict(node: MatterNode): NodeVerdict {
  if (node.removedAt) {
    return {
      label: 'Removed from fabric',
      tone: 'neutral',
      meaning:
        'The controller no longer reports this node. Its history is kept, but it cannot be commanded.',
    };
  }
  if (node.isTestNode) {
    return {
      label: 'Synthetic controller node',
      tone: 'danger',
      meaning:
        'This is one of the controller\u2019s test nodes. It acknowledges commands that no appliance performs, so nothing it reports is evidence of a load.',
    };
  }
  if (!node.available) {
    return {
      label: 'Unreachable',
      tone: 'danger',
      meaning:
        'The controller cannot reach this node, so a command sent now would not arrive. Any window still open on it is not being enforced at the device.',
    };
  }
  if (node.capabilities.length === 0) {
    return {
      label: 'No reported clusters',
      tone: 'warning',
      meaning:
        'The node is reachable but has published no clusters, so the platform knows of no control it supports and will refuse to command it.',
    };
  }
  return {
    label: 'Reachable',
    tone: 'good',
    meaning:
      'The controller can reach this node. Reachability is not delivery: only a measured attribute shows what the load actually did.',
  };
}

export type Controllability = 'controllable' | 'metered_only' | 'none';

/**
 * Whether the platform can control this node, meter it, or neither.
 *
 * Derived from published clusters only. A metering-only node is worth showing —
 * it is evidence, just not a lever.
 */
export function controllability(node: MatterNode): Controllability {
  if (node.removedAt || node.isTestNode) return 'none';
  const clusters = new Set(node.capabilities.map(capability => capability.cluster));
  if (
    clusters.has('on_off') ||
    clusters.has('level_control') ||
    clusters.has('thermostat') ||
    clusters.has('device_energy_management')
  ) {
    return 'controllable';
  }
  if (clusters.has('electrical_power_measurement') || clusters.has('electrical_energy_measurement')) {
    return 'metered_only';
  }
  return 'none';
}

export const CONTROLLABILITY_COPY: Record<Controllability, { label: string; meaning: string }> = {
  controllable: {
    label: 'Controllable',
    meaning: 'The node published a load control cluster, so a bounded window can be applied to it.',
  },
  metered_only: {
    label: 'Metering only',
    meaning:
      'The node reports measurements but published no control cluster. It can prove what a load did; it cannot be told what to do.',
  },
  none: {
    label: 'Not dispatchable',
    meaning:
      'Nothing this node published lets the platform control it, so it is excluded from dispatch.',
  },
};

/** How a Matter load window is held open. */
export const ENFORCEMENT_COPY: Record<'device' | 'platform', { label: string; meaning: string }> = {
  device: {
    label: 'Expires at the device',
    meaning:
      'The command carries its own duration (DeviceEnergyManagement power adjustment), so the node ends it even if the platform goes away.',
  },
  platform: {
    label: 'Held by the platform',
    meaning:
      'Matter On/Off and Level commands carry no expiry, so the platform must send the fallback to end the window. If the platform cannot reach the node, the load stays as commanded.',
  },
};

/**
 * A measured value read from a reported attribute, in the unit the Matter spec
 * defines for it.
 *
 * `null` is returned for a value the node did not report and for a value this
 * function cannot read as a number. Neither is zero: a water heater that cannot
 * report its draw is unknown, and treating unknown as 0 W would credit a
 * curtailment that may not have happened.
 */
export function measuredWatts(node: MatterNode): number | null {
  const attribute = node.attributes.find(
    candidate => candidate.cluster === 'electrical_power_measurement' && candidate.attributeId === 10
  );
  if (!attribute || typeof attribute.value !== 'number' || !Number.isFinite(attribute.value)) {
    return null;
  }
  // ElectricalPowerMeasurement reports active power in milliwatts.
  return attribute.value / 1000;
}

export function measuredEnergyWh(node: MatterNode): number | null {
  const attribute = node.attributes.find(
    candidate => candidate.cluster === 'electrical_energy_measurement' && candidate.attributeId === 1
  );
  if (!attribute || typeof attribute.value !== 'number' || !Number.isFinite(attribute.value)) {
    return null;
  }
  // ElectricalEnergyMeasurement reports cumulative energy in milliwatt-hours.
  return attribute.value / 1000;
}

export function reportedOnOff(node: MatterNode): boolean | null {
  const attribute = node.attributes.find(
    candidate => candidate.cluster === 'on_off' && candidate.attributeId === 0
  );
  return typeof attribute?.value === 'boolean' ? attribute.value : null;
}

/** Formats a measurement, or says plainly that there is none. */
export function formatMeasurement(value: number | null, unit: string): string {
  if (value === null) return 'Not reported';
  const magnitude = Math.abs(value);
  const decimals = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${unit}`;
}

export interface FabricSummary {
  nodes: number;
  reachable: number;
  unreachable: number;
  removed: number;
  syntheticNodes: number;
  controllable: number;
  meteredOnly: number;
  /** Reachable, controllable nodes that have never reported a measurement. */
  controllableWithoutMeasurement: number;
}

/**
 * Fabric-level counts.
 *
 * `controllableWithoutMeasurement` is the number that matters: those are loads
 * the platform can command and cannot verify, which is exactly the population
 * where a dispatch looks successful without being observed.
 */
export function summariseFabric(nodes: MatterNode[]): FabricSummary {
  const summary: FabricSummary = {
    nodes: nodes.length,
    reachable: 0,
    unreachable: 0,
    removed: 0,
    syntheticNodes: 0,
    controllable: 0,
    meteredOnly: 0,
    controllableWithoutMeasurement: 0,
  };

  for (const node of nodes) {
    if (node.removedAt) {
      summary.removed += 1;
      continue;
    }
    if (node.isTestNode) summary.syntheticNodes += 1;
    if (node.available) summary.reachable += 1;
    else summary.unreachable += 1;

    const control = controllability(node);
    if (control === 'controllable') {
      summary.controllable += 1;
      if (node.available && measuredWatts(node) === null && measuredEnergyWh(node) === null) {
        summary.controllableWithoutMeasurement += 1;
      }
    } else if (control === 'metered_only') {
      summary.meteredOnly += 1;
    }
  }

  return summary;
}
