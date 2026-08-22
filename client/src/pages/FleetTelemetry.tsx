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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { AlertTriangle, Info, RefreshCw } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import {
  BUCKET_STATE_COPY,
  coverageVerdict,
  describeAvailableEnergy,
  formatFleetKw,
  formatFleetKwh,
  formatKwh,
  summariseSeries,
  type CoverageTone,
  type FleetBucket,
} from "@/lib/fleet-telemetry";

const TONE_CLASS: Record<CoverageTone, string> = {
  good: "bg-emerald-100 text-emerald-900 border-emerald-300",
  warning: "bg-amber-100 text-amber-900 border-amber-300",
  danger: "bg-red-100 text-red-900 border-red-300",
  neutral: "bg-muted text-muted-foreground border-border",
};

function ToneBadge({
  label,
  tone,
  meaning,
}: {
  label: string;
  tone: CoverageTone;
  meaning?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={TONE_CLASS[tone]}>
          {label}
        </Badge>
      </TooltipTrigger>
      {meaning && <TooltipContent className="max-w-xs">{meaning}</TooltipContent>}
    </Tooltip>
  );
}

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
      : { scopeType: "fleet" as const, bucketMinutes: BUCKET_MINUTES, buckets: BUCKETS },
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Region (blank = whole fleet)</p>
          <Input
            value={region}
            onChange={event => setRegion(event.target.value)}
            placeholder="e.g. TZ-DAR"
            className="w-48"
          />
        </div>
        <Button size="sm" variant="outline" onClick={() => setAppliedRegion(region.trim())}>
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
                : { scopeType: "fleet" as const, bucketMinutes: BUCKET_MINUTES, buckets: 4 }
            )
          }
          disabled={rollUp.isPending}
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${rollUp.isPending ? "animate-spin" : ""}`} />
          Recompute recent buckets
        </Button>
      </div>

      {summary.missingBuckets > 0 && (
        <div className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          <span>
            {summary.missingBuckets} of the last {BUCKETS} buckets have never been computed. That
            is a gap in the rollup, not a quiet fleet — set FLEET_TELEMETRY_ROLLUP_MS or recompute
            by hand.
          </span>
        </div>
      )}

      {buckets.length === 0 ? (
        <div className="flex items-start gap-2 text-sm text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4" />
          <span>
            No aggregate has been computed for this scope. Nothing is inferred from telemetry on
            read, so the series stays empty until a rollup runs.
          </span>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <div>
              <p className="text-xs text-muted-foreground">Latest closed power</p>
              <p className="text-lg font-semibold">
                {summary.latest ? formatFleetKw(summary.latest.meanNetPowerWatts) : "—"}
              </p>
              <p className="text-xs text-muted-foreground">
                {summary.latest ? `${summary.latest.samples} telemetry rows` : ""}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Worst measured coverage</p>
              <p className="text-lg font-semibold">
                {summary.worstCapacityShare === null
                  ? "—"
                  : `${(summary.worstCapacityShare * 100).toFixed(0)}%`}
              </p>
              <p className="text-xs text-muted-foreground">of rated capacity, closed buckets</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Buckets with silence</p>
              <p className="text-lg font-semibold">
                {summary.bucketsWithSilence} / {buckets.length}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Still filling</p>
              <p className="text-lg font-semibold">{summary.openBuckets}</p>
              <p className="text-xs text-muted-foreground">not evidence yet</p>
            </div>
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
                      <span className="text-muted-foreground"> · {bucket.bucketMinutes}m</span>
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
      <TooltipProvider>
        <div className="space-y-6">
          <div>
            <h1 className="text-2xl font-semibold">Rolling fleet telemetry</h1>
            <p className="text-sm text-muted-foreground">
              Aggregates in 15-minute buckets with the coverage behind each figure. Energy here is
              integrated from telemetry samples, not read off a revenue meter — settlement uses the
              metered paths, not this table.
            </p>
          </div>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Fleet and regional aggregates</CardTitle>
              <CardDescription>
                A regional aggregate covers the active members of the communities in that region;
                assets outside every community appear only in the fleet figure.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {user?.role === "admin" ? (
                <FleetSeries />
              ) : (
                <div className="flex items-start gap-2 text-sm text-muted-foreground">
                  <Info className="mt-0.5 h-4 w-4" />
                  <span>
                    Fleet-wide and regional aggregates are an operator view: they describe every
                    participant's consumption, so they are restricted to administrators. Your own
                    community's rolling profile is available in the mobile app.
                  </span>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </TooltipProvider>
    </DashboardLayout>
  );
}
