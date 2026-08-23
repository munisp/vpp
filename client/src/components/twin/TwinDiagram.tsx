/**
 * The single-line diagram of a site, drawn from telemetry the platform holds.
 *
 * The drawing rules matter more than the graphics:
 *   - only an edge the model marked `animated` moves; movement means a fresh,
 *     non-zero measurement and nothing else,
 *   - a stale component is drawn hatched with its last reading and an age,
 *   - a component that has never reported is drawn dashed and unlabelled — never
 *     as 0 kW, because zero is a measurement,
 *   - motion is dropped entirely under `prefers-reduced-motion`.
 */

import { useId } from 'react';
import {
  Battery,
  CircleHelp,
  Factory,
  Fuel,
  Gauge,
  Network,
  Plug,
  Sun,
  Wind,
  Zap,
} from 'lucide-react';

import type { EvidenceState, TwinEdge, TwinNode, TwinNodeKind, TwinGraph } from '@shared/digital-twin';
import { layoutTwin } from '@/lib/twin-layout';
import { cn } from '@/lib/utils';
import type { StateTone } from '@/lib/tone';

const KIND_ICON: Record<TwinNodeKind, typeof Sun> = {
  grid: Network,
  site: Factory,
  solar: Sun,
  wind: Wind,
  battery: Battery,
  meter: Gauge,
  generator: Fuel,
  ev_charger: Plug,
  load: Zap,
  other: CircleHelp,
};

/** Evidence, not health: a measured fault is still measured. */
const EVIDENCE_TONE: Record<EvidenceState, StateTone> = {
  measured: 'live',
  stale: 'warning',
  never: 'neutral',
};

const EVIDENCE_STROKE: Record<EvidenceState, string> = {
  measured: 'var(--color-cyan-500)',
  stale: 'var(--color-amber-500)',
  never: 'var(--color-muted-foreground)',
};

export function formatWatts(watts: number | null): string | null {
  if (watts === null) return null;
  const kilowatts = watts / 1000;
  if (Math.abs(kilowatts) >= 100) return `${Math.round(kilowatts)} kW`;
  if (Math.abs(kilowatts) >= 1) return `${kilowatts.toFixed(1)} kW`;
  return `${Math.round(watts)} W`;
}

export function formatAge(ageSeconds: number | null): string | null {
  if (ageSeconds === null) return null;
  if (ageSeconds < 60) return `${Math.round(ageSeconds)}s ago`;
  if (ageSeconds < 3600) return `${Math.round(ageSeconds / 60)}m ago`;
  if (ageSeconds < 86_400) return `${Math.round(ageSeconds / 3600)}h ago`;
  return `${Math.round(ageSeconds / 86_400)}d ago`;
}

function EdgePath({ placement, gradientId }: { placement: ReturnType<typeof layoutTwin>['edges'][number]; gradientId: string }) {
  const { edge, path, labelX, labelY } = placement;
  const stroke = EVIDENCE_STROKE[edge.evidence];
  const flow = formatWatts(edge.flowWatts);

  return (
    <g>
      <title>{edge.detail}</title>
      <path
        d={path}
        fill="none"
        stroke={stroke}
        strokeWidth={edge.animated ? 2.5 : 1.5}
        strokeOpacity={edge.evidence === 'never' ? 0.35 : 0.75}
        strokeDasharray={edge.evidence === 'measured' ? undefined : '6 6'}
        strokeLinecap="round"
      />
      {edge.animated && (
        <>
          {/* One travelling packet per flowing connection: the only motion here. */}
          <circle r={4} fill={`url(#${gradientId})`} className="motion-reduce:hidden">
            <animateMotion dur="2.2s" repeatCount="indefinite" path={path} />
          </circle>
          <circle r={4} fill={stroke} className="hidden motion-reduce:block" opacity={0.9}>
            <animateMotion dur="0s" repeatCount="1" path={path} fill="freeze" />
          </circle>
        </>
      )}
      <text
        x={labelX}
        y={labelY - 8}
        textAnchor="middle"
        className={cn(
          'fill-current text-[11px] font-medium tabular-nums',
          edge.evidence === 'measured'
            ? 'text-cyan-700 dark:text-cyan-300'
            : 'text-muted-foreground'
        )}
      >
        {flow ?? (edge.evidence === 'never' ? 'unknown' : 'last known unavailable')}
      </text>
    </g>
  );
}

function NodeBox({ placement }: { placement: ReturnType<typeof layoutTwin>['nodes'][number] }) {
  const { node, x, y } = placement;
  const Icon = KIND_ICON[node.kind];
  const tone = EVIDENCE_TONE[node.evidence];
  const power = formatWatts(node.powerWatts) ?? formatWatts(node.lastPowerWatts);
  const age = formatAge(node.ageSeconds);

  const width = 176;
  const height = 62;

  return (
    <g transform={`translate(${x - width / 2}, ${y - height / 2})`}>
      <title>{node.detail}</title>
      <rect
        width={width}
        height={height}
        rx={10}
        className={cn(
          'stroke-2',
          tone === 'live' && 'fill-cyan-50 stroke-cyan-500 dark:fill-cyan-950/60',
          tone === 'warning' && 'fill-amber-50 stroke-amber-500 dark:fill-amber-950/50',
          tone === 'neutral' && 'fill-muted stroke-border'
        )}
        strokeDasharray={node.evidence === 'never' ? '5 4' : undefined}
      />
      {node.evidence === 'stale' && (
        <rect width={width} height={height} rx={10} className="ops-stale" fill="none" />
      )}
      <foreignObject width={width} height={height}>
        <div className="flex h-full w-full items-center gap-2 px-3 py-2">
          <Icon
            className={cn(
              'h-4 w-4 shrink-0',
              tone === 'live' && 'text-cyan-600 dark:text-cyan-300',
              tone === 'warning' && 'text-amber-600 dark:text-amber-300',
              tone === 'neutral' && 'text-muted-foreground'
            )}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[11px] font-semibold leading-tight">{node.label}</p>
            <p className="truncate text-[11px] leading-tight tabular-nums text-muted-foreground">
              {node.evidence === 'never'
                ? 'never reported'
                : node.evidence === 'stale'
                  ? `${power ?? 'no reading'} · ${age ?? 'age unknown'}`
                  : (power ?? 'no power reading')}
              {node.stateOfChargePercent !== null && ` · ${node.stateOfChargePercent.toFixed(0)}% SoC`}
            </p>
          </div>
        </div>
      </foreignObject>
    </g>
  );
}

export function TwinDiagram({ graph, className }: { graph: TwinGraph; className?: string }) {
  const layout = layoutTwin(graph);
  const gradientId = useId().replace(/:/g, '');

  if (layout.nodes.length === 0) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        No equipment is registered in this scope, so there is nothing to draw. This is an empty
        registry, not a plant at rest.
      </p>
    );
  }

  return (
    <div className={cn('w-full overflow-x-auto', className)}>
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width="100%"
        height={layout.height}
        role="img"
        aria-label={`Single-line diagram of ${graph.siteLabel}: ${graph.coverage.measured} of ${graph.coverage.assets} components currently reporting.`}
        className="min-w-[720px]"
      >
        <defs>
          <radialGradient id={gradientId}>
            <stop offset="0%" stopColor="var(--color-cyan-200)" />
            <stop offset="100%" stopColor="var(--color-cyan-500)" />
          </radialGradient>
        </defs>
        {layout.edges.map(placement => (
          <EdgePath key={placement.edge.id} placement={placement} gradientId={gradientId} />
        ))}
        {layout.nodes.map(placement => (
          <NodeBox key={placement.node.id} placement={placement} />
        ))}
      </svg>
    </div>
  );
}

export function TwinLegend() {
  const items: Array<{ evidence: EvidenceState; label: string; meaning: string }> = [
    {
      evidence: 'measured',
      label: 'reporting',
      meaning: 'A reading arrived within this component’s expected interval. Moving flow means measured, non-zero power.',
    },
    {
      evidence: 'stale',
      label: 'stale',
      meaning: 'The last reading is older than the expected interval. The value shown is history, not the present.',
    },
    {
      evidence: 'never',
      label: 'never reported',
      meaning: 'No telemetry has ever been recorded. Drawn unknown, not zero — it may be running unseen.',
    },
  ];

  return (
    <ul className="flex flex-wrap gap-x-6 gap-y-2 text-xs">
      {items.map(item => (
        <li key={item.evidence} className="flex items-start gap-2">
          <span
            aria-hidden
            className="mt-1.5 h-2 w-6 shrink-0 rounded-full"
            style={{ backgroundColor: EVIDENCE_STROKE[item.evidence] }}
          />
          <span>
            <span className="font-medium">{item.label}</span>{' '}
            <span className="text-muted-foreground">{item.meaning}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export type { TwinEdge, TwinNode };
