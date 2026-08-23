/**
 * "What the fleet did, and how much of the fleet we could see while it did it."
 *
 * A rolling aggregate is the number an aggregator quotes to a grid operator, and
 * the way that number goes wrong is silence: assets that reported nothing shrink
 * the fleet without shrinking the claim. Every row here carries its coverage, the
 * rated capacity that reported nothing, and whether the bucket has even closed.
 * Gaps in the series are attributed to the rollup, not to the fleet.
 */

import { useState } from "react";

import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { AlertTriangle, Info, RefreshCw } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import {
  FreshnessBadge,
  MetricTile,
  PageHeader,
  PanelCard,
  ToneBadge,
} from "@/components/ops";
import {
  BUCKET_STATE_COPY,
  coverageVerdict,
  describeAvailableEnergy,
  formatFleetKw,
  formatFleetKwh,
  formatKwh,
  summariseSeries,
  type FleetBucket,
} from "@/lib/fleet-telemetry";

const BUCKET_MINUTES = 15;
const BUCKETS = 24;

function FleetSeries() {
  const utils = trpc.useUtils();
  const [region, setRegion] = useState("");
  const [appliedRegion, setAppliedRegion] = useState("");

  const series = trpc.fleetTelemetry.rolling.useQuery(
    appliedRegion
      ? {
          scopeType: "region" as const,
          region: appliedRegion,
          bucketMinutes: BUCKET_MINUTES,
          buckets: BUCKETS,
        }
      : {
          scopeType: "fleet" as const,
          bucketMinutes: BUCKET_MINUTES,
          buckets: BUCKETS,
        },
    { refetchInterval: 60000 }
  );

  const rollUp = trpc.fleetTelemetry.rollUp.useMutation({
    onSuccess: result => {
      const latest = result.buckets[result.buckets.length - 1];
      toast.success(
        latest
          ? `Recomputed ${result.buckets.length} bucket${result.buckets.length === 1 ? "" : "s"}; ` +
              `${latest.silentAssets} of ${latest.expectedAssets} assets silent in the newest`
          : "Nothing to recompute"
      );
      utils.fleetTelemetry.rolling.invalidate();
    },
    onError: error => toast.error(error.message || "Rollup failed"),
  });

  if (series.isLoading) return <Skeleton className="h-40 w-full" />;
  if (series.error) {
    // A failed read is an outage, never an empty fleet.
    return (
      <div className="flex items-start gap-2 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
        <AlertTriangle className="mt-0.5 h-4 w-4" />
        <span>{series.error.message}</span>
      </div>
    );
  }

  const buckets = (series.data?.buckets ?? []) as FleetBucket[];
  const summary = summariseSeries(buckets, series.data?.missingBuckets ?? 0);
  // Open buckets are excluded: an unelapsed bucket would drag the trend toward
  // zero and read as the fleet falling away.
  const powerTrend = buckets
    .filter(bucket => bucket.state !== "open")
    .map(bucket => ({ value: bucket.meanNetPowerWatts }));
  const latestCoverage = summary.latest
    ? coverageVerdict(summary.latest)
    : undefined;
  const coverageTone =
    summary.worstCapacityShare === null
      ? "neutral"
      : summary.worstCapacityShare >= 0.9
        ? "good"
        : summary.worstCapacityShare >= 0.6
          ? "warning"
          : "danger";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            Region (blank = whole fleet)
          </p>
          <Input
            value={region}
            onChange={event => setRegion(event.target.value)}
            placeholder="e.g. TZ-DAR"
            className="w-48"
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setAppliedRegion(region.trim())}
        >
          Apply scope
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            rollUp.mutate(
              appliedRegion
                ? {
                    scopeType: "region" as const,
                    region: appliedRegion,
                    bucketMinutes: BUCKET_MINUTES,
                    buckets: 4,
                  }
                : {
                    scopeType: "fleet" as const,
                    bucketMinutes: BUCKET_MINUTES,
                    buckets: 4,
                  }
            )
          }
          disabled={rollUp.isPending}
        >
          <RefreshCw
            className={`mr-2 h-4 w-4 ${rollUp.isPending ? "animate-spin" : ""}`}
          />
          Recompute recent buckets
        </Button>
      </div>

      {summary.missingBuckets > 0 && (
        <div className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          <span>
            {summary.missingBuckets} of the last {BUCKETS} buckets have never
            been computed. That is a gap in the rollup, not a quiet fleet — set
            FLEET_TELEMETRY_ROLLUP_MS or recompute by hand.
          </span>
        </div>
      )}

      {buckets.length === 0 ? (
        <div className="flex items-start gap-2 text-sm text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4" />
          <span>
            No aggregate has been computed for this scope. Nothing is inferred
            from telemetry on read, so the series stays empty until a rollup
            runs.
          </span>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricTile
              label="Latest closed power"
              value={
                summary.latest
                  ? formatFleetKw(summary.latest.meanNetPowerWatts)
                  : null
              }
              tone={summary.latest ? "live" : "neutral"}
              status={summary.latest ? latestCoverage : undefined}
              evidence={
                summary.latest ? (
                  <>
                    <FreshnessBadge
                      asOf={summary.latest.bucketStartsAt}
                      stalenessSeconds={BUCKET_MINUTES * 60 * 2}
                    />
                    <span className="text-muted-foreground">
                      {summary.latest.samples} telemetry rows
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">
                    no bucket has closed yet
                  </span>
                )
              }
              trend={{ points: powerTrend, tone: "live" }}
            />
            <MetricTile
              label="Worst measured coverage"
              value={
                summary.worstCapacityShare === null
                  ? null
                  : `${(summary.worstCapacityShare * 100).toFixed(0)}%`
              }
              tone={coverageTone}
              evidence={
                <span className="text-muted-foreground">
                  of rated capacity, across closed buckets
                </span>
              }
            />
            <MetricTile
              label="Buckets with silence"
              value={`${summary.bucketsWithSilence} / ${buckets.length}`}
              tone={summary.bucketsWithSilence > 0 ? "warning" : "good"}
              evidence={
                <span className="text-muted-foreground">
                  a silent asset shrinks the fleet, never the claim
                </span>
              }
            />
            <MetricTile
              label="Still filling"
              value={String(summary.openBuckets)}
              tone={summary.openBuckets > 0 ? "neutral" : "good"}
              evidence={
                <span className="text-muted-foreground">
                  an open bucket is not evidence yet
                </span>
              }
            />
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Bucket</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Measured power</TableHead>
                <TableHead>Energy</TableHead>
                <TableHead>Coverage</TableHead>
                <TableHead>Unseen capacity</TableHead>
                <TableHead>Stored energy</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...buckets].reverse().map(bucket => {
                const coverage = coverageVerdict(bucket);
                const stateCopy = BUCKET_STATE_COPY[bucket.state];
                const stored = describeAvailableEnergy(bucket);
                return (
                  <TableRow key={new Date(bucket.bucketStartsAt).toISOString()}>
                    <TableCell className="whitespace-nowrap">
                      {new Date(bucket.bucketStartsAt).toLocaleTimeString()}
                      <span className="text-muted-foreground">
                        {" "}
                        · {bucket.bucketMinutes}m
                      </span>
                    </TableCell>
                    <TableCell>
                      <ToneBadge {...stateCopy} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatFleetKw(bucket.meanNetPowerWatts)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatFleetKwh(bucket.integratedEnergyWh)}
                    </TableCell>
                    <TableCell>
                      <ToneBadge
                        label={coverage.label}
                        tone={coverage.tone}
                        meaning={coverage.meaning}
                      />
                      <span className="ml-2 text-xs text-muted-foreground">
                        {bucket.reportingAssets}/{bucket.expectedAssets} assets
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatKwh(bucket.silentCapacityWh)}
                    </TableCell>
                    <TableCell>
                      <ToneBadge {...stored} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </>
      )}
    </div>
  );
}

export default function FleetTelemetry() {
  const { user } = useAuth();

  return (
    <DashboardLayout>
      <div>
        <PageHeader
          title="Rolling fleet telemetry"
          description="Aggregates in 15-minute buckets, with the coverage behind each figure."
          caveat="Energy here is integrated from telemetry samples, not read off a revenue meter — settlement uses the metered paths, not this table."
        />

        <PanelCard
          title="Fleet and regional aggregates"
          description="A regional aggregate covers the active members of the communities in that region; assets outside every community appear only in the fleet figure."
          footer="Nothing on this page is inferred on read: a bucket the rollup never computed is reported missing rather than filled in."
        >
          {user?.role === "admin" ? (
            <FleetSeries />
          ) : (
            <div className="text-muted-foreground flex items-start gap-2 text-sm">
              <Info className="mt-0.5 h-4 w-4" />
              <span>
                Fleet-wide and regional aggregates are an operator view: they
                describe every participant's consumption, so they are restricted
                to administrators. Your own community's rolling profile is
                available in the mobile app.
              </span>
            </div>
          )}
        </PanelCard>
      </div>
    </DashboardLayout>
  );
}
