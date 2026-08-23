/**
 * "What is my equipment doing right now, and what can the platform actually see?"
 *
 * The twin is the most tempting screen in the product to fake: a diagram with
 * everything glowing reads as a healthy plant, and nobody checks whether the
 * glow came from a measurement. So every component here carries its evidence,
 * silent equipment is drawn as unknown rather than idle, and the coverage of the
 * picture is stated next to the picture.
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

import DashboardLayout from '@/components/DashboardLayout';
import { FreshnessBadge, MetricTile, PageHeader, PanelCard, ToneBadge } from '@/components/ops';
import { TwinDiagram, TwinLegend, formatAge, formatWatts } from '@/components/twin/TwinDiagram';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useWebSocket } from '@/hooks/useWebSocket';
import { trpc } from '@/lib/trpc';
import type { StateTone } from '@/lib/tone';

const EVIDENCE_LABEL = {
  measured: 'reporting',
  stale: 'stale',
  never: 'never reported',
} as const;

const EVIDENCE_TONE: Record<keyof typeof EVIDENCE_LABEL, StateTone> = {
  measured: 'live',
  stale: 'warning',
  never: 'neutral',
};

export default function DigitalTwin() {
  const utils = trpc.useUtils();
  const twin = trpc.digitalTwin.mine.useQuery(undefined, { refetchInterval: 30_000 });
  const { telemetry, connected } = useWebSocket();
  const [lastPush, setLastPush] = useState<Date | null>(null);

  /**
   * Real-time here means "a telemetry row was persisted and pushed to us, so
   * re-read the twin" — the diagram is never patched from the socket payload
   * alone, so what is drawn is always what the database holds.
   */
  useEffect(() => {
    if (!telemetry) return;
    setLastPush(new Date());
    void utils.digitalTwin.mine.invalidate();
  }, [telemetry, utils]);

  const graph = twin.data;
  const rows = useMemo(
    () => (graph?.nodes ?? []).filter(node => node.assetId !== undefined),
    [graph]
  );

  const coverageTone: StateTone = !graph
    ? 'neutral'
    : graph.coverage.assets === 0
      ? 'neutral'
      : graph.coverage.measured === graph.coverage.assets
        ? 'good'
        : graph.coverage.measured === 0
          ? 'danger'
          : 'warning';

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <PageHeader
          title="Digital twin"
          description="A single-line diagram of your equipment, built from the latest telemetry row each component wrote."
          caveat="A flowing connection is a measurement the platform received — not confirmation that the device is doing what it was told. A component drawn as unknown may be running unseen."
          actions={
            <div className="flex items-center gap-2">
              <ToneBadge
                label={connected ? 'stream connected' : 'stream offline'}
                tone={connected ? 'live' : 'warning'}
                meaning={
                  connected
                    ? 'The authenticated telemetry stream is open; the diagram re-reads the database on each push.'
                    : 'The telemetry stream is closed, so the diagram only refreshes on the 30-second poll. Ages shown may run behind.'
                }
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => void utils.digitalTwin.mine.invalidate()}
                disabled={twin.isFetching}
              >
                <RefreshCw className={twin.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
                Refresh
              </Button>
            </div>
          }
        />

        {twin.isError && (
          <div className="flex items-start gap-3 rounded-lg border border-red-300 bg-red-50 p-4 text-sm dark:border-red-800 dark:bg-red-950/50">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-300" />
            <div>
              <p className="font-medium text-red-900 dark:text-red-200">
                The twin could not be read, so nothing is drawn.
              </p>
              <p className="text-red-800 dark:text-red-300">{twin.error.message}</p>
            </div>
          </div>
        )}

        {twin.isLoading && <Skeleton className="h-80 w-full" />}

        {graph && (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <MetricTile
                label="Net behind the meter"
                value={
                  graph.measuredBehindMeter > 0 ? formatWatts(graph.measuredNetPowerWatts) : null
                }
                tone={graph.measuredBehindMeter > 0 ? 'live' : 'neutral'}
                status={{
                  label: `${graph.coverage.measured}/${graph.coverage.assets} reporting`,
                  tone: coverageTone,
                  meaning:
                    'Generation, load and storage that is currently reporting, summed. Meters are excluded because a meter measures the boundary, not another load behind it. Silent equipment is left out rather than counted as zero, so this figure is a floor when coverage is partial.',
                }}
                evidence={
                  <FreshnessBadge asOf={graph.generatedAt} stalenessSeconds={60} />
                }
              />
              <MetricTile
                label="Grid exchange at the meter"
                value={
                  graph.meteredGridPowerWatts === null
                    ? null
                    : formatWatts(graph.meteredGridPowerWatts)
                }
                tone={graph.meteredGridPowerWatts === null ? 'neutral' : 'live'}
                status={{
                  label: graph.meteredGridPowerWatts === null ? 'no meter reporting' : 'metered',
                  tone: graph.meteredGridPowerWatts === null ? 'neutral' : 'live',
                  meaning:
                    'Import and export are only shown when a meter measured them. With no meter reporting, the exchange with the grid is unknown, not zero.',
                }}
              />
              <MetricTile
                label="Stale components"
                value={String(graph.coverage.stale)}
                tone={graph.coverage.stale > 0 ? 'warning' : 'good'}
                evidence={
                  <span className="text-muted-foreground">
                    last reading older than the expected interval
                  </span>
                }
              />
              <MetricTile
                label="Never reported"
                value={String(graph.coverage.neverObserved)}
                tone={graph.coverage.neverObserved > 0 ? 'warning' : 'good'}
                evidence={
                  <span className="text-muted-foreground">no telemetry has ever been recorded</span>
                }
              />
              <MetricTile
                label="Unseen rated capacity"
                value={formatWatts(graph.coverage.unseenCapacity)}
                tone={graph.coverage.unseenCapacity > 0 ? 'warning' : 'good'}
                evidence={
                  <span className="text-muted-foreground">
                    nameplate behind stale or silent components
                  </span>
                }
              />
            </div>

            <PanelCard
              title={graph.siteLabel}
              description="Grid, metering point, site bus, then equipment. Movement means measured, non-zero power."
              footer={graph.caveat}
              actions={
                lastPush ? (
                  <span className="text-xs text-muted-foreground">
                    last stream push {formatAge((Date.now() - lastPush.getTime()) / 1000)}
                  </span>
                ) : undefined
              }
              bodyClassName="space-y-4"
            >
              <TwinDiagram graph={graph} />
              <TwinLegend />
            </PanelCard>

            <PanelCard
              title="Component evidence"
              description="Every registered component, including the ones the platform cannot see."
              footer="An empty power column is an absent measurement. It is not a measured zero, and the two are never merged here."
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Component</TableHead>
                    <TableHead>Evidence</TableHead>
                    <TableHead className="text-right">Power</TableHead>
                    <TableHead className="text-right">Age</TableHead>
                    <TableHead className="text-right">Rated</TableHead>
                    <TableHead>Devices</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(node => {
                    const power = formatWatts(node.powerWatts);
                    const last = formatWatts(node.lastPowerWatts);
                    return (
                      <TableRow key={node.id}>
                        <TableCell className="font-medium">{node.label}</TableCell>
                        <TableCell>
                          <ToneBadge
                            label={EVIDENCE_LABEL[node.evidence]}
                            tone={EVIDENCE_TONE[node.evidence]}
                            meaning={node.detail}
                          />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {power ?? (
                            <span className="text-muted-foreground">
                              {last ? `${last} (last known)` : 'unknown'}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatAge(node.ageSeconds) ?? (
                            <span className="text-muted-foreground">never</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatWatts(node.capacity) ?? '—'}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {node.devices.length === 0
                            ? 'no device registered'
                            : node.devices
                                .map(
                                  device =>
                                    `${device.deviceType} ${device.deviceId}${device.enabled ? '' : ' (disabled)'}`
                                )
                                .join(', ')}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {rows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-sm text-muted-foreground">
                        No equipment is registered against your account.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </PanelCard>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
