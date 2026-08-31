import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { AlertCircle, Gauge } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

function kw10(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${(v / 10).toFixed(1)} kW`;
}

const UNAVAILABLE_REASONS: Record<string, string> = {
  no_threshold: "No contracted demand threshold configured. Set a threshold below and run a check.",
  no_telemetry: "No recent power telemetry for this asset — demand cannot be measured.",
};

export default function DemandGuardian() {
  const utils = trpc.useUtils();
  const { data: assetsData, isLoading: assetsLoading } = trpc.assets.list.useQuery();
  const assets = assetsData?.assets ?? [];
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const assetId = selectedId ?? assets[0]?.id ?? null;

  const [windowMinutes, setWindowMinutes] = useState<"15" | "30">("15");
  const [thresholdKw, setThresholdKw] = useState("");
  const [result, setResult] = useState<any>(null);

  const alerts = trpc.demandGuardian.listAlerts.useQuery(
    { assetId: assetId ?? undefined, limit: 20 },
    { enabled: !assetsLoading }
  );

  const checkMutation = trpc.demandGuardian.checkDemand.useMutation({
    onSuccess: (r) => {
      setResult(r);
      if (!r.available) {
        toast.info(UNAVAILABLE_REASONS[r.unavailableReason ?? ""] ?? "Check unavailable");
      } else if (r.exceedsThreshold) {
        toast.warning("Projected demand exceeds your contracted threshold");
      } else {
        toast.success("Projected demand is within your threshold");
      }
      utils.demandGuardian.listAlerts.invalidate();
    },
    onError: (e) => toast.error(e.message || "Demand check failed"),
  });

  const handleCheck = () => {
    if (assetId === null) return toast.error("Select an asset");
    const payload: any = { assetId, windowMinutes: Number(windowMinutes) as 15 | 30 };
    if (thresholdKw.trim() !== "") {
      const kw = parseFloat(thresholdKw);
      if (!Number.isFinite(kw) || kw <= 0) return toast.error("Threshold must be a positive number of kW");
      payload.thresholdKw10 = Math.round(kw * 10);
    }
    checkMutation.mutate(payload);
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Demand Guardian</h1>
          <p className="text-muted-foreground">
            Rolling 15/30-minute demand from real telemetry vs your contracted threshold. The
            projection is a labelled linear extrapolation of observed window averages — not a
            probability.
          </p>
        </div>

        {assetsLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : assets.length === 0 ? (
          <Card>
            <CardContent className="flex items-center gap-3 py-10 text-muted-foreground">
              <Gauge className="h-5 w-5" />
              <p>You have no assets. Register an asset to watch its demand.</p>
            </CardContent>
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Run a demand check</CardTitle>
                <CardDescription>
                  The threshold is saved on the first check; leave it blank later to reuse the last
                  contracted value.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-4">
                <div className="space-y-2">
                  <Label>Asset</Label>
                  <Select
                    value={assetId !== null ? String(assetId) : undefined}
                    onValueChange={(v) => { setSelectedId(Number(v)); setResult(null); }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select asset" />
                    </SelectTrigger>
                    <SelectContent>
                      {assets.map((a: any) => (
                        <SelectItem key={a.id} value={String(a.id)}>
                          {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Window</Label>
                  <Select value={windowMinutes} onValueChange={(v) => setWindowMinutes(v as "15" | "30")}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="15">15 minutes</SelectItem>
                      <SelectItem value="30">30 minutes</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Contracted threshold (kW)</Label>
                  <Input
                    type="number"
                    min={0}
                    step="0.1"
                    placeholder="e.g. 50"
                    value={thresholdKw}
                    onChange={(e) => setThresholdKw(e.target.value)}
                  />
                </div>
                <div className="flex items-end">
                  <Button onClick={handleCheck} disabled={checkMutation.isPending || assetId === null}>
                    {checkMutation.isPending ? "Checking…" : "Check demand"}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {result && !result.available && (
              <Card className="border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900">
                <CardContent className="flex items-start gap-3 py-4 text-sm">
                  <AlertCircle className="h-4 w-4 mt-0.5 text-amber-600" />
                  <p>{UNAVAILABLE_REASONS[result.unavailableReason ?? ""] ?? result.unavailableReason ?? "Unavailable"}</p>
                </CardContent>
              </Card>
            )}

            {result && result.available && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    Check result
                    {result.exceedsThreshold ? (
                      <Badge variant="destructive">exceeds threshold</Badge>
                    ) : (
                      <Badge variant="outline">within threshold</Badge>
                    )}
                  </CardTitle>
                  <CardDescription>
                    {result.windowMinutes}-minute window · computed{" "}
                    {new Date(result.computedAt).toLocaleString()} · method{" "}
                    <code className="text-xs">{result.projectionMethod}</code>
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4 md:grid-cols-4 text-sm">
                  <div>
                    <p className="text-muted-foreground">Observed window avg</p>
                    <p className="text-xl font-semibold">{kw10(result.observedWindowAvgKw10)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Projected next window</p>
                    <p className="text-xl font-semibold">{kw10(result.projectedPeakKw10)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Threshold</p>
                    <p className="text-xl font-semibold">{kw10(result.thresholdKw10)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Window</p>
                    <p className="text-sm">
                      {result.windowStart ? new Date(result.windowStart).toLocaleTimeString() : "—"} –{" "}
                      {result.windowEnd ? new Date(result.windowEnd).toLocaleTimeString() : "—"} ·{" "}
                      {result.sampleCount} samples
                    </p>
                    {result.projectedPeakKw10 == null && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Fewer than two windows of data — no projection possible.
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Alerts</CardTitle>
                <CardDescription>
                  Rows are written only when the projected peak exceeded the threshold
                  {assetId !== null ? " (selected asset)" : ""}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {alerts.isLoading ? (
                  <Skeleton className="h-24 w-full" />
                ) : alerts.error ? (
                  <p className="text-sm text-muted-foreground">{alerts.error.message}</p>
                ) : !alerts.data || alerts.data.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No demand alerts recorded.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Time</TableHead>
                        <TableHead>Window</TableHead>
                        <TableHead>Observed</TableHead>
                        <TableHead>Projected peak</TableHead>
                        <TableHead>Threshold</TableHead>
                        <TableHead>Excess</TableHead>
                        <TableHead>Method</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {alerts.data.map((a: any) => (
                        <TableRow key={a.id}>
                          <TableCell>{new Date(a.createdAt).toLocaleString()}</TableCell>
                          <TableCell>{a.windowMinutes} min</TableCell>
                          <TableCell>{kw10(a.observedWindowAvgKw10)}</TableCell>
                          <TableCell className="font-medium">{kw10(a.projectedPeakKw10)}</TableCell>
                          <TableCell>{kw10(a.thresholdKw10)}</TableCell>
                          <TableCell>{kw10(a.projectedExcessKw10)}</TableCell>
                          <TableCell>
                            <code className="text-xs">{a.projectionMethod}</code>
                          </TableCell>
                          <TableCell>
                            <Badge variant={a.status === "alert" ? "destructive" : "outline"}>{a.status}</Badge>
                          </TableCell>
                        </TableRow>
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
  );
}
