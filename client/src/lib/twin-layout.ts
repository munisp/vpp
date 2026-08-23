/**
 * Where each component sits in the rendered twin.
 *
 * The layout is a single-line diagram read left to right: the grid, the metering
 * point that measures the boundary, the site bus, then the equipment behind it.
 * It is deterministic — the same plant is drawn the same way every refresh, so an
 * operator who has learned the shape of their site does not have to re-learn it
 * when one asset drops out.
 */

import type { TwinEdge, TwinGraph, TwinNode } from '@shared/digital-twin';

export interface NodePlacement {
  node: TwinNode;
  x: number;
  y: number;
}

export interface EdgePlacement {
  edge: TwinEdge;
  /** SVG path from source to target, curved so parallel edges stay legible. */
  path: string;
  /** Midpoint, for the flow label. */
  labelX: number;
  labelY: number;
}

export interface TwinLayout {
  width: number;
  height: number;
  nodes: NodePlacement[];
  edges: EdgePlacement[];
}

const COLUMN_X = { grid: 90, meter: 300, site: 520, asset: 780 } as const;
const ROW_HEIGHT = 96;
const TOP_PADDING = 60;
const MIN_HEIGHT = 320;
const WIDTH = 900;

function columnOf(node: TwinNode): keyof typeof COLUMN_X {
  if (node.kind === 'grid') return 'grid';
  if (node.kind === 'meter') return 'meter';
  if (node.kind === 'site') return 'site';
  return 'asset';
}

function centre(count: number, height: number): number[] {
  if (count === 0) return [];
  const span = (count - 1) * ROW_HEIGHT;
  const start = height / 2 - span / 2;
  return Array.from({ length: count }, (_, index) => start + index * ROW_HEIGHT);
}

export function layoutTwin(graph: TwinGraph): TwinLayout {
  const columns: Record<keyof typeof COLUMN_X, TwinNode[]> = {
    grid: [],
    meter: [],
    site: [],
    asset: [],
  };
  for (const node of graph.nodes) columns[columnOf(node)].push(node);

  const tallest = Math.max(columns.meter.length, columns.asset.length, 1);
  const height = Math.max(MIN_HEIGHT, TOP_PADDING * 2 + (tallest - 1) * ROW_HEIGHT);

  const placements: NodePlacement[] = [];
  for (const column of ['grid', 'meter', 'site', 'asset'] as const) {
    const ys = centre(columns[column].length, height);
    columns[column].forEach((node, index) => {
      placements.push({ node, x: COLUMN_X[column], y: ys[index] });
    });
  }

  const byId = new Map(placements.map(placement => [placement.node.id, placement]));

  const edges: EdgePlacement[] = [];
  for (const edge of graph.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    // An edge whose endpoints are not both placed is dropped rather than drawn to
    // an invented position: half a connection is worse than none.
    if (!from || !to) continue;

    const midX = (from.x + to.x) / 2;
    edges.push({
      edge,
      path: `M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`,
      labelX: midX,
      labelY: (from.y + to.y) / 2,
    });
  }

  return { width: WIDTH, height, nodes: placements, edges };
}
