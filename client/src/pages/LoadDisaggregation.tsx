import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { AlertCircle, PieChart as PieChartIcon, RefreshCw } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

function fmtWh(wh: number | null | undefined): string {
  if (wh === null || wh === undefined) return "—";
  return wh >= 1000 ? `${(wh / 1000).toFixed(2)} kWh` : `${Math.round(wh)} Wh`;
}

const CLASS_LABELS: Record<string, string> = {
  always_on_base: "Always-on base load",
  evening_peak_block: "Evening peak block",
  daytime_variable_above_base: "Daytime variable",
};

export default function LoadDisaggregation() {
  const utils = trpc.useUtils();
  const { data: assetsData, isLoading: assetsLoading } = trpc.assets.list.useQuery();
  const assets = assetsData?.assets ?? [];
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const assetId = selectedId ?? assets[0]?.id ?? null;
  const [result, setResult] = useState<any>(null);

  const history = trpc.loadDisaggregation.listEstimates.useQuery(
    { assetId: assetId!, limit: 30 },
    { enabled: assetId !== null }
  );

  const computeMutation = trpc.loadDisaggregation.computeEstimates.useMutation({
    onSuccess: (r) => {
      setResult(r);
      if (r.insufficientData) toast.info("Insufficient data for disaggregation");
      else toast.success("Appliance estimates computed");
      utils.loadDisaggregation.listEstimates.invalidate();
    },
    onError: (e) => toast.error(e.message || "Disaggregation failed"),
  });

  const chartData = result && !result.insufficientData
    ? result.estimates.map((e: any) => ({
        name: CLASS_LABELS[e.applianceClass] ?? e.applianceClass,
        estimatedWh: e.estimatedWh,
      }))
    : [];

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Load Disaggregation</h1>
            <p className="text-muted-foreground">
              Appliance-class shares estimated from the shape of real interval power telemetry.
              Every figure is an estimate with a labelled method and confidence — not sub-metering.
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
              {computeMutation.isPending ? "Computing…" : "Compute estimates"}
            </Button>
          </div>
        </div>

        {assetsLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : assets.length === 0 ? (
          <Card>
            <CardContent className="flex items-center gap-3 py-10 text-muted-foreground">
              <PieChartIcon className="h-5 w-5" />
              <p>You have no assets. Register an asset to estimate its load breakdown.</p>
            </CardContent>
          </Card>
        ) : (
          <>
            {result && result.insufficientData && (
              <Card className="border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900">
                <CardContent className="flex items-start gap-3 py-4 text-sm">
                  <AlertCircle className="h-4 w-4 mt-0.5 text-amber-600" />
                  <div>
                    <p className="font-medium text-amber-700 dark:text-amber-400">Insufficient data</p>
                    <p className="text-muted-foreground">{result.reason}</p>
                  </div>
                </CardContent>
              </Card>
            )}

            {result && !result.insufficientData && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Estimated appliance shares</CardTitle>
                  <CardDescription>
                    Window {result.windowStart ? new Date(result.windowStart).toLocaleDateString() : "—"} –{" "}
                    {result.windowEnd ? new Date(result.windowEnd).toLocaleDateString() : "—"} ·{" "}
                    {result.spanDays ?? "—"} days · total measured {fmtWh(result.totalMeasuredWh)} · method{" "}
                    <code className="text-xs">{result.estimates[0]?.method ?? "—"}</code>
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: any) => `${(v / 1000).toFixed(1)} kWh`} />
                      <Tooltip formatter={(v: any) => [fmtWh(Number(v)), "Estimated energy"]} />
                      <Bar dataKey="estimatedWh" fill="#6b9e78" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Appliance class</TableHead>
                        <TableHead>Estimated energy</TableHead>
                        <TableHead>Share</TableHead>
                        <TableHead>Confidence</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.estimates.map((e: any) => (
                        <TableRow key={e.applianceClass}>
                          <TableCell>{CLASS_LABELS[e.applianceClass] ?? e.applianceClass}</TableCell>
                          <TableCell>
                            {fmtWh(e.estimatedWh)}{" "}
                            <Badge variant="outline" className="ml-1">estimate</Badge>
                          </TableCell>
                          <TableCell>{(e.shareMilliPct / 1000).toFixed(1)}%</TableCell>
                          <TableCell>{(e.confidenceMilli / 10).toFixed(0)}% confidence</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}

            {!result && (
              <Card>
                <CardContent className="py-10 text-sm text-muted-foreground">
                  Press "Compute estimates" to run disaggregation on this asset's telemetry. Assets with
                  fewer than 14 days of interval history are refused rather than guessed.
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Estimate history</CardTitle>
                <CardDescription>Persisted per-class estimates (most recent first)</CardDescription>
              </CardHeader>
              <CardContent>
                {history.isLoading ? (
                  <Skeleton className="h-24 w-full" />
                ) : !history.data || history.data.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No estimates recorded yet.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Computed</TableHead>
                        <TableHead>Class</TableHead>
                        <TableHead>Energy</TableHead>
                        <TableHead>Share</TableHead>
                        <TableHead>Confidence</TableHead>
                        <TableHead>Method</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {history.data.map((e: any) => (
                        <TableRow key={e.id}>
                          <TableCell>{new Date(e.createdAt).toLocaleString()}</TableCell>
                          <TableCell>{CLASS_LABELS[e.applianceClass] ?? e.applianceClass}</TableCell>
                          <TableCell>{fmtWh(e.estimatedWh)}</TableCell>
                          <TableCell>{(e.shareMilliPct / 1000).toFixed(1)}%</TableCell>
                          <TableCell>{(e.confidenceMilli / 10).toFixed(0)}%</TableCell>
                          <TableCell>
                            <code className="text-xs">{e.method}</code>
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
