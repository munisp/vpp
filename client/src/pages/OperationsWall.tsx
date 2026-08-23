/**
 * The wall board for a NOC/SOC: one screen, readable across a room, no clicking.
 *
 * A wall board is read at a glance and trusted, which makes it the most dangerous
 * surface in the platform to get wrong. Two rules therefore hold everywhere here:
 *
 *   1. A panel that could not be read says so in red. It never falls back to a
 *      zero, a dash or last-known-good, because a stalled query and a calm fleet
 *      must never look the same on a wall.
 *   2. Every figure carries the coverage or freshness behind it, so "1.4 MW" is
 *      never mistaken for the fleet's output when half the fleet is silent.
 *
 * Deliberately not on this board: anything the platform cannot observe. There is
 * no "grid frequency" tile because no deployment feeds us one, and no synthetic
 * SLA percentage.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, Radio, ShieldAlert } from 'lucide-react';

import { FreshnessBadge, MetricTile, PanelCard, Sparkline, ToneBadge } from '@/components/ops';
import { TwinDiagram, TwinLegend, formatWatts } from '@/components/twin/TwinDiagram';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  POSTURE_COPY,
  STATE_COPY,
  capabilityLabel,
  dependencyLabel,
  type CapabilityStatus,
  type DependencyPosture,
} from '@/lib/degraded-operation';
import { formatFleetKw } from '@/lib/fleet-telemetry';
import { operatorErrorDetail } from '@/lib/query-error';
import type { StateTone } from '@/lib/tone';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { useWebSocket } from '@/hooks/useWebSocket';

const REFRESH_MS = 15_000;
const BUCKET_MINUTES = 15;

/** A panel whose query failed. Loud on purpose: silence must never read as calm. */
function PanelUnavailable({ what, detail }: { what: string; detail: string }) {
  return (
    <div className="flex h-full items-start gap-3 rounded-lg border-2 border-red-500 bg-red-950/40 p-4">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" aria-hidden />
      <div className="text-sm">
        <p className="font-semibold text-red-200">{what} could not be read.</p>
        <p className="text-red-300/90">{detail}</p>
        <p className="mt-1 text-red-300/70">
          Nothing is shown in its place. Treat this panel as unknown, not as nominal.
        </p>
      </div>
    </div>
  );
}

function WallClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <time
      dateTime={now.toISOString()}
      className="text-3xl font-semibold tabular-nums tracking-tight"
      title={now.toISOString()}
    >
      {now.toISOString().slice(11, 19)} UTC
    </time>
  );
}

function FleetTwinPanel() {
  const utils = trpc.useUtils();
  const twin = trpc.digitalTwin.scoped.useQuery({}, { refetchInterval: REFRESH_MS });
  const { telemetry, connected } = useWebSocket();

  useEffect(() => {
    if (!telemetry) return;
    void utils.digitalTwin.scoped.invalidate();
  }, [telemetry, utils]);

  if (twin.isError) {
    return <PanelUnavailable what="The fleet twin" detail={operatorErrorDetail(twin.error)} />;
  }
  if (!twin.data) return <Skeleton className="h-[420px] w-full" />;

  const graph = twin.data;
  const coverageTone: StateTone =
    graph.coverage.assets === 0
      ? 'neutral'
      : graph.coverage.measured === graph.coverage.assets
        ? 'good'
        : graph.coverage.measured === 0
          ? 'danger'
          : 'warning';

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          label="Net behind the meter"
          value={graph.measuredBehindMeter > 0 ? formatWatts(graph.measuredNetPowerWatts) : null}
          tone={graph.measuredBehindMeter > 0 ? 'live' : 'neutral'}
          status={{
            label: `${graph.coverage.measured}/${graph.coverage.assets} reporting`,
            tone: coverageTone,
            meaning:
              'Generation, load and storage only: a meter measures the boundary, not another load behind it. Silent equipment is excluded rather than counted as zero, so with partial coverage this is a floor, not the fleet total.',
          }}
          evidence={<FreshnessBadge asOf={graph.generatedAt} stalenessSeconds={60} />}
        />
        <MetricTile
          label="Metered grid exchange"
          value={
            graph.meteredGridPowerWatts === null ? null : formatWatts(graph.meteredGridPowerWatts)
          }
          tone={graph.meteredGridPowerWatts === null ? 'neutral' : 'live'}
          status={{
            label: graph.meteredGridPowerWatts === null ? 'no meter reporting' : 'metered',
            tone: graph.meteredGridPowerWatts === null ? 'neutral' : 'live',
            meaning:
              'With no meter reporting, the exchange with the grid is unknown rather than zero.',
          }}
        />
        <MetricTile
          label="Stale"
          value={String(graph.coverage.stale)}
          tone={graph.coverage.stale > 0 ? 'warning' : 'good'}
          evidence={<span className="text-muted-foreground">past their reporting interval</span>}
        />
        <MetricTile
          label="Never reported"
          value={String(graph.coverage.neverObserved)}
          tone={graph.coverage.neverObserved > 0 ? 'warning' : 'good'}
          evidence={<span className="text-muted-foreground">no telemetry on record</span>}
        />
        <MetricTile
          label="Unseen capacity"
          value={formatWatts(graph.coverage.unseenCapacity)}
          tone={graph.coverage.unseenCapacity > 0 ? 'warning' : 'good'}
          evidence={
            <span className="text-muted-foreground">nameplate behind stale or silent plant</span>
          }
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <ToneBadge
          label={connected ? 'telemetry stream live' : 'telemetry stream offline'}
          tone={connected ? 'live' : 'warning'}
          meaning={
            connected
              ? 'The authenticated stream is open; a push re-reads the twin from the database.'
              : 'The stream is closed. The board still polls, but ages here can run behind the plant.'
          }
        />
        <TwinLegend />
      </div>

      <TwinDiagram graph={graph} />
    </div>
  );
}

function ControlPosturePanel() {
  const health = trpc.controlWindows.health.useQuery(undefined, { refetchInterval: REFRESH_MS });

  if (health.isError) {
    return <PanelUnavailable what="Control posture" detail={operatorErrorDetail(health.error)} />;
  }
  if (!health.data) return <Skeleton className="h-40 w-full" />;

  const { live, expiring, awaitingFallback, fallbackFailed, heldPastWindow } = health.data;

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <MetricTile
        label="Controls in force"
        value={String(live)}
        tone={live > 0 ? 'live' : 'neutral'}
        evidence={
          <span className="text-muted-foreground">
            inside their validity window; queued publishes are in force but unconfirmed
          </span>
        }
      />
      <MetricTile
        label="Expiring soon"
        value={String(expiring)}
        tone={expiring > 0 ? 'warning' : 'good'}
        evidence={<span className="text-muted-foreground">need renewal or they fall back</span>}
      />
      <MetricTile
        label="Awaiting fallback"
        value={String(awaitingFallback)}
        tone={awaitingFallback > 0 ? 'danger' : 'good'}
        evidence={
          <span className="text-muted-foreground">window expired, fallback not yet applied</span>
        }
      />
      <MetricTile
        label="Fallback failed"
        value={String(fallbackFailed)}
        tone={fallbackFailed > 0 ? 'danger' : 'good'}
        evidence={
          <span className="text-muted-foreground">
            device rejected, offline, or the publish was never acknowledged
          </span>
        }
      />
      <MetricTile
        label="Held past window"
        value={String(heldPastWindow)}
        tone={heldPastWindow > 0 ? 'warning' : 'good'}
        evidence={
          <span className="text-muted-foreground">holding a setpoint by declared policy</span>
        }
      />
    </div>
  );
}

function DependencyRow({ posture }: { posture: DependencyPosture }) {
  const copy = STATE_COPY[posture.state];
  return (
    <li className="flex items-center justify-between gap-3 border-b border-border/60 py-2 last:border-0">
      <span className="truncate text-sm font-medium">{dependencyLabel(posture.dependency)}</span>
      <ToneBadge label={copy.label} tone={copy.tone as StateTone} meaning={posture.reason} />
    </li>
  );
}

function CapabilityRow({ capability }: { capability: CapabilityStatus }) {
  const copy = POSTURE_COPY[capability.posture];
  return (
    <li className="flex items-center justify-between gap-3 border-b border-border/60 py-2 last:border-0">
      <span className="truncate text-sm font-medium">{capabilityLabel(capability.capability)}</span>
      <ToneBadge label={copy.label} tone={copy.tone as StateTone} meaning={capability.reason} />
    </li>
  );
}

function PosturePanel() {
  const posture = trpc.degradedOperation.posture.useQuery(undefined, {
    refetchInterval: REFRESH_MS,
  });

  if (posture.isError) {
    return <PanelUnavailable what="Degraded-operation posture" detail={operatorErrorDetail(posture.error)} />;
  }
  if (!posture.data) return <Skeleton className="h-64 w-full" />;

  const { dependencies, capabilities, guardMode } = posture.data;
  const down = dependencies.filter(item => item.state === 'down');
  const unknown = dependencies.filter(item => item.state === 'unknown');
  const refused = capabilities.filter(item => item.posture !== 'available');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <ToneBadge
          label={`guard mode: ${guardMode}`}
          tone={guardMode === 'enforce' ? 'good' : 'warning'}
          meaning="In enforce mode a capability whose evidence is missing is refused. Any other mode records what it would have refused."
        />
        <ToneBadge
          label={`${down.length} in outage`}
          tone={down.length > 0 ? 'danger' : 'good'}
          meaning="Consecutive real calls failed. An outage closes on a successful call, not on a timer."
        />
        <ToneBadge
          label={`${unknown.length} unobserved`}
          tone={unknown.length > 0 ? 'warning' : 'good'}
          meaning="No recent call was recorded, so the platform does not know. Unobserved blocks the same paths an outage does."
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Dependencies
          </p>
          <ul>
            {dependencies.map(item => (
              <DependencyRow key={item.dependency} posture={item} />
            ))}
          </ul>
        </div>
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Capabilities not fully available
          </p>
          {refused.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              Every capability's dependencies were observed working.
            </p>
          ) : (
            <ul>
              {refused.map(item => (
                <CapabilityRow key={item.capability} capability={item} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function FleetSeriesPanel() {
  const series = trpc.fleetTelemetry.rolling.useQuery(
    { scopeType: 'fleet' as const, bucketMinutes: BUCKET_MINUTES, buckets: 24 },
    { refetchInterval: REFRESH_MS }
  );

  if (series.isError) {
    return <PanelUnavailable what="The rolling fleet aggregate" detail={operatorErrorDetail(series.error)} />;
  }
  if (!series.data) return <Skeleton className="h-40 w-full" />;

  const buckets = series.data.buckets ?? [];
  const closed = buckets.filter(bucket => bucket.state !== 'open');
  const latest = [...closed].reverse().find(bucket => bucket.meanNetPowerWatts !== null);
  const missing = series.data.missingBuckets ?? 0;

  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <MetricTile
        label="Latest closed bucket"
        value={latest ? formatFleetKw(latest.meanNetPowerWatts) : null}
        tone={latest ? 'live' : 'neutral'}
        evidence={
          latest ? (
            <FreshnessBadge
              asOf={latest.bucketStartsAt}
              stalenessSeconds={BUCKET_MINUTES * 60 * 2}
            />
          ) : (
            <span className="text-muted-foreground">no bucket has closed with a figure yet</span>
          )
        }
      />
      <MetricTile
        label="Buckets the rollup never computed"
        value={String(missing)}
        tone={missing > 0 ? 'warning' : 'good'}
        evidence={
          <span className="text-muted-foreground">
            attributed to the rollup, never drawn as a quiet fleet
          </span>
        }
      />
      <div className="rounded-lg border border-border p-3">
        <p className="mb-1 text-xs font-medium text-muted-foreground">
          Mean net power, last 24 closed buckets
        </p>
        <Sparkline
          points={closed.map(bucket => ({ value: bucket.meanNetPowerWatts }))}
          tone="live"
          height={72}
          ariaLabel="Fleet mean net power over the last 24 closed buckets. Gaps are buckets the rollup never computed."
        />
      </div>
    </div>
  );
}

export default function OperationsWall() {
  const [dense, setDense] = useState(false);

  return (
    // The wall is always dark, whatever the operator's theme: it hangs in a
    // dimmed room, and a light board is both unreadable at distance and a
    // glare source. `dark` sets the token values for everything nested here.
    <div
      className={cn(
        'dark ops-surface min-h-screen bg-background text-foreground [color-scheme:dark]',
        dense && 'text-sm'
      )}
    >
      <header className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-4 border-b border-border bg-background/95 px-6 py-4 backdrop-blur">
        <div className="flex items-center gap-3">
          <Radio className="h-6 w-6 text-cyan-500" aria-hidden />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Operations wall</h1>
            <p className="text-xs text-muted-foreground">
              Fleet state from persisted telemetry and recorded dependency calls. A panel that
              cannot be read is shown as unreadable, never as nominal.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <WallClock />
          <Button variant="outline" size="sm" onClick={() => setDense(value => !value)}>
            {dense ? 'Room view' : 'Desk view'}
          </Button>
        </div>
      </header>

      <main className="space-y-6 p-6">
        <PanelCard
          title="Fleet digital twin"
          description="Grid, metering, site bus and equipment, drawn from the newest telemetry row each component wrote."
          footer="A moving connection is a measurement the platform received — not proof the device complied. Unknown components may be running unseen."
        >
          <FleetTwinPanel />
        </PanelCard>

        <div className="grid gap-6 xl:grid-cols-2">
          <PanelCard
            title="Control posture"
            description="Every control is bounded by a validity window with a declared fallback."
          >
            <ControlPosturePanel />
          </PanelCard>

          <PanelCard
            title="Rolling fleet aggregate"
            description="15-minute buckets. Energy here comes from telemetry samples, not a revenue meter."
          >
            <FleetSeriesPanel />
          </PanelCard>
        </div>

        <PanelCard
          title={
            <span className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-amber-500" aria-hidden />
              Dependency and capability posture
            </span>
          }
          description="Derived from real calls the platform made, not from health endpoints."
          footer="Unobserved is not healthy and not an outage: it is the state where the platform does not know, and it blocks money and market paths the same way an outage does."
        >
          <PosturePanel />
        </PanelCard>
      </main>
    </div>
  );
}
