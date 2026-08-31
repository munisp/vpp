import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, Building2 } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

type Period = "24h" | "7d" | "30d" | "90d";

function fmtWh(wh: number | null | undefined): string {
  if (wh === null || wh === undefined) return "—";
  return wh >= 1000 ? `${(wh / 1000).toFixed(2)} kWh` : `${Math.round(wh)} Wh`;
}
function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${v.toFixed(1)}%`;
}

const METHOD_LABELS: Record<string, string> = {
  energy_register: "energy register",
  power_integration: "power integration",
};

export default function Portfolio() {
  const [period, setPeriod] = useState<Period>("7d");

  const overview = trpc.portfolio.overview.useQuery({ period });
  const snapshots = trpc.portfolio.snapshotHistory.useQuery({ limit: 10 });

  const data = overview.data;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Portfolio</h1>
            <p className="text-muted-foreground">
              Multi-site rollup from real telemetry and real battery-health snapshots. Sites with no
              data are shown as unavailable — never as zero.
            </p>
          </div>
          <Select value={period} onValueChange={(v) => setPeriod(v as Period)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="24h">Last 24 hours</SelectItem>
              <SelectItem value="7d">Last 7 days</SelectItem>
              <SelectItem value="30d">Last 30 days</SelectItem>
              <SelectItem value="90d">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {overview.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : overview.error ? (
          <Card>
            <CardContent className="flex items-center gap-3 py-10 text-muted-foreground">
              <AlertCircle className="h-5 w-5" />
              <p>{overview.error.message}</p>
            </CardContent>
          </Card>
        ) : data ? (
          <>
            <div className="grid gap-4 md:grid-cols-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Generation</CardDescription>
                  <CardTitle className="text-2xl">{fmtWh(data.totals.generationWh)}</CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground">
                  Across {data.totals.availableSiteCount} available site(s)
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Consumption</CardDescription>
                  <CardTitle className="text-2xl">{fmtWh(data.totals.consumptionWh)}</CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground">
                  Meter assets with data
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Mean battery SoH</CardDescription>
                  <CardTitle className="text-2xl">{pct(data.totals.meanBatterySohPct)}</CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground">
                  {data.totals.meanBatterySohPct != null
                    ? "From the latest real health snapshots"
                    : "No battery health snapshots available"}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Sites</CardDescription>
                  <CardTitle className="text-2xl">{data.totals.siteCount}</CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground">
                  {data.totals.unavailableSiteCount > 0
                    ? `${data.totals.unavailableSiteCount} unavailable — excluded from totals`
                    : "All sites reporting"}
                </CardContent>
              </Card>
            </div>

            {data.totals.unavailableSiteCount > 0 && (
              <Card className="border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900">
                <CardContent className="flex items-start gap-3 py-4 text-sm">
                  <AlertCircle className="h-4 w-4 mt-0.5 text-amber-600" />
                  <p>
                    {data.totals.unavailableSiteCount} of {data.totals.siteCount} site(s) have no usable
                    data in this period. Totals cover only the {data.totals.availableSiteCount} available
                    site(s); unavailable sites are excluded rather than counted as zero.
                  </p>
                </CardContent>
              </Card>
            )}

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {data.sites.map((s: any) => (
                <Card key={s.assetId} className={s.available ? "" : "opacity-90 border-dashed"}>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Building2 className="h-4 w-4" />
                      {s.assetName}
                      <Badge variant="outline" className="capitalize">{s.assetType}</Badge>
                    </CardTitle>
                    <CardDescription>
                      {s.available
                        ? `Measured via ${METHOD_LABELS[s.measurementMethod ?? ""] ?? s.measurementMethod}`
                        : "Unavailable"}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="text-sm space-y-1">
                    {s.available ? (
                      <>
                        {s.generationWh != null && <p>Generation: {fmtWh(s.generationWh)}</p>}
                        {s.consumptionWh != null && <p>Consumption: {fmtWh(s.consumptionWh)}</p>}
                        {s.generationWh == null && s.consumptionWh == null && (
                          <p className="text-muted-foreground">
                            Telemetry present but no energy figure for this asset type.
                          </p>
                        )}
                        <p className="text-muted-foreground">{s.sampleCount} samples</p>
                      </>
                    ) : (
                      <div className="flex items-start gap-2 text-muted-foreground">
                        <AlertCircle className="h-4 w-4 mt-0.5 text-amber-600" />
                        <p>{s.reason ?? "No data in this period."}</p>
                      </div>
                    )}
                    {s.batterySohPct != null && (
                      <p className="text-muted-foreground">
                        Battery SoH: {pct(s.batterySohPct)}
                        {s.batterySohAsOf ? ` (as of ${new Date(s.batterySohAsOf).toLocaleDateString()})` : ""}
                      </p>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Snapshot history</CardTitle>
            <CardDescription>Cached portfolio rollups (most recent first)</CardDescription>
          </CardHeader>
          <CardContent>
            {snapshots.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : !snapshots.data || snapshots.data.snapshots.length === 0 ? (
              <p className="text-sm text-muted-foreground">No snapshots recorded yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Created</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead>Window</TableHead>
                    <TableHead>Sites</TableHead>
                    <TableHead>Unavailable</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {snapshots.data.snapshots.map((s: any) => (
                    <TableRow key={s.id}>
                      <TableCell>{new Date(s.createdAt).toLocaleString()}</TableCell>
                      <TableCell>{s.periodLabel}</TableCell>
                      <TableCell>
                        {new Date(s.periodStart).toLocaleDateString()} –{" "}
                        {new Date(s.periodEnd).toLocaleDateString()}
                      </TableCell>
                      <TableCell>{s.siteCount}</TableCell>
                      <TableCell>{s.unavailableSiteCount}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
