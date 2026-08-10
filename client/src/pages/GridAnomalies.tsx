import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { AlertTriangle, Radar } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

function severityBadge(sev: string) {
  if (sev === "critical") return <Badge variant="destructive">critical</Badge>;
  if (sev === "high") return <Badge variant="destructive" className="opacity-80">high</Badge>;
  if (sev === "medium") return <Badge variant="secondary">medium</Badge>;
  return <Badge variant="outline">{sev}</Badge>;
}

export default function GridAnomalies() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const utils = trpc.useUtils();

  const { data: assetsData } = trpc.assets.list.useQuery();
  const assets = useMemo(() => assetsData?.assets ?? [], [assetsData]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const assetId = selectedId ?? assets[0]?.id ?? null;

  const anomalies = trpc.gridAnomaly.getAssetAnomalies.useQuery(
    { assetId: assetId!, limit: 50 },
    { enabled: assetId !== null }
  );
  const fleet = trpc.gridAnomaly.getFleetAnomalySummary.useQuery(undefined, { enabled: isAdmin });

  const scanMutation = trpc.gridAnomaly.scanAsset.useMutation({
    onSuccess: (r) => {
      toast.success(
        r.eventsCreated > 0
          ? `Scan complete — ${r.eventsCreated} new anomaly event(s) created`
          : "Scan complete — no anomalies detected"
      );
      anomalies.refetch();
      if (isAdmin) fleet.refetch();
    },
    onError: (e) => toast.error(e.message || "Scan failed"),
  });

  const ackMutation = trpc.gridAnomaly.acknowledgeAnomaly.useMutation({
    onSuccess: () => {
      toast.success("Anomaly acknowledged");
      utils.gridAnomaly.getAssetAnomalies.invalidate();
      if (isAdmin) utils.gridAnomaly.getFleetAnomalySummary.invalidate();
    },
    onError: (e) => toast.error(e.message || "Failed to acknowledge anomaly"),
  });

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Grid Anomaly Early Warning</h1>
          <p className="text-muted-foreground">
            Statistical early-warning scoring against per-asset hour-of-day baselines from real telemetry.
          </p>
        </div>

        {isAdmin && (
          <div className="grid gap-4 md:grid-cols-4">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Open anomalies (fleet)</CardDescription>
                <CardTitle className="text-2xl">{fleet.data?.totalOpen ?? "—"}</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Assets with open critical</CardDescription>
                <CardTitle className="text-2xl">{fleet.data?.assetsWithOpenCritical ?? "—"}</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Events last 24h</CardDescription>
                <CardTitle className="text-2xl">{fleet.data?.eventsLast24h ?? "—"}</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>By severity</CardDescription>
                <div className="flex flex-wrap gap-1 pt-1">
                  {fleet.data
                    ? Object.entries(fleet.data.openBySeverity).map(([sev, count]) => (
                        <span key={sev} className="flex items-center gap-1 text-xs">
                          {severityBadge(sev)} <span className="text-muted-foreground">{count as number}</span>
                        </span>
                      ))
                    : <span className="text-muted-foreground text-sm">—</span>}
                </div>
              </CardHeader>
            </Card>
          </div>
        )}

        {isAdmin && fleet.data && fleet.data.topOffenders.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Top offenders</CardTitle>
              <CardDescription>Assets with the most open anomalies</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Asset ID</TableHead>
                    <TableHead>Open events</TableHead>
                    <TableHead>Worst severity</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {fleet.data.topOffenders.map((o) => (
                    <TableRow key={o.assetId}>
                      <TableCell>#{o.assetId}</TableCell>
                      <TableCell>{o.openEvents}</TableCell>
                      <TableCell>{severityBadge(o.worstSeverity)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <CardTitle className="text-base">Asset anomalies</CardTitle>
                <CardDescription>Persisted anomaly events for a selected asset</CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Select
                  value={assetId !== null ? String(assetId) : undefined}
                  onValueChange={(v) => setSelectedId(Number(v))}
                >
                  <SelectTrigger className="w-56">
                    <SelectValue placeholder="Select an asset" />
                  </SelectTrigger>
                  <SelectContent>
                    {assets.map((a: any) => (
                      <SelectItem key={a.id} value={String(a.id)}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  onClick={() => assetId !== null && scanMutation.mutate({ assetId, windowMinutes: 30 })}
                  disabled={assetId === null || scanMutation.isPending}
                >
                  <Radar className={`h-4 w-4 mr-2 ${scanMutation.isPending ? "animate-spin" : ""}`} />
                  {scanMutation.isPending ? "Scanning…" : "Scan now"}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {assetId === null ? (
              <p className="text-sm text-muted-foreground py-6">Select an asset to view its anomalies.</p>
            ) : anomalies.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : anomalies.error ? (
              <p className="text-sm text-muted-foreground py-6">{anomalies.error.message}</p>
            ) : !anomalies.data || anomalies.data.anomalies.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6">
                No anomaly events recorded for this asset.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Detected</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Severity</TableHead>
                    <TableHead>Confidence</TableHead>
                    <TableHead>Deviation</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {anomalies.data.anomalies.map((a: any) => (
                    <TableRow key={a.id}>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(a.detectedAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-sm">{String(a.anomalyType).replace(/_/g, " ")}</TableCell>
                      <TableCell>{severityBadge(a.severity)}</TableCell>
                      <TableCell>{a.confidenceScore != null ? `${a.confidenceScore}%` : "—"}</TableCell>
                      <TableCell>
                        {a.deviationPercent != null ? `${(a.deviationPercent / 100).toFixed(1)}%` : "—"}
                      </TableCell>
                      <TableCell className="text-sm">{String(a.recommendedAction ?? "monitor").replace(/_/g, " ")}</TableCell>
                      <TableCell>
                        <Badge variant={a.status === "open" ? "destructive" : "outline"}>
                          {String(a.status).replace(/_/g, " ")}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {a.status === "open" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => ackMutation.mutate({ anomalyId: a.id })}
                            disabled={ackMutation.isPending}
                          >
                            Acknowledge
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {anomalies.data && anomalies.data.anomalies.length > 0 && (
          <Card className="border-muted">
            <CardContent className="flex items-start gap-3 py-4 text-sm text-muted-foreground">
              <AlertTriangle className="h-4 w-4 mt-0.5" />
              <p>
                Scores with insufficient baseline history are not turned into events — the detector
                requires a minimum number of real readings before flagging anything.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
