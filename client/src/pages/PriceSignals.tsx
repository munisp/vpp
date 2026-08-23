/**
 * "What the fleet was asked to be worth, and what it actually did."
 *
 * Price-signal dispatch replaces pushing setpoints at customers with paying for
 * a shape: the aggregator publishes a price, each site plans against its own
 * load, and the plans are aggregated back up. The screen keeps the price, the
 * plan and the meter in three separate columns, because a published price is not
 * a delivered kilowatt-hour.
 */

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
import { toast } from "sonner";
import { AlertTriangle, Info, RefreshCw, Send } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import {
  SIGNAL_DELIVERY_COPY,
  SIGNAL_RESPONSE_COPY,
  SIGNAL_STATUS_COPY,
  describeAdjustment,
  formatNetKw,
  formatNetKwh,
  planVerdict,
  summariseResponses,
  type SignalCopy,
  type SignalDelivery,
  type SignalResponse,
  type SignalStatus,
  type SignalTone,
} from "@/lib/price-signal";

const TONE_CLASS: Record<SignalTone, string> = {
  good: "bg-emerald-100 text-emerald-900 border-emerald-300",
  warning: "bg-amber-100 text-amber-900 border-amber-300",
  danger: "bg-red-100 text-red-900 border-red-300",
  neutral: "bg-muted text-muted-foreground border-border",
};

function CopyBadge({ copy }: { copy: SignalCopy | { label: string; tone: SignalTone; meaning?: string } }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={TONE_CLASS[copy.tone]}>
          {copy.label}
        </Badge>
      </TooltipTrigger>
      {copy.meaning && <TooltipContent className="max-w-xs">{copy.meaning}</TooltipContent>}
    </Tooltip>
  );
}

function formatWindow(startsAt: string | Date, endsAt: string | Date): string {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  return `${start.toLocaleString()} → ${end.toLocaleTimeString()}`;
}

function OperatorView() {
  const utils = trpc.useUtils();
  const list = trpc.priceSignal.list.useQuery({ limit: 10 }, { refetchInterval: 60000 });

  const publish = trpc.priceSignal.publish.useMutation({
    onSuccess: result => {
      // Both halves are reported: a partially delivered signal is not a sent one.
      toast.success(
        `Offered to ${result.queued} site${result.queued === 1 ? "" : "s"}` +
          (result.failed > 0 ? `; ${result.failed} could not be reached` : "")
      );
      utils.priceSignal.list.invalidate();
    },
    onError: error => toast.error(error.message || "Publishing failed"),
  });

  const score = trpc.priceSignal.score.useMutation({
    onSuccess: result => {
      const summary = summariseResponses(result.sites);
      toast.success(
        `${summary.followed} followed, ${summary.deviated} deviated, ` +
          `${summary.noTelemetry} with no meter data`
      );
      utils.priceSignal.list.invalidate();
    },
    onError: error => toast.error(error.message || "Scoring failed"),
  });

  const signals = list.data?.signals ?? [];

  if (list.isLoading) return <Skeleton className="h-40 w-full" />;
  if (list.error) return <p className="text-sm text-red-700">{list.error.message}</p>;
  if (signals.length === 0) {
    return (
      <div className="flex items-start gap-2 text-sm text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4" />
        <span>
          No fleet price signal has been coordinated yet. Coordination needs sites with at
          least a month of metered history — sites without it are excluded rather than given an
          assumed load profile.
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {signals.map(signal => {
        const status = SIGNAL_STATUS_COPY[signal.status as SignalStatus];
        const responses = summariseResponses(
          signal.sites.map(site => ({
            response: site.response as SignalResponse,
            plannedNetWh: site.plannedNetWh,
            actualNetWh: site.actualNetWh,
          }))
        );
        const windowClosed = new Date(signal.endsAt).getTime() <= Date.now();

        return (
          <Card key={signal.signalId}>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    {signal.signalId}
                    <CopyBadge copy={status} />
                  </CardTitle>
                  <CardDescription>
                    {formatWindow(signal.startsAt, signal.endsAt)} · {signal.intervalMinutes}-minute
                    intervals · solver {signal.solver}, {signal.iterations} iterations
                  </CardDescription>
                </div>
                <div className="flex gap-2">
                  {signal.status === "draft" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => publish.mutate({ signalId: signal.signalId })}
                      disabled={publish.isPending}
                    >
                      <Send className="mr-2 h-4 w-4" /> Offer to sites
                    </Button>
                  )}
                  {signal.status === "published" && windowClosed && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => score.mutate({ signalId: signal.signalId })}
                      disabled={score.isPending}
                    >
                      <RefreshCw
                        className={`mr-2 h-4 w-4 ${score.isPending ? "animate-spin" : ""}`}
                      />
                      Measure response
                    </Button>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {signal.status === "not_converged" && (
                <div className="flex items-start gap-2 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
                  <AlertTriangle className="mt-0.5 h-4 w-4" />
                  <span>
                    The coordination stopped {formatNetKw(signal.maxDeviationW)} away from the
                    requested profile at its worst interval. It is kept for the record and
                    cannot be offered to sites.
                  </span>
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-4">
                <div>
                  <p className="text-xs text-muted-foreground">Sites offered</p>
                  <p className="text-lg font-semibold">{signal.sites.length}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Followed / deviated</p>
                  <p className="text-lg font-semibold">
                    {responses.followed} / {responses.deviated}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Measured energy</p>
                  <p className="text-lg font-semibold">
                    {formatNetKwh(responses.measuredActualWh)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    against {formatNetKwh(responses.measuredPlannedWh)} planned by the same
                    sites
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Unmeasured sites</p>
                  <p className="text-lg font-semibold">
                    {responses.unmeasured + responses.noTelemetry}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {responses.noTelemetry} closed with no meter data
                  </p>
                </div>
              </div>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Interval</TableHead>
                    <TableHead>Base price</TableHead>
                    <TableHead>Signal</TableHead>
                    <TableHead>Grid asked for</TableHead>
                    <TableHead>Fleet planned</TableHead>
                    <TableHead>Gap</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {signal.intervals.slice(0, 12).map(interval => {
                    const adjustment = describeAdjustment(interval.signalAdjustmentCentsPerKwh);
                    const verdict = planVerdict(interval.targetNetW, interval.plannedNetW);
                    return (
                      <TableRow key={interval.intervalIndex}>
                        <TableCell className="whitespace-nowrap">
                          {new Date(interval.startsAt).toLocaleTimeString()}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {interval.baseImportPriceCentsPerKwh.toFixed(2)}¢/kWh
                        </TableCell>
                        <TableCell>
                          <CopyBadge copy={{ ...adjustment, meaning: undefined }} />
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {formatNetKw(interval.targetNetW)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {formatNetKw(interval.plannedNetW)}
                        </TableCell>
                        <TableCell>
                          <CopyBadge copy={verdict} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Site</TableHead>
                    <TableHead>Delivery</TableHead>
                    <TableHead>Planned</TableHead>
                    <TableHead>Metered</TableHead>
                    <TableHead>Samples</TableHead>
                    <TableHead>Outcome</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {signal.sites.map(site => (
                    <TableRow key={site.siteRef}>
                      <TableCell>{site.siteRef}</TableCell>
                      <TableCell>
                        <CopyBadge copy={SIGNAL_DELIVERY_COPY[site.delivery as SignalDelivery]} />
                        {site.deliveryDetail && (
                          <div className="text-xs text-red-700">{site.deliveryDetail}</div>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {formatNetKwh(site.plannedNetWh)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {formatNetKwh(site.actualNetWh)}
                      </TableCell>
                      <TableCell>{site.telemetrySamples}</TableCell>
                      <TableCell>
                        <CopyBadge copy={SIGNAL_RESPONSE_COPY[site.response as SignalResponse]} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function ParticipantView() {
  const mine = trpc.priceSignal.mySignals.useQuery({ limit: 10 }, { refetchInterval: 60000 });
  const signals = mine.data?.signals ?? [];

  if (mine.isLoading) return <Skeleton className="h-40 w-full" />;
  if (mine.error) return <p className="text-sm text-red-700">{mine.error.message}</p>;
  if (signals.length === 0) {
    return (
      <div className="flex items-start gap-2 text-sm text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4" />
        <span>Your site has not been offered a price signal yet.</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {signals.map(signal => (
        <Card key={signal.signalId}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              {formatWindow(signal.startsAt, signal.endsAt)}
              <CopyBadge copy={SIGNAL_STATUS_COPY[signal.status as SignalStatus]} />
            </CardTitle>
            <CardDescription>
              {signal.site
                ? `Your plan under this price: ${formatNetKwh(signal.site.plannedNetWh)}`
                : "Your site's plan for this signal is unavailable."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {signal.site && (
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <p className="text-xs text-muted-foreground">Delivery</p>
                  <CopyBadge copy={SIGNAL_DELIVERY_COPY[signal.site.delivery as SignalDelivery]} />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Your meter</p>
                  <p className="text-sm font-medium">{formatNetKwh(signal.site.actualNetWh)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Outcome</p>
                  <CopyBadge copy={SIGNAL_RESPONSE_COPY[signal.site.response as SignalResponse]} />
                </div>
              </div>
            )}

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>From</TableHead>
                  <TableHead>Your price</TableHead>
                  <TableHead>Signal</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {signal.intervals.slice(0, 12).map(interval => (
                  <TableRow key={interval.intervalIndex}>
                    <TableCell className="whitespace-nowrap">
                      {new Date(interval.startsAt).toLocaleTimeString()}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {(
                        interval.baseImportPriceCentsPerKwh +
                        interval.signalAdjustmentCentsPerKwh
                      ).toFixed(2)}
                      ¢/kWh
                    </TableCell>
                    <TableCell>
                      <CopyBadge
                        copy={{
                          ...describeAdjustment(interval.signalAdjustmentCentsPerKwh),
                          meaning: undefined,
                        }}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default function PriceSignals() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  return (
    <TooltipProvider>
      <DashboardLayout>
        <div className="space-y-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Price signals</h1>
            <p className="text-muted-foreground max-w-3xl">
              Instead of pushing setpoints at your equipment, the platform publishes what each
              interval is worth and each site plans against its own load. Following a price is
              voluntary: the plan a site returns is its intent, and only the metered column is
              evidence of what happened.
            </p>
          </div>

          {isAdmin ? <OperatorView /> : <ParticipantView />}

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Why a price and not a command</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>
                A setpoint assumes the aggregator knows your constraints. A price does not, so
                comfort, occupancy and local limits stay yours to enforce.
              </p>
              <p>
                A price signal carries <strong>no validity window and no fallback</strong>,
                which is exactly why it can never be used for anything that must happen —
                those go out as bounded controls and appear under Control windows.
              </p>
            </CardContent>
          </Card>
        </div>
      </DashboardLayout>
    </TooltipProvider>
  );
}
