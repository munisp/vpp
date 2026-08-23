import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { AlertTriangle, Clock, Info, RefreshCw, ShieldCheck } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import {
  CONTROL_DELIVERY_COPY,
  CONTROL_STATE_COPY,
  FALLBACK_COPY,
  formatRemaining,
  formatWatts,
  type ControlDelivery,
  type ControlState,
  type ControlTone,
} from "@/lib/control-state";
import { memberNotice } from "@/lib/degraded-operation";

const TONE_CLASS: Record<ControlTone, string> = {
  live: "bg-emerald-100 text-emerald-900 border-emerald-300",
  warning: "bg-amber-100 text-amber-900 border-amber-300",
  danger: "bg-red-100 text-red-900 border-red-300",
  neutral: "bg-muted text-muted-foreground border-border",
};

function StateBadge({ state }: { state: ControlState }) {
  const copy = CONTROL_STATE_COPY[state];
  if (!copy) return <Badge variant="outline">{state}</Badge>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={TONE_CLASS[copy.tone]}>
          {copy.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{copy.meaning}</TooltipContent>
    </Tooltip>
  );
}

function DeliveryBadge({ delivery }: { delivery: ControlDelivery }) {
  const copy = CONTROL_DELIVERY_COPY[delivery];
  if (!copy) return <Badge variant="outline">{delivery}</Badge>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={TONE_CLASS[copy.tone]}>
          {copy.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{copy.meaning}</TooltipContent>
    </Tooltip>
  );
}

/** Ticks locally so the countdown stays truthful between refetches. */
function useTick(ms = 1000): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return tick;
}

interface AssignmentRow {
  assignment: {
    id: number;
    protocol: string;
    targetRef: string;
    subTargetRef: number;
    source: string;
    setpointWatts: number | null;
    validFrom: string | Date;
    validTo: string | Date;
    fallbackPolicy: string;
    fallbackLimitWatts: number | null;
    delivery: string;
    deliveryDetail: string | null;
    fallbackDetail: string | null;
  };
  state: string;
  secondsRemaining: number;
}

function remainingSeconds(row: AssignmentRow): number {
  return Math.round((new Date(row.assignment.validTo).getTime() - Date.now()) / 1000);
}

function ControlTable({ rows, showOwner }: { rows: AssignmentRow[]; showOwner: boolean }) {
  useTick();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Target</TableHead>
          {showOwner && <TableHead>Source</TableHead>}
          <TableHead>Setpoint</TableHead>
          <TableHead>Window</TableHead>
          <TableHead>State</TableHead>
          <TableHead>Delivery</TableHead>
          <TableHead>Fallback</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(row => {
          const a = row.assignment;
          const remaining = remainingSeconds(row);
          return (
            <TableRow key={a.id}>
              <TableCell className="font-mono text-xs">
                {a.targetRef}
                {a.subTargetRef ? `:${a.subTargetRef}` : ""}
                <div className="text-muted-foreground uppercase">{a.protocol}</div>
              </TableCell>
              {showOwner && (
                <TableCell className="text-xs">{a.source.replace(/_/g, " ")}</TableCell>
              )}
              <TableCell className="whitespace-nowrap">{formatWatts(a.setpointWatts)}</TableCell>
              <TableCell className="whitespace-nowrap text-xs">
                <div className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {formatRemaining(remaining)}
                </div>
                <div className="text-muted-foreground">
                  ends {new Date(a.validTo).toLocaleTimeString()}
                </div>
              </TableCell>
              <TableCell>
                <StateBadge state={row.state as ControlState} />
              </TableCell>
              <TableCell>
                <DeliveryBadge delivery={a.delivery as ControlDelivery} />
              </TableCell>
              <TableCell className="text-xs">
                {FALLBACK_COPY[a.fallbackPolicy] ?? a.fallbackPolicy}
                {a.fallbackPolicy === "safe_limit" && (
                  <div className="text-muted-foreground">
                    {formatWatts(a.fallbackLimitWatts)}
                  </div>
                )}
                {a.fallbackDetail && (
                  <div className="text-muted-foreground">{a.fallbackDetail}</div>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export default function ControlWindows() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const utils = trpc.useUtils();

  const policy = trpc.controlWindows.policy.useQuery();
  const mine = trpc.controlWindows.mine.useQuery({ limit: 25 }, { refetchInterval: 15000 });
  const health = trpc.controlWindows.health.useQuery(undefined, {
    enabled: isAdmin,
    refetchInterval: 15000,
  });
  const fleet = trpc.controlWindows.fleet.useQuery(
    { limit: 50 },
    { enabled: isAdmin, refetchInterval: 15000 }
  );
  const serviceStatus = trpc.degradedOperation.memberStatus.useQuery(undefined, {
    refetchInterval: 60000,
  });

  const sweep = trpc.controlWindows.sweepNow.useMutation({
    onSuccess: result => {
      // Unconfirmed fallbacks are reported as such: an MQTT publish the broker
      // took is not proof the device returned to a safe setpoint.
      toast.success(
        `Swept ${result.examined}: ${result.applied} applied, ${result.held} held, ` +
          `${result.unconfirmed} unconfirmed, ${result.failed} failed`
      );
      utils.controlWindows.invalidate();
    },
    onError: e => toast.error(e.message || "Sweep failed"),
  });

  const mineRows = (mine.data?.assignments ?? []) as unknown as AssignmentRow[];
  const fleetRows = (fleet.data?.assignments ?? []) as unknown as AssignmentRow[];
  const awaiting = health.data?.awaitingFallback ?? 0;
  const controlNotice = serviceStatus.data
    ? memberNotice(
        serviceStatus.data.control.posture,
        serviceStatus.data.control.limitation
      )
    : null;

  return (
    <TooltipProvider>
      <DashboardLayout>
        <div className="space-y-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Control windows</h1>
            <p className="text-muted-foreground">
              Every command sent to your hardware, when it expires, and what the device falls back
              to. States show what the platform can prove, not what it hopes.
            </p>
          </div>

          {controlNotice && (
            <Card className="border-amber-300 bg-amber-50">
              <CardHeader className="flex flex-row items-center gap-2 pb-2">
                <AlertTriangle className="h-4 w-4 text-amber-700" />
                <CardTitle className="text-base text-amber-900">{controlNotice}</CardTitle>
              </CardHeader>
            </Card>
          )}

          {isAdmin && awaiting > 0 && (
            <Card className="border-red-300 bg-red-50">
              <CardHeader className="flex flex-row items-center gap-2 pb-2">
                <AlertTriangle className="h-4 w-4 text-red-700" />
                <CardTitle className="text-base text-red-900">
                  {awaiting} control{awaiting === 1 ? "" : "s"} outside a maintained window
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-red-900">
                Hardware is holding a setpoint whose window closed and whose fallback has not been
                delivered. Run the sweep or investigate the device connection.
              </CardContent>
            </Card>
          )}

          {isAdmin && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              {[
                { label: "Live", value: health.data?.live, tone: "live" as ControlTone },
                { label: "Expiring soon", value: health.data?.expiring, tone: "warning" as ControlTone },
                { label: "Awaiting fallback", value: health.data?.awaitingFallback, tone: "danger" as ControlTone },
                { label: "Fallback failed", value: health.data?.fallbackFailed, tone: "danger" as ControlTone },
                { label: "Held past window", value: health.data?.heldPastWindow, tone: "warning" as ControlTone },
              ].map(card => (
                <Card key={card.label}>
                  <CardHeader className="pb-2">
                    <CardDescription>{card.label}</CardDescription>
                    <CardTitle className="text-2xl">
                      {health.isLoading ? <Skeleton className="h-7 w-10" /> : (card.value ?? "—")}
                    </CardTitle>
                  </CardHeader>
                </Card>
              ))}
            </div>
          )}

          <Card>
            <CardHeader className="flex flex-row items-start justify-between">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4" /> My controls
                </CardTitle>
                <CardDescription>
                  {policy.data
                    ? `This deployment bounds every control between ${
                        policy.data.minValiditySeconds / 60
                      } and ${policy.data.maxValiditySeconds / 60} minutes.`
                    : "Loading control policy…"}
                </CardDescription>
              </div>
              {isAdmin && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => sweep.mutate()}
                  disabled={sweep.isPending}
                >
                  <RefreshCw className={`h-4 w-4 mr-2 ${sweep.isPending ? "animate-spin" : ""}`} />
                  Sweep expired now
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {mine.isLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : mine.error ? (
                <div className="text-sm text-red-700">{mine.error.message}</div>
              ) : mineRows.length === 0 ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Info className="h-4 w-4" />
                  No platform control is running on your assets. They are following their own local
                  logic.
                </div>
              ) : (
                <ControlTable rows={mineRows} showOwner={false} />
              )}
            </CardContent>
          </Card>

          {isAdmin && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Fleet</CardTitle>
                <CardDescription>Most recent controls across every target</CardDescription>
              </CardHeader>
              <CardContent>
                {fleet.isLoading ? (
                  <Skeleton className="h-32 w-full" />
                ) : fleet.error ? (
                  <div className="text-sm text-red-700">{fleet.error.message}</div>
                ) : (
                  <ControlTable rows={fleetRows} showOwner />
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </DashboardLayout>
    </TooltipProvider>
  );
}
