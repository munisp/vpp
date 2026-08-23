/**
 * Matter ingest.
 *
 * The Go service in services/grid-protocols is a client of a Matter controller
 * (matter-server's WebSocket API) and forwards what that controller reported:
 * the commissioned node inventory, per-attribute reports, and node removals.
 * This file is the only place that inventory becomes platform state.
 *
 * Three properties are enforced here because they are what keeps a smart-home
 * load from being reported as dispatched when it was not:
 *
 *  - a node is stored exactly as reported. Capability is read from the clusters
 *    the node published, never from its device type, so a node that has reported
 *    nothing is controllable by nothing;
 *  - a reachable node is not a responding load. `available` is the controller's
 *    view of the fabric; only a measured attribute is evidence of a load;
 *  - a `null` attribute value is stored as null, not zero. A water heater that
 *    cannot report its power draw is unknown, and unknown must not aggregate or
 *    settle as no consumption.
 *
 * Node and fabric ids arrive as decimal strings: they are 64-bit Matter
 * identifiers and this runtime cannot hold them exactly as numbers.
 */

import { and, eq, inArray, isNull, not } from 'drizzle-orm';
import { matterNodeAttributes, matterNodes } from '../../drizzle/matter-schema';
import { GridProtocolError, requireDb } from './grid-protocol-ingest';

/** Matter cluster ids the platform interprets. Everything else is stored raw. */
export const MATTER_CLUSTERS = {
  onOff: 0x0006,
  levelControl: 0x0008,
  thermostat: 0x0201,
  electricalPowerMeasurement: 0x0090,
  electricalEnergyMeasurement: 0x0091,
  deviceEnergyManagement: 0x0098,
} as const;

export interface MatterNodeReport {
  node_id: string;
  available: boolean;
  is_bridge: boolean;
  is_test_node: boolean;
  attributes: Record<string, unknown> | null;
}

export interface MatterCapability {
  endpointId: number;
  clusterId: number;
  cluster: string | null;
}

const CLUSTER_NAMES: Record<number, string> = {
  [MATTER_CLUSTERS.onOff]: 'on_off',
  [MATTER_CLUSTERS.levelControl]: 'level_control',
  [MATTER_CLUSTERS.thermostat]: 'thermostat',
  [MATTER_CLUSTERS.electricalPowerMeasurement]: 'electrical_power_measurement',
  [MATTER_CLUSTERS.electricalEnergyMeasurement]: 'electrical_energy_measurement',
  [MATTER_CLUSTERS.deviceEnergyManagement]: 'device_energy_management',
};

/** A 64-bit Matter identifier, kept as the decimal string it arrived as. */
function requireIdentifier(value: string, field: string): string {
  if (!/^\d{1,20}$/.test(value)) {
    throw new GridProtocolError(400, `${field} must be a decimal Matter identifier`);
  }
  return value;
}

/**
 * Reads the capabilities a node actually published.
 *
 * The controller reports attributes keyed "<endpoint>/<cluster>/<attribute>". A
 * cluster is only a capability if the node published an attribute under it; a
 * path this function cannot parse is skipped rather than guessed at, because a
 * wrongly attributed cluster would let the platform issue a command the node
 * cannot perform and read the acknowledgement as a controlled load.
 */
export function capabilitiesFromAttributes(
  attributes: Record<string, unknown> | null | undefined
): MatterCapability[] {
  if (!attributes) return [];
  const seen = new Map<string, MatterCapability>();
  for (const path of Object.keys(attributes)) {
    const parts = path.split('/');
    if (parts.length !== 3) continue;
    const endpointId = Number(parts[0]);
    const clusterId = Number(parts[1]);
    if (!Number.isInteger(endpointId) || !Number.isInteger(clusterId)) continue;
    const key = `${endpointId}/${clusterId}`;
    if (seen.has(key)) continue;
    seen.set(key, { endpointId, clusterId, cluster: CLUSTER_NAMES[clusterId] ?? null });
  }
  return [...seen.values()].sort(
    (a, b) => a.endpointId - b.endpointId || a.clusterId - b.clusterId
  );
}

/**
 * Replaces the inventory for a fabric with what the controller just reported.
 *
 * A node the controller no longer reports is marked removed rather than deleted:
 * its attribute history is evidence about a load that was dispatched, and
 * deleting the row would delete that evidence. A node that reappears is un-marked.
 */
export async function handleMatterNodes(input: {
  fabric_id: string;
  nodes: MatterNodeReport[];
}): Promise<{ stored: number; removed: number }> {
  const fabricId = requireIdentifier(input.fabric_id, 'fabric_id');
  const db = await requireDb();
  const now = new Date();

  const reportedIds: string[] = [];
  for (const node of input.nodes) {
    const nodeId = requireIdentifier(node.node_id, 'node_id');
    reportedIds.push(nodeId);
    await db
      .insert(matterNodes)
      .values({
        fabricId,
        nodeId,
        available: node.available,
        isBridge: node.is_bridge,
        isTestNode: node.is_test_node,
        reportedAttributes: node.attributes ?? null,
        firstSeenAt: now,
        lastReportedAt: now,
        removedAt: null,
      })
      .onConflictDoUpdate({
        target: [matterNodes.fabricId, matterNodes.nodeId],
        set: {
          available: node.available,
          isBridge: node.is_bridge,
          isTestNode: node.is_test_node,
          reportedAttributes: node.attributes ?? null,
          lastReportedAt: now,
          removedAt: null,
          updatedAt: now,
        },
      });
  }

  // Nodes absent from a full inventory report are no longer commissioned on this
  // fabric. They are not reachable, so they are not available either: leaving
  // `available` true would let a dispatch target a node the controller dropped.
  const stale = and(eq(matterNodes.fabricId, fabricId), isNull(matterNodes.removedAt));
  const removed = await db
    .update(matterNodes)
    .set({ available: false, removedAt: now, updatedAt: now })
    .where(reportedIds.length > 0 ? and(stale, not(inArray(matterNodes.nodeId, reportedIds))) : stale)
    .returning({ id: matterNodes.id });

  return { stored: reportedIds.length, removed: removed.length };
}

/**
 * Stores one attribute report against its node.
 *
 * The value is written as received, including `null`. A report for a node this
 * platform has never seen is rejected: storing it would create a node row from a
 * single attribute, with no fabric, no availability and no capabilities, that
 * later reads as a commissioned device.
 */
export async function handleMatterAttribute(input: {
  node_id: string;
  attribute_path: string;
  value: unknown;
}): Promise<{ stored: true }> {
  const nodeId = requireIdentifier(input.node_id, 'node_id');
  const parts = input.attribute_path.split('/');
  if (parts.length !== 3) {
    throw new GridProtocolError(
      400,
      'attribute_path must be "<endpoint>/<cluster>/<attribute>": a wildcard report cannot be attributed to one attribute'
    );
  }
  const [endpointId, clusterId, attributeId] = parts.map(Number);
  if (![endpointId, clusterId, attributeId].every(part => Number.isInteger(part) && part >= 0)) {
    throw new GridProtocolError(400, `attribute_path ${input.attribute_path} is not numeric`);
  }

  const db = await requireDb();
  const rows = await db
    .select({ id: matterNodes.id })
    .from(matterNodes)
    .where(eq(matterNodes.nodeId, nodeId))
    .limit(1);
  const node = rows[0];
  if (!node) {
    throw new GridProtocolError(404, `matter node ${nodeId} has not been reported on any fabric`);
  }

  const now = new Date();
  await db
    .insert(matterNodeAttributes)
    .values({
      matterNodeId: node.id,
      endpointId,
      clusterId,
      attributeId,
      attributePath: input.attribute_path,
      value: input.value ?? null,
      reportedAt: now,
    })
    .onConflictDoUpdate({
      target: [matterNodeAttributes.matterNodeId, matterNodeAttributes.attributePath],
      set: { value: input.value ?? null, reportedAt: now, updatedAt: now },
    });

  return { stored: true };
}

/** Marks a node the controller removed from the fabric. */
export async function handleMatterNodeRemoved(input: {
  node_id: string;
}): Promise<{ removed: boolean }> {
  const nodeId = requireIdentifier(input.node_id, 'node_id');
  const db = await requireDb();
  const now = new Date();
  const rows = await db
    .update(matterNodes)
    .set({ available: false, removedAt: now, updatedAt: now })
    .where(and(eq(matterNodes.nodeId, nodeId), isNull(matterNodes.removedAt)))
    .returning({ id: matterNodes.id });
  return { removed: rows.length > 0 };
}

export interface MatterNodeView {
  id: number;
  fabricId: string;
  nodeId: string;
  available: boolean;
  isBridge: boolean;
  isTestNode: boolean;
  removedAt: Date | null;
  lastReportedAt: Date;
  capabilities: MatterCapability[];
  attributes: Array<{
    path: string;
    endpointId: number;
    clusterId: number;
    attributeId: number;
    cluster: string | null;
    /** The raw reported value; `null` means the node reported no value. */
    value: unknown;
    reportedAt: Date;
  }>;
}

/**
 * The operator view of the fabric: every node with the clusters it published and
 * the last raw value of each attribute it reported.
 */
export async function listMatterNodes(): Promise<MatterNodeView[]> {
  const db = await requireDb();
  const nodes = await db.select().from(matterNodes).orderBy(matterNodes.nodeId);
  if (nodes.length === 0) return [];

  const attributes = await db
    .select()
    .from(matterNodeAttributes)
    .where(
      inArray(
        matterNodeAttributes.matterNodeId,
        nodes.map(node => node.id)
      )
    );

  return nodes.map(node => ({
    id: node.id,
    fabricId: node.fabricId,
    nodeId: node.nodeId,
    available: node.available,
    isBridge: node.isBridge,
    isTestNode: node.isTestNode,
    removedAt: node.removedAt,
    lastReportedAt: node.lastReportedAt,
    capabilities: capabilitiesFromAttributes(
      node.reportedAttributes as Record<string, unknown> | null
    ),
    attributes: attributes
      .filter(attribute => attribute.matterNodeId === node.id)
      .sort((a, b) => a.attributePath.localeCompare(b.attributePath))
      .map(attribute => ({
        path: attribute.attributePath,
        endpointId: attribute.endpointId,
        clusterId: attribute.clusterId,
        attributeId: attribute.attributeId,
        cluster: CLUSTER_NAMES[attribute.clusterId] ?? null,
        value: attribute.value,
        reportedAt: attribute.reportedAt,
      })),
  }));
}
