import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, Sun, TrendingDown } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";

function fmtWh(wh: number | null | undefined): string {
  if (wh === null || wh === undefined) return "—";
  return wh >= 1000 ? `${(wh / 1000).toFixed(2)} kWh` : `${Math.round(wh)} Wh`;
}

export default function SolarYield() {
  const { data: assetsData, isLoading: assetsLoading } = trpc.assets.list.useQuery();
  const solarAssets = useMemo(
    () => (assetsData?.assets ?? []).filter((a: any) => a.assetType === "solar"),
    [assetsData]
  );
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const assetId = selectedId ?? solarAssets[0]?.id ?? null;

  const yieldForecast = trpc.solarYield.getYieldForecast.useQuery(
    { assetId: assetId! },
    { enabled: assetId !== null, retry: false }
  );
  const perf = trpc.solarYield.getPerformanceRatio.useQuery(
    { assetId: assetId! },
    { enabled: assetId !== null, retry: false }
  );
  const underperforming = trpc.solarYield.getUnderperformingAssets.useQuery();

  const yf = yieldForecast.data;
  const pr = perf.data;

  const prChart = (pr?.daily ?? []).map((d: any) => ({
    date: d.date.slice(5),
    actual: d.actualWh / 1000,
    clearSky: d.clearSkyWh / 1000,
    pr: d.performanceRatio,
  }));

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Solar Yield</h1>
            <p className="text-muted-foreground">
              Weather-aware yield forecasts and learned performance ratios from your real generation data.
            </p>
          </div>
          <Select
            value={assetId !== null ? String(assetId) : undefined}
            onValueChange={(v) => setSelectedId(Number(v))}
          >
            <SelectTrigger className="w-64">
              <SelectValue placeholder={assetsLoading ? "Loading…" : "Select a solar asset"} />
            </SelectTrigger>
            <SelectContent>
              {solarAssets.map((a: any) => (
                <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {assetsLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : solarAssets.length === 0 ? (
          <Card>
            <CardContent className="flex items-center gap-3 py-10 text-muted-foreground">
              <Sun className="h-5 w-5" />
              <p>You have no solar assets. Register a solar asset to see yield analytics.</p>
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">3-day yield forecast</CardTitle>
                  <CardDescription>
                    {yf?.forecastAvailable
                      ? `Capacity ${yf.capacityKw} kW · learned derate ${yf.learnedDerate != null ? `${(yf.learnedDerate * 100).toFixed(0)}%` : "not yet learned"}`
                      : "Expected generation from the weather forecast"}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {yieldForecast.isLoading ? (
                    <Skeleton className="h-32 w-full" />
                  ) : yieldForecast.error ? (
                    <p className="text-sm text-muted-foreground">{yieldForecast.error.message}</p>
                  ) : yf && !yf.forecastAvailable ? (
                    <div className="flex items-start gap-3 py-4 text-sm text-muted-foreground">
                      <AlertCircle className="h-5 w-5 mt-0.5" />
                      <p>Forecast unavailable: {yf.reason ?? "weather data unavailable"}. No synthetic yields are shown.</p>
                    </div>
                  ) : yf ? (
                    <div className="space-y-3">
                      {yf.mockData && (
                        <p className="text-xs text-amber-600">
                          Weather service returned opted-in test data for this forecast.
                        </p>
                      )}
                      {yf.learnedDerate == null && (
                        <p className="text-xs text-muted-foreground">
                          No derate could be learned from your history yet — expected yields are shown as unavailable.
                        </p>
                      )}
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Date</TableHead>
                            <TableHead>Peak sun hours</TableHead>
                            <TableHead>Expected yield</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {yf.days.map((d: any) => (
                            <TableRow key={d.date}>
                              <TableCell>{d.date}</TableCell>
                              <TableCell>{d.peakSunHours.toFixed(1)} h</TableCell>
                              <TableCell>{d.expectedYieldWh != null ? fmtWh(d.expectedYieldWh) : "—"}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ) : null}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Performance ratio</CardTitle>
                  <CardDescription>
                    {pr
                      ? `${pr.daysWithData}/${pr.historyDays} days with data · location: ${String(pr.locationSource).replace(/_/g, " ")}`
                      : "Actual vs clear-sky expected generation"}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {perf.isLoading ? (
                    <Skeleton className="h-32 w-full" />
                  ) : perf.error ? (
                    <p className="text-sm text-muted-foreground">{perf.error.message}</p>
                  ) : pr ? (
                    <div className="space-y-3">
                      {pr.insufficientHistory && (
                        <p className="text-xs text-amber-600">
                          Insufficient history to learn a reliable threshold — ratios below are descriptive only.
                        </p>
                      )}
                      <div className="grid grid-cols-3 gap-3 text-sm">
                        <div>
                          <p className="text-muted-foreground">Recent PR</p>
                          <p className="font-medium">
                            {pr.recentPerformanceRatio != null ? `${(pr.recentPerformanceRatio * 100).toFixed(1)}%` : "—"}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Learned median</p>
                          <p className="font-medium">
                            {pr.learnedDerate != null ? `${(pr.learnedDerate * 100).toFixed(1)}%` : "—"}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Status</p>
                          {pr.underperforming ? (
                            <Badge variant="destructive">underperforming</Badge>
                          ) : (
                            <Badge variant="default">normal</Badge>
                          )}
                        </div>
                      </div>
                      {prChart.length > 0 && (
                        <ResponsiveContainer width="100%" height={200}>
                          <BarChart data={prChart}>
                            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                            <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                            <YAxis tick={{ fontSize: 10 }} />
                            <Tooltip formatter={(v: any, name) => [`${Number(v).toFixed(2)} kWh`, name === "actual" ? "Actual" : "Clear-sky"]} />
                            <Legend />
                            <Bar dataKey="clearSky" name="Clear-sky" fill="#c8a24a" fillOpacity={0.5} />
                            <Bar dataKey="actual" name="Actual" fill="#6b9e78" />
                          </BarChart>
                        </ResponsiveContainer>
                      )}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingDown className="h-4 w-4" /> Underperforming assets
                </CardTitle>
                <CardDescription>
                  {underperforming.data?.scope === "fleet"
                    ? "Fleet-wide view (admin)"
                    : "Your solar assets performing below their learned threshold"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {underperforming.isLoading ? (
                  <Skeleton className="h-20 w-full" />
                ) : underperforming.error ? (
                  <p className="text-sm text-muted-foreground">{underperforming.error.message}</p>
                ) : !underperforming.data || underperforming.data.assets.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No underperforming assets detected.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Asset</TableHead>
                        {underperforming.data.scope === "fleet" && <TableHead>User</TableHead>}
                        <TableHead>Recent PR</TableHead>
                        <TableHead>Learned threshold</TableHead>
                        <TableHead>Note</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {underperforming.data.assets.map((a: any) => (
                        <TableRow key={a.assetId}>
                          <TableCell>{a.name}</TableCell>
                          {underperforming.data.scope === "fleet" && <TableCell>#{a.userId}</TableCell>}
                          <TableCell>
                            {a.recentPerformanceRatio != null
                              ? `${(a.recentPerformanceRatio * 100).toFixed(1)}%`
                              : "—"}
                          </TableCell>
                          <TableCell>
                            {a.learnedThreshold != null ? `${(a.learnedThreshold * 100).toFixed(1)}%` : "—"}
                          </TableCell>
                          <TableCell>
                            {a.insufficientHistory ? (
                              <Badge variant="secondary">insufficient history</Badge>
                            ) : (
                              <Badge variant="destructive">below threshold</Badge>
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
