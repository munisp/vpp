import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, BatteryCharging } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

function pct(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined ? "—" : `${v.toFixed(digits)}%`;
}
function fmtWh(wh: number | null | undefined): string {
  if (wh === null || wh === undefined) return "—";
  return wh >= 1000 ? `${(wh / 1000).toFixed(2)} kWh` : `${Math.round(wh)} Wh`;
}

export default function BatteryHealth() {
  const { data: assetsData, isLoading: assetsLoading } = trpc.assets.list.useQuery();
  const batteries = useMemo(
    () => (assetsData?.assets ?? []).filter((a: any) => a.assetType === "battery"),
    [assetsData]
  );
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const assetId = selectedId ?? batteries[0]?.id ?? null;

  const health = trpc.batteryHealth.getBatteryHealth.useQuery(
    { assetId: assetId! },
    { enabled: assetId !== null }
  );
  const snapshots = trpc.batteryHealth.getSnapshotHistory.useQuery(
    { assetId: assetId!, limit: 20 },
    { enabled: assetId !== null }
  );

  const h = health.data;
  const weekly = (h?.weeklyEfficiencies ?? []).map((w: any) => ({
    week: new Date(w.weekStart).toLocaleDateString(),
    efficiency: w.efficiencyPct,
  }));

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Battery Health</h1>
            <p className="text-muted-foreground">
              State-of-health, cycle counting and degradation computed from real SoC/power telemetry.
            </p>
          </div>
          <Select
            value={assetId !== null ? String(assetId) : undefined}
            onValueChange={(v) => setSelectedId(Number(v))}
          >
            <SelectTrigger className="w-64">
              <SelectValue placeholder={assetsLoading ? "Loading…" : "Select a battery"} />
            </SelectTrigger>
            <SelectContent>
              {batteries.map((b: any) => (
                <SelectItem key={b.id} value={String(b.id)}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {assetsLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : batteries.length === 0 ? (
          <Card>
            <CardContent className="flex items-center gap-3 py-10 text-muted-foreground">
              <BatteryCharging className="h-5 w-5" />
              <p>You have no battery assets. Register a battery to see health analytics.</p>
            </CardContent>
          </Card>
        ) : health.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : health.error ? (
          <Card>
            <CardContent className="flex items-center gap-3 py-10 text-muted-foreground">
              <AlertCircle className="h-5 w-5" />
              <p>{health.error.message}</p>
            </CardContent>
          </Card>
        ) : h ? (
          <>
            {h.insufficientData && (
              <Card className="border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900">
                <CardContent className="flex items-start gap-3 py-4 text-sm">
                  <AlertCircle className="h-4 w-4 mt-0.5 text-amber-600" />
                  <p>
                    Insufficient telemetry to compute health metrics
                    {h.reason ? `: ${h.reason}` : ""}. Metrics below are shown as unavailable rather
                    than estimated.
                  </p>
                </CardContent>
              </Card>
            )}

            {h.warrantyRisk && (
              <Card className="border-red-200 bg-red-50 dark:bg-red-950/20 dark:border-red-900">
                <CardContent className="py-4 text-sm">
                  <p className="font-medium text-red-700 dark:text-red-400">Warranty risk detected</p>
                  <ul className="list-disc pl-5 mt-1 text-muted-foreground">
                    {h.warrantyRiskReasons.map((r: string, i: number) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

            <div className="grid gap-4 md:grid-cols-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Estimated SoH</CardDescription>
                  <CardTitle className="text-2xl">{pct(h.estimatedSohPct)}</CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Full-cycle equivalents</CardDescription>
                  <CardTitle className="text-2xl">
                    {h.fullCycleEquivalents != null ? h.fullCycleEquivalents.toFixed(1) : "—"}
                  </CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Round-trip efficiency</CardDescription>
                  <CardTitle className="text-2xl">{pct(h.roundTripEfficiencyPct)}</CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Degradation slope</CardDescription>
                  <CardTitle className="text-2xl">
                    {h.weeklyDegradationSlopePctPerWeek != null
                      ? `${h.weeklyDegradationSlopePctPerWeek.toFixed(2)} pp/wk`
                      : "—"}
                  </CardTitle>
                </CardHeader>
              </Card>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Measurement window</CardTitle>
                  <CardDescription>
                    {h.spanDays != null ? `${h.spanDays.toFixed(1)} days` : "—"} · {h.sampleCount} samples (
                    {h.socSampleCount} SoC)
                  </CardDescription>
                </CardHeader>
                <CardContent className="text-sm space-y-1">
                  <p>From: {h.windowStart ? new Date(h.windowStart).toLocaleString() : "—"}</p>
                  <p>To: {h.windowEnd ? new Date(h.windowEnd).toLocaleString() : "—"}</p>
                  <p>Charge energy: {fmtWh(h.chargeEnergyWh)}</p>
                  <p>Discharge energy: {fmtWh(h.dischargeEnergyWh)}</p>
                  <p className="text-muted-foreground">
                    Capacity: {h.capacityWh >= 1000 ? `${(h.capacityWh / 1000).toFixed(1)} kWh` : `${h.capacityWh} Wh`}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Weekly round-trip efficiency</CardTitle>
                  <CardDescription>Learned per-week efficiency from telemetry</CardDescription>
                </CardHeader>
                <CardContent>
                  {weekly.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-6">
                      Not enough weekly data to chart efficiency.
                    </p>
                  ) : (
                    <ResponsiveContainer width="100%" height={220}>
                      <LineChart data={weekly}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                        <XAxis dataKey="week" tick={{ fontSize: 11 }} />
                        <YAxis domain={["auto", "auto"]} tick={{ fontSize: 11 }} />
                        <Tooltip formatter={(v: any) => [`${Number(v).toFixed(1)}%`, "Efficiency"]} />
                        <Line type="monotone" dataKey="efficiency" stroke="#6b9e78" strokeWidth={2} dot />
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Snapshot history</CardTitle>
                <CardDescription>Persisted health computations for this asset</CardDescription>
              </CardHeader>
              <CardContent>
                {snapshots.isLoading ? (
                  <Skeleton className="h-24 w-full" />
                ) : !snapshots.data || snapshots.data.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No snapshots recorded yet.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Computed</TableHead>
                        <TableHead>SoH</TableHead>
                        <TableHead>Cycles</TableHead>
                        <TableHead>Efficiency</TableHead>
                        <TableHead>Slope</TableHead>
                        <TableHead>Warranty risk</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {snapshots.data.map((s: any) => (
                        <TableRow key={s.id}>
                          <TableCell>{new Date(s.computedAt).toLocaleString()}</TableCell>
                          <TableCell>
                            {s.estimatedSohPct100 != null ? pct(s.estimatedSohPct100 / 100) : "—"}
                          </TableCell>
                          <TableCell>
                            {s.fullCycleEquivalentsMilli != null
                              ? (s.fullCycleEquivalentsMilli / 1000).toFixed(1)
                              : "—"}
                          </TableCell>
                          <TableCell>
                            {s.roundTripEfficiencyPct100 != null
                              ? pct(s.roundTripEfficiencyPct100 / 100)
                              : "—"}
                          </TableCell>
                          <TableCell>
                            {s.weeklyDegradationSlopePct100 != null
                              ? `${(s.weeklyDegradationSlopePct100 / 100).toFixed(2)} pp/wk`
                              : "—"}
                          </TableCell>
                          <TableCell>
                            {s.insufficientData ? (
                              <Badge variant="secondary">insufficient data</Badge>
                            ) : s.warrantyRisk ? (
                              <Badge variant="destructive">yes</Badge>
                            ) : (
                              <Badge variant="outline">no</Badge>
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
        ) : null}
      </div>
    </DashboardLayout>
  );
}
