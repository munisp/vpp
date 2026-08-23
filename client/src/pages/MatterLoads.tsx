/**
 * "Which household loads can we actually control, and which can we prove?"
 *
 * Matter nodes are appliances inside people's homes. The failure this screen is
 * built against is reachability reading as control: a green "online" badge next
 * to a water heater the platform has never measured invites an operator to count
 * it as flexibility. So each node is shown by what it published — clusters,
 * measurements — and the fabric summary leads with the number of loads that can
 * be commanded but not verified.
 *
 * Everything here is the controller's last report held by the platform, not a
 * live read of the fabric.
 */

import { useState } from "react";

import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { AlertTriangle, Info, RefreshCw } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import {
  CONTROLLABILITY_COPY,
  ENFORCEMENT_COPY,
  controllability,
  describeCapability,
  formatMeasurement,
  measuredEnergyWh,
  measuredWatts,
  nodeVerdict,
  reportedOnOff,
  summariseFabric,
  type MatterNode,
  type NodeTone,
} from "@/lib/matter-loads";

const TONE_CLASS: Record<NodeTone, string> = {
  good: "bg-emerald-100 text-emerald-900 border-emerald-300",
  warning: "bg-amber-100 text-amber-900 border-amber-300",
  danger: "bg-red-100 text-red-900 border-red-300",
  neutral: "bg-muted text-muted-foreground border-border",
};

function ToneBadge({ label, tone, meaning }: { label: string; tone: NodeTone; meaning?: string }) {
  const badge = (
    <Badge variant="outline" className={TONE_CLASS[tone]}>
      {label}
    </Badge>
  );
  if (!meaning) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-help items-center gap-1">
          {badge}
          <Info className="h-3 w-3 text-muted-foreground" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs">{meaning}</TooltipContent>
    </Tooltip>
  );
}

function formatTimestamp(value: string | Date | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function NodeRow({ node }: { node: MatterNode }) {
  const verdict = nodeVerdict(node);
  const control = controllability(node);
  const controlCopy = CONTROLLABILITY_COPY[control];
  const watts = measuredWatts(node);
  const energyWh = measuredEnergyWh(node);
  const onOff = reportedOnOff(node);

  return (
    <TableRow>
      <TableCell className="font-mono text-xs">
        {node.nodeId}
        <div className="text-muted-foreground">fabric {node.fabricId}</div>
      </TableCell>
      <TableCell>
        <ToneBadge label={verdict.label} tone={verdict.tone} meaning={verdict.meaning} />
      </TableCell>
      <TableCell>
        <ToneBadge
          label={controlCopy.label}
          tone={control === "controllable" ? "good" : control === "metered_only" ? "warning" : "neutral"}
          meaning={controlCopy.meaning}
        />
      </TableCell>
      <TableCell className="text-xs">
        {node.capabilities.length === 0 ? (
          <span className="text-muted-foreground">None published</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {node.capabilities.map(capability => (
              <Badge
                key={`${capability.endpointId}/${capability.clusterId}`}
                variant="secondary"
                className="font-normal"
              >
                {describeCapability(capability)}
                <span className="ml-1 text-muted-foreground">ep{capability.endpointId}</span>
              </Badge>
            ))}
          </div>
        )}
      </TableCell>
      <TableCell className="text-right text-xs">
        <div>{formatMeasurement(watts, "W")}</div>
        <div className="text-muted-foreground">{formatMeasurement(energyWh, "Wh")}</div>
      </TableCell>
      <TableCell className="text-xs">
        {onOff === null ? (
          <span className="text-muted-foreground">Not reported</span>
        ) : (
          <Badge variant="outline">{onOff ? "On" : "Off"}</Badge>
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {formatTimestamp(node.lastReportedAt)}
      </TableCell>
    </TableRow>
  );
}

export default function MatterLoads() {
  const { user } = useAuth();
  const [refreshing, setRefreshing] = useState(false);
  const query = trpc.matterLoads.nodes.useQuery(undefined, { enabled: user?.role === "admin" });

  if (user?.role !== "admin") {
    return (
      <DashboardLayout>
        <Card>
          <CardHeader>
            <CardTitle>Smart-home loads</CardTitle>
            <CardDescription>
              The Matter fabric lists the appliances inside members&apos; homes, so it is visible to
              platform administrators only.
            </CardDescription>
          </CardHeader>
        </Card>
      </DashboardLayout>
    );
  }

  const nodes = (query.data?.nodes ?? []) as MatterNode[];
  const summary = summariseFabric(nodes);

  return (
    <TooltipProvider>
      <DashboardLayout>
        <div className="space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold">Smart-home loads (Matter)</h1>
              <p className="max-w-3xl text-sm text-muted-foreground">
                What the Matter controller last reported to the platform. Reachability is not
                delivery: a load counts as flexibility only where a measurement shows what it did.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={refreshing || query.isFetching}
              onClick={async () => {
                setRefreshing(true);
                try {
                  await query.refetch();
                } finally {
                  setRefreshing(false);
                }
              }}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>

          {query.isError && (
            <Card className="border-red-300">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <AlertTriangle className="h-4 w-4 text-red-600" />
                  The fabric could not be read
                </CardTitle>
                <CardDescription>
                  {query.error.message} — this is not an empty fabric; nothing is known about the
                  nodes right now.
                </CardDescription>
              </CardHeader>
            </Card>
          )}

          {query.isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>Commissioned nodes</CardDescription>
                    <CardTitle className="text-2xl">{summary.nodes}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    {summary.reachable} reachable · {summary.unreachable} unreachable ·{" "}
                    {summary.removed} removed
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>Controllable</CardDescription>
                    <CardTitle className="text-2xl">{summary.controllable}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    Published a load control cluster. {summary.meteredOnly} more can be measured but
                    not commanded.
                  </CardContent>
                </Card>
                <Card className={summary.controllableWithoutMeasurement > 0 ? "border-amber-300" : undefined}>
                  <CardHeader className="pb-2">
                    <CardDescription>Controllable, unverifiable</CardDescription>
                    <CardTitle className="text-2xl">
                      {summary.controllableWithoutMeasurement}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    Can be commanded and has reported no measurement, so a dispatch to it cannot be
                    shown to have happened.
                  </CardContent>
                </Card>
                <Card className={summary.syntheticNodes > 0 ? "border-red-300" : undefined}>
                  <CardHeader className="pb-2">
                    <CardDescription>Synthetic controller nodes</CardDescription>
                    <CardTitle className="text-2xl">{summary.syntheticNodes}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    Acknowledge commands no appliance performs. Refused for dispatch unless the
                    deployment opted in.
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">How a Matter window ends</CardTitle>
                  <CardDescription>
                    Matter commands do not all carry an expiry, and that difference decides what
                    happens to a trimmed load if the platform goes away.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
                  {(["device", "platform"] as const).map(mode => (
                    <div key={mode} className="rounded-md border p-3">
                      <div className="font-medium">{ENFORCEMENT_COPY[mode].label}</div>
                      <p className="text-xs text-muted-foreground">{ENFORCEMENT_COPY[mode].meaning}</p>
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Nodes</CardTitle>
                  <CardDescription>
                    Last reported {formatTimestamp(query.data?.lastReportedAt ?? null)}. A node that
                    stopped reporting keeps its history and is marked removed.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {nodes.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No Matter node has been reported. This platform has no Matter stack of its own:
                      without a controller connected, there is nothing to show and nothing to
                      command.
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Node</TableHead>
                          <TableHead>State</TableHead>
                          <TableHead>Dispatchable</TableHead>
                          <TableHead>Published clusters</TableHead>
                          <TableHead className="text-right">Measured</TableHead>
                          <TableHead>On/Off</TableHead>
                          <TableHead>Last report</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {nodes.map(node => (
                          <NodeRow key={node.id} node={node} />
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </DashboardLayout>
    </TooltipProvider>
  );
}
