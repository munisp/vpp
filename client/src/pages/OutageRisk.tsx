import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { AlertCircle, CloudLightning, RefreshCw } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

function scoreColor(score: number | null): string {
  if (score === null) return "text-muted-foreground";
  if (score >= 60) return "text-red-600";
  if (score >= 30) return "text-amber-600";
  return "text-green-600";
}
function componentLabel(v: number | null): string {
  return v === null ? "—" : v.toFixed(1);
}

export default function OutageRisk() {
  const utils = trpc.useUtils();
  const { data: assetsData, isLoading: assetsLoading } = trpc.assets.list.useQuery();
  const assets = assetsData?.assets ?? [];
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const assetId = selectedId ?? assets[0]?.id ?? null;
  const [result, setResult] = useState<any>(null);

  const history = trpc.outageRisk.getRiskHistory.useQuery(
    { assetId: assetId!, limit: 10 },
    { enabled: assetId !== null }
  );

  const computeMutation = trpc.outageRisk.computeRisk.useMutation({
    onSuccess: (r) => {
      setResult(r);
      if (r.insufficientData) toast.info("Insufficient data to score outage risk");
      else toast.success(`Outage risk score: ${r.score?.toFixed(1) ?? "—"}/100`);
      utils.outageRisk.getRiskHistory.invalidate();
    },
    onError: (e) => toast.error(e.message || "Risk computation failed"),
  });

  // Latest history row is the current standing score when no fresh run is shown.
  const latest = result ?? history.data?.[0] ?? null;
  const latestScore = result
    ? result.score
    : latest && latest.scoreMilli != null
      ? latest.scoreMilli / 1000
      : null;
  const latestInsufficient = result ? result.insufficientData : latest?.insufficientData === true;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Outage Risk</h1>
            <p className="text-muted-foreground">
              Near-term outage risk scored from the asset's real anomaly history, telemetry gaps and
              grid-quality samples. No telemetry means no score — never a guess.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={assetId !== null ? String(assetId) : undefined}
              onValueChange={(v) => { setSelectedId(Number(v)); setResult(null); }}
            >
              <SelectTrigger className="w-64">
                <SelectValue placeholder={assetsLoading ? "Loading…" : "Select an asset"} />
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
              onClick={() => assetId !== null && computeMutation.mutate({ assetId })}
              disabled={assetId === null || computeMutation.isPending}
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${computeMutation.isPending ? "animate-spin" : ""}`} />
              {computeMutation.isPending ? "Computing…" : "Compute risk"}
            </Button>
          </div>
        </div>

        {assetsLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : assets.length === 0 ? (
          <Card>
            <CardContent className="flex items-center gap-3 py-10 text-muted-foreground">
              <CloudLightning className="h-5 w-5" />
              <p>You have no assets. Register an asset to see outage risk.</p>
            </CardContent>
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Current score</CardTitle>
                <CardDescription>
                  {result
                    ? `Computed ${new Date(result.computedAt).toLocaleString()}`
                    : latest
                      ? `Last computed ${new Date(latest.computedAt).toLocaleString()}`
                      : "No computation yet — press Compute risk"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {history.isLoading && !result ? (
                  <Skeleton className="h-24 w-full" />
                ) : latestInsufficient ? (
                  <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900 p-4 text-sm">
                    <AlertCircle className="h-4 w-4 mt-0.5 text-amber-600" />
                    <div>
                      <p className="font-medium text-amber-700 dark:text-amber-400">Insufficient data</p>
                      <p className="text-muted-foreground">
                        {(result?.reason ?? latest?.reason) || "Not enough data to compute a score."}
                      </p>
                    </div>
                  </div>
                ) : latestScore !== null ? (
                  <div className="flex items-center gap-6 flex-wrap">
                    <div className="text-center">
                      <p className={`text-5xl font-bold ${scoreColor(latestScore)}`}>
                        {latestScore.toFixed(1)}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">out of 100</p>
                    </div>
                    <div className="flex-1 min-w-48">
                      <div className="h-3 rounded-full bg-muted overflow-hidden">
                        <div
                          className={`h-full rounded-full ${latestScore >= 60 ? "bg-red-500" : latestScore >= 30 ? "bg-amber-500" : "bg-green-500"}`}
                          style={{ width: `${Math.min(100, latestScore)}%` }}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground mt-2">
                        Method: {result?.method ?? "equal_weight_mean(anomaly, gap, quality)"}
                      </p>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No score available.</p>
                )}
              </CardContent>
            </Card>

            {result && !result.insufficientData && (
              <div className="grid gap-4 md:grid-cols-3">
                {(
                  [
                    ["Anomaly history", result.components.anomaly],
                    ["Telemetry gaps", result.components.telemetryGap],
                    ["Grid quality", result.components.gridQuality],
                  ] as Array<[string, number | null]>
                ).map(([label, v]) => (
                  <Card key={label}>
                    <CardHeader className="pb-2">
                      <CardDescription>{label}</CardDescription>
                      <CardTitle className={`text-2xl ${scoreColor(v)}`}>
                        {v === null ? "—" : `${v.toFixed(1)} / 100`}
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      {v === null ? (
                        <p className="text-xs text-muted-foreground">No data for this signal — excluded from the mean.</p>
                      ) : (
                        <div className="h-2 rounded-full bg-muted overflow-hidden">
                          <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, v)}%` }} />
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            {result && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Evidence</CardTitle>
                  <CardDescription>
                    {result.windowStart && result.windowEnd
                      ? `${new Date(result.windowStart).toLocaleDateString()} – ${new Date(result.windowEnd).toLocaleDateString()} (${result.spanDays ?? "—"} days, ${result.telemetrySampleCount} samples)`
                      : "No telemetry window"}
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-2 md:grid-cols-3 text-sm">
                  <p>Anomaly scores: {result.evidence.anomalyScoreCount} ({result.evidence.severeAnomalyCount} severe)</p>
                  <p>
                    Gap ratio:{" "}
                    {result.evidence.gapRatioMilli != null
                      ? `${(result.evidence.gapRatioMilli / 10).toFixed(1)}% of window`
                      : "—"}
                  </p>
                  <p>
                    Voltage violations:{" "}
                    {result.evidence.voltageViolationCount != null
                      ? `${result.evidence.voltageViolationCount} / ${result.evidence.voltageSampleCount}`
                      : "—"}
                  </p>
                  <p>
                    Frequency violations:{" "}
                    {result.evidence.frequencyViolationCount != null
                      ? `${result.evidence.frequencyViolationCount} / ${result.evidence.frequencySampleCount}`
                      : "—"}
                  </p>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-base">History</CardTitle>
                <CardDescription>Persisted risk computations for this asset</CardDescription>
              </CardHeader>
              <CardContent>
                {history.isLoading ? (
                  <Skeleton className="h-24 w-full" />
                ) : !history.data || history.data.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No risk scores recorded yet.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Computed</TableHead>
                        <TableHead>Score</TableHead>
                        <TableHead>Anomaly</TableHead>
                        <TableHead>Gap</TableHead>
                        <TableHead>Quality</TableHead>
                        <TableHead>State</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {history.data.map((s: any) => (
                        <TableRow key={s.id}>
                          <TableCell>{new Date(s.computedAt).toLocaleString()}</TableCell>
                          <TableCell>
                            {s.scoreMilli != null ? (
                              <span className={scoreColor(s.scoreMilli / 1000)}>
                                {(s.scoreMilli / 1000).toFixed(1)}
                              </span>
                            ) : (
                              "—"
                            )}
                          </TableCell>
                          <TableCell>{componentLabel(s.anomalyComponentMilli != null ? s.anomalyComponentMilli / 1000 : null)}</TableCell>
                          <TableCell>{componentLabel(s.telemetryGapComponentMilli != null ? s.telemetryGapComponentMilli / 1000 : null)}</TableCell>
                          <TableCell>{componentLabel(s.gridQualityComponentMilli != null ? s.gridQualityComponentMilli / 1000 : null)}</TableCell>
                          <TableCell>
                            {s.insufficientData ? (
                              <Badge variant="secondary" title={s.reason ?? ""}>
                                insufficient data
                              </Badge>
                            ) : (
                              <Badge variant="outline">scored</Badge>
                            )}
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
