/**
 * "How often does the power actually go off for our customers, and for how
 * long?" — answered from recorded interruptions at registered connections.
 *
 * The platform previously had no answer at all: the compliance report presented
 * `health_checks` uptime as `availability_percent`, which is the API's health
 * where a regulator reads the customer's power. This page reports IEEE 1366
 * indices over the customers they were measured for, says who is unmonitored,
 * and marks a figure as a lower bound whenever an interruption is still running.
 */

import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { AlertTriangle, Activity, PlugZap, RefreshCw, Search, ShieldCheck } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { MetricTile, PageHeader, PanelCard, ToneBadge } from "@/components/ops";
import {
  DETECTION_SOURCE_COPY,
  INDEX_MEANING,
  INTERRUPTION_CAUSE_LABEL,
  MONITORING_COPY,
  coverageSummary,
  indexValue,
  percentValue,
  reliabilityBasisCopy,
  reliabilityReasonCopy,
} from "../../../shared/reliability-copy";

const DEFAULT_DAYS = 30;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function ServiceReliability() {
  const utils = trpc.useUtils();
  const [start, setStart] = useState(isoDaysAgo(DEFAULT_DAYS));
  const [end, setEnd] = useState(todayIso());
  const [cause, setCause] = useState<string>("utility_grid_outage");
  const [detectionSource, setDetectionSource] = useState<string>("operator_declared");
  const [servicePointId, setServicePointId] = useState<string>("");
  const [startedAt, setStartedAt] = useState<string>("");
  const [evidenceRef, setEvidenceRef] = useState<string>("");

  const period = useMemo(
    () => ({ start: new Date(`${start}T00:00:00Z`), end: new Date(`${end}T23:59:59Z`) }),
    [start, end]
  );

  const report = trpc.reliability.report.useQuery(period, { retry: false });
  const points = trpc.reliability.servicePoints.useQuery(undefined, { retry: false });
  const interruptions = trpc.reliability.interruptions.useQuery({ limit: 50 }, { retry: false });

  const record = trpc.reliability.recordInterruption.useMutation({
    onSuccess: () => {
      toast.success("Interruption recorded");
      setEvidenceRef("");
      void utils.reliability.report.invalidate();
      void utils.reliability.interruptions.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const invalidateRegister = () => {
    void utils.reliability.report.invalidate();
    void utils.reliability.servicePoints.invalidate();
  };

  const setMonitoring = trpc.reliability.setServicePointMonitoring.useMutation({
    onSuccess: () => {
      toast.success("Monitoring updated — the observed population changed with it");
      invalidateRegister();
    },
    onError: (e) => toast.error(e.message),
  });

  const disconnect = trpc.reliability.disconnectServicePoint.useMutation({
    onSuccess: () => {
      toast.success("Disconnection recorded — exposure stops at this instant");
      invalidateRegister();
    },
    onError: (e) => toast.error(e.message),
  });

  const reconnect = trpc.reliability.reconnectServicePoint.useMutation({
    onSuccess: () => {
      toast.success("Connection is counted as supplied again");
      invalidateRegister();
    },
    onError: (e) => toast.error(e.message),
  });

  const detect = trpc.reliability.detectGaps.useMutation({
    onSuccess: (result) => {
      toast.success(
        `${result.opened.length} opened, ${result.closed.length} closed, ${result.skipped.length} connection(s) skipped`
      );
      void utils.reliability.report.invalidate();
      void utils.reliability.interruptions.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const data = report.data;
  const basis = reliabilityBasisCopy(data?.basis ?? null);
  const reason = reliabilityReasonCopy(data?.reason ?? null);
  const refreshing = report.isFetching || points.isFetching || interruptions.isFetching;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <PageHeader
          title="Customer supply reliability"
          description="IEEE 1366 indices — SAIFI, SAIDI, CAIDI, ASAI, MAIFI — computed from interruptions recorded against registered customer connections."
          caveat="This is customer power, not platform uptime. An index is reported only over the connections somebody actually monitors; unmonitored connections are reported as coverage, never as customers with uninterrupted supply."
          actions={
            <div className="flex items-end gap-2">
              <div>
                <Label htmlFor="rel-start" className="text-xs">From</Label>
                <Input id="rel-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} className="w-40" />
              </div>
              <div>
                <Label htmlFor="rel-end" className="text-xs">To</Label>
                <Input id="rel-end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="w-40" />
              </div>
              <Button variant="outline" size="sm" disabled={refreshing} onClick={() => void report.refetch()}>
                <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
                Refresh
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={detect.isPending}
                onClick={() => detect.mutate({})}
              >
                <Search className="mr-2 h-4 w-4" />
                Sweep meters
              </Button>
            </div>
          }
          className="mb-0"
        />

        {report.isError && (
          <Card className="border-red-300">
            <CardContent className="py-4 text-sm">
              <p className="flex items-center gap-2 font-medium">
                <AlertTriangle className="h-4 w-4 text-red-600" />
                Reliability could not be read
              </p>
              <p className="text-muted-foreground mt-1">
                {report.error.message} — supply reliability for this period is unknown. This is not
                an all-clear.
              </p>
            </CardContent>
          </Card>
        )}

        {reason && (
          <Card className="border-amber-300">
            <CardContent className="py-4 text-sm">
              <p className="flex items-center gap-2 font-medium">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                No index is reported: {reason.label}
              </p>
              <p className="text-muted-foreground mt-1">{reason.meaning}</p>
            </CardContent>
          </Card>
        )}

        {report.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <MetricTile
              label="SAIFI"
              value={indexValue(data?.indices.saifi ?? null, 3)}
              unit="interruptions / customer"
              tone={basis.tone}
              status={{ label: basis.label, tone: basis.tone, meaning: basis.meaning }}
              evidence={<span className="text-muted-foreground">{INDEX_MEANING.saifi}</span>}
            />
            <MetricTile
              label="SAIDI"
              value={indexValue(data?.indices.saidiMinutes ?? null, 1)}
              unit="minutes / customer"
              tone={basis.tone}
              status={{ label: basis.label, tone: basis.tone, meaning: basis.meaning }}
              evidence={<span className="text-muted-foreground">{INDEX_MEANING.saidi}</span>}
            />
            <MetricTile
              label="CAIDI"
              value={indexValue(data?.indices.caidiMinutes ?? null, 1)}
              unit="minutes / interruption"
              tone={data?.indices.caidiMinutes === null ? "neutral" : basis.tone}
              evidence={
                <span className="text-muted-foreground">
                  {data?.indices.caidiMinutes === null && data?.reason === null
                    ? "No sustained interruption was recorded, so there is no average length to report."
                    : INDEX_MEANING.caidi}
                </span>
              }
            />
            <MetricTile
              label="ASAI"
              value={percentValue(data?.indices.asai ?? null)}
              unit="% of customer-minutes supplied"
              tone={basis.tone}
              evidence={<span className="text-muted-foreground">{INDEX_MEANING.asai}</span>}
            />
            <MetricTile
              label="MAIFI"
              value={indexValue(data?.indices.maifi ?? null, 3)}
              unit="momentary / customer"
              tone={basis.tone}
              evidence={<span className="text-muted-foreground">{INDEX_MEANING.maifi}</span>}
            />
            <MetricTile
              label="Customers interrupted"
              value={percentValue(data?.indices.customersInterruptedFraction ?? null, 1)}
              unit="% of observed customers"
              tone={basis.tone}
              evidence={
                <span className="text-muted-foreground">
                  {data ? coverageSummary(data.coverage) : INDEX_MEANING.interrupted}
                </span>
              }
            />
          </div>
        )}

        <PanelCard
          title="Coverage behind these figures"
          description="Who the indices were computed over, and what was left out."
        >
          {report.isLoading || !data ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <div className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-muted-foreground">Registered connections</p>
                <p className="text-lg font-semibold">{data.coverage.registeredServicePoints}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Observed</p>
                <p className="text-lg font-semibold">{data.coverage.observedServicePoints}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Unmonitored (excluded)</p>
                <p className="text-lg font-semibold">{data.coverage.unobservedServicePoints}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Customer-minutes of exposure</p>
                <p className="text-lg font-semibold">
                  {data.coverage.observedCustomerMinutes.toLocaleString()}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Interruptions still open</p>
                <p className="text-lg font-semibold">{data.coverage.openInterruptions}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Excluded (exceptional days)</p>
                <p className="text-lg font-semibold">
                  {data.coverage.excludedInterruptions} ·{" "}
                  {data.coverage.excludedInterruptionMinutes} min
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Sustained / momentary</p>
                <p className="text-lg font-semibold">
                  {data.counts.sustainedInterruptions} / {data.counts.momentaryInterruptions}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Basis</p>
                <ToneBadge tone={basis.tone} label={basis.label} />
              </div>
            </div>
          )}
        </PanelCard>

        <PanelCard
          title="What these figures do not cover"
          description="Every limitation the computation itself declared."
        >
          {report.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : (data?.limitations.length ?? 0) === 0 ? (
            <p className="flex items-center gap-2 text-sm">
              <ShieldCheck className="h-4 w-4 text-emerald-600" />
              Every observed connection was supplied for the whole period and every counted
              interruption is closed with restoration evidence.
            </p>
          ) : (
            <ul className="space-y-2 text-sm">
              {(data?.limitations ?? []).map((limitation) => (
                <li key={limitation} className="flex gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                  <span>{limitation}</span>
                </li>
              ))}
            </ul>
          )}
        </PanelCard>

        <div className="grid gap-6 lg:grid-cols-2">
          <PanelCard
            title="Where the outage minutes came from"
            description="Cause and detection source reported separately: what went wrong, and how the platform knows."
          >
            {report.isLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : (data?.byCause.length ?? 0) === 0 ? (
              <p className="text-muted-foreground text-sm">
                No interruption is recorded in this period for the observed connections.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Cause</TableHead>
                    <TableHead className="text-right">Interruptions</TableHead>
                    <TableHead className="text-right">Minutes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(data?.byCause ?? []).map((row) => (
                    <TableRow key={row.cause}>
                      <TableCell>{INTERRUPTION_CAUSE_LABEL[row.cause] ?? row.cause}</TableCell>
                      <TableCell className="text-right">{row.interruptions}</TableCell>
                      <TableCell className="text-right">{row.minutes}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {(data?.byDetectionSource.length ?? 0) > 0 && (
              <div className="mt-4 flex flex-wrap gap-2">
                {(data?.byDetectionSource ?? []).map((row) => {
                  const copy = DETECTION_SOURCE_COPY[row.detectionSource];
                  return (
                    <ToneBadge
                      key={row.detectionSource}
                      tone={copy?.tone ?? "neutral"}
                      label={`${copy?.label ?? row.detectionSource} · ${row.interruptions}`}
                    />
                  );
                })}
              </div>
            )}
          </PanelCard>

          <PanelCard
            title="Record an interruption"
            description="Every row needs a reference to the evidence behind it, and closing one needs evidence that supply returned."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="rel-point">Connection</Label>
                <Select value={servicePointId} onValueChange={setServicePointId}>
                  <SelectTrigger id="rel-point">
                    <SelectValue placeholder="Select a connection" />
                  </SelectTrigger>
                  <SelectContent>
                    {(points.data ?? []).map((point) => (
                      <SelectItem key={point.id} value={String(point.id)}>
                        {point.code} · {MONITORING_COPY[point.monitoring]?.label ?? point.monitoring}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="rel-started">Lost supply at</Label>
                <Input
                  id="rel-started"
                  type="datetime-local"
                  value={startedAt}
                  onChange={(e) => setStartedAt(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="rel-cause">Cause</Label>
                <Select value={cause} onValueChange={setCause}>
                  <SelectTrigger id="rel-cause">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(INTERRUPTION_CAUSE_LABEL).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="rel-source">How it was detected</Label>
                <Select value={detectionSource} onValueChange={setDetectionSource}>
                  <SelectTrigger id="rel-source">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(DETECTION_SOURCE_COPY).map(([value, copy]) => (
                      <SelectItem key={value} value={value}>
                        {copy.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="rel-evidence">Evidence reference</Label>
                <Input
                  id="rel-evidence"
                  placeholder="meter_event:1234 · ticket:OPS-88 · call log reference"
                  value={evidenceRef}
                  onChange={(e) => setEvidenceRef(e.target.value)}
                />
              </div>
            </div>
            <Button
              className="mt-4"
              disabled={
                record.isPending || servicePointId === "" || startedAt === "" || evidenceRef.trim() === ""
              }
              onClick={() =>
                record.mutate({
                  servicePointId: Number(servicePointId),
                  startedAt: new Date(startedAt),
                  cause: cause as "unknown",
                  detectionSource: detectionSource as "operator_declared",
                  evidenceRef: evidenceRef.trim(),
                })
              }
            >
              <PlugZap className="mr-2 h-4 w-4" />
              Record interruption
            </Button>
            <p className="text-muted-foreground mt-3 text-xs">
              Recorded open. It stays open — and every index computed over it stays a lower bound —
              until a restoration with its own evidence closes it.
            </p>
          </PanelCard>
        </div>

        <PanelCard
          title="Connection register"
          description="The population an index is averaged over, and how each connection's supply is watched."
        >
          {points.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (points.data ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No customer connection is registered. Until one is, no reliability index can be
              reported — and none is.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Class</TableHead>
                  <TableHead>Monitoring</TableHead>
                  <TableHead>Connected</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Lifecycle</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(points.data ?? []).map((point) => {
                  const copy = MONITORING_COPY[point.monitoring];
                  return (
                    <TableRow key={point.id}>
                      <TableCell className="font-medium">{point.code}</TableCell>
                      <TableCell>{point.pointClass.replace("_", " ")}</TableCell>
                      <TableCell>
                        <ToneBadge
                          tone={copy?.tone ?? "neutral"}
                          label={copy?.label ?? point.monitoring}
                        />
                      </TableCell>
                      <TableCell>{new Date(point.connectedAt).toLocaleDateString()}</TableCell>
                      <TableCell>
                        {point.disconnectedAt ? (
                          <ToneBadge
                            tone="neutral"
                            label={`Disconnected ${new Date(point.disconnectedAt).toLocaleDateString()}`}
                          />
                        ) : (
                          <ToneBadge tone="live" label="Connected" />
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          {point.monitoring === "unmonitored" ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={setMonitoring.isPending}
                              onClick={() =>
                                setMonitoring.mutate({ id: point.id, monitoring: "reported_only" })
                              }
                            >
                              Mark reported
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={setMonitoring.isPending}
                              onClick={() =>
                                setMonitoring.mutate({ id: point.id, monitoring: "unmonitored" })
                              }
                            >
                              Mark unmonitored
                            </Button>
                          )}
                          {point.disconnectedAt ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={reconnect.isPending}
                              onClick={() => reconnect.mutate({ id: point.id })}
                            >
                              Reconnect
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={disconnect.isPending}
                              onClick={() =>
                                disconnect.mutate({ id: point.id, disconnectedAt: new Date() })
                              }
                            >
                              Disconnect
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </PanelCard>

        <PanelCard
          title="Recorded interruptions"
          description="The rows the indices are computed from, newest first."
          footer="An open row is counted only up to now, so its contribution can only grow. Rows marked exceptional are shown here but excluded from the indices above."
        >
          {interruptions.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (interruptions.data ?? []).length === 0 ? (
            <p className="flex items-center gap-2 text-sm">
              <Activity className="h-4 w-4" />
              No interruption has been recorded.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Connection</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Ended</TableHead>
                  <TableHead>Cause</TableHead>
                  <TableHead>Detected by</TableHead>
                  <TableHead>Evidence</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(interruptions.data ?? []).map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>#{row.servicePointId}</TableCell>
                    <TableCell>{new Date(row.startedAt).toLocaleString()}</TableCell>
                    <TableCell>
                      {row.endedAt ? (
                        new Date(row.endedAt).toLocaleString()
                      ) : (
                        <ToneBadge tone="danger" label="still out" />
                      )}
                    </TableCell>
                    <TableCell>
                      {INTERRUPTION_CAUSE_LABEL[row.cause] ?? row.cause}
                      {row.excludeFromIndices && (
                        <span className="text-muted-foreground ml-2 text-xs">
                          excluded: {row.exclusionReason}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {DETECTION_SOURCE_COPY[row.detectionSource]?.label ?? row.detectionSource}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {row.evidenceRef}
                      {row.restoredEvidenceRef ? ` → ${row.restoredEvidenceRef}` : ""}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </PanelCard>
      </div>
    </DashboardLayout>
  );
}
