import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { AlertCircle, ArrowLeftRight, RefreshCw } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

function fmtCents(c: number | null | undefined): string {
  if (c === null || c === undefined) return "—";
  return `$${(c / 100).toFixed(2)}`;
}
function fmtWh(wh: number | null | undefined): string {
  if (wh === null || wh === undefined) return "—";
  return wh >= 1000 ? `${(wh / 1000).toFixed(2)} kWh` : `${Math.round(wh)} Wh`;
}

const UNAVAILABLE_REASONS: Record<string, string> = {
  no_published_tariffs: "No dynamic tariffs are published yet — there is nothing to compare against.",
  insufficient_usage: "Not enough interval usage history across your assets to build a usage profile.",
};

export default function TariffAdvisor() {
  const utils = trpc.useUtils();
  const [result, setResult] = useState<any>(null);

  const history = trpc.tariffAdvisor.listComparisons.useQuery({ limit: 5 });

  const compareMutation = trpc.tariffAdvisor.compareTariffs.useMutation({
    onSuccess: (r) => {
      setResult(r);
      if (r.available) toast.success("Tariff comparison computed");
      else toast.info(UNAVAILABLE_REASONS[r.unavailableReason ?? ""] ?? "Comparison unavailable");
      utils.tariffAdvisor.listComparisons.invalidate();
    },
    onError: (e) => toast.error(e.message || "Comparison failed"),
  });

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Tariff Advisor</h1>
            <p className="text-muted-foreground">
              Your real usage profile priced against every published dynamic tariff, ranked
              cheapest-first. No published tariff or thin history means an explicit "unavailable", not
              a synthetic comparison.
            </p>
          </div>
          <Button onClick={() => compareMutation.mutate()} disabled={compareMutation.isPending}>
            <RefreshCw className={`h-4 w-4 mr-2 ${compareMutation.isPending ? "animate-spin" : ""}`} />
            {compareMutation.isPending ? "Comparing…" : "Compare tariffs"}
          </Button>
        </div>

        {result && !result.available && (
          <Card className="border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900">
            <CardContent className="flex items-start gap-3 py-4 text-sm">
              <AlertCircle className="h-4 w-4 mt-0.5 text-amber-600" />
              <div>
                <p className="font-medium text-amber-700 dark:text-amber-400">Comparison unavailable</p>
                <p className="text-muted-foreground">
                  {UNAVAILABLE_REASONS[result.unavailableReason ?? ""] ?? result.unavailableReason ?? "Unavailable"}
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {result && result.available && (
          <>
            <div className="grid gap-4 md:grid-cols-3">
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Cheapest tariff</CardDescription>
                  <CardTitle className="text-2xl">
                    {result.cheapestTariffId != null ? `#${result.cheapestTariffId}` : "—"}
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  Computed cost: {fmtCents(result.cheapestCostCents)}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Your current tariff</CardDescription>
                  <CardTitle className="text-2xl">
                    {result.currentTariffId != null ? `#${result.currentTariffId}` : "—"}
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  {result.currentTariffId != null
                    ? "The published tariff of your country"
                    : "No published tariff for your country"}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Savings vs current</CardDescription>
                  <CardTitle className="text-2xl">
                    {result.savingsVsCurrentCents != null ? fmtCents(result.savingsVsCurrentCents) : "—"}
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  {result.savingsVsCurrentCents != null
                    ? `Over ${result.spanDays ?? "—"} days of usage (${fmtWh(result.usageWh)})`
                    : "Not computable — a tariff could not price every hour"}
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Ranked comparison</CardTitle>
                <CardDescription>
                  Usage window {result.windowStart ? new Date(result.windowStart).toLocaleDateString() : "—"} –{" "}
                  {result.windowEnd ? new Date(result.windowEnd).toLocaleDateString() : "—"} · profile from{" "}
                  {result.spanDays ?? "—"} days of real telemetry
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Rank</TableHead>
                      <TableHead>Tariff</TableHead>
                      <TableHead>Version</TableHead>
                      <TableHead>Country</TableHead>
                      <TableHead>Computed cost</TableHead>
                      <TableHead>Unpriced energy</TableHead>
                      <TableHead>Completeness</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.results.map((r: any) => (
                      <TableRow
                        key={r.tariffId}
                        className={r.tariffId === result.cheapestTariffId ? "bg-green-50 dark:bg-green-950/20" : ""}
                      >
                        <TableCell>
                          <div className="flex items-center gap-2">
                            #{r.rank}
                            {r.tariffId === result.cheapestTariffId && (
                              <Badge variant="default">cheapest</Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>#{r.tariffId}</TableCell>
                        <TableCell>v{r.version}</TableCell>
                        <TableCell className="capitalize">{r.country}</TableCell>
                        <TableCell>{fmtCents(r.computedCostCents)}</TableCell>
                        <TableCell>{r.unpricedWh > 0 ? fmtWh(r.unpricedWh) : "—"}</TableCell>
                        <TableCell>
                          {r.complete ? (
                            <Badge variant="outline">fully priced</Badge>
                          ) : (
                            <Badge variant="secondary" title="Some usage fell in hours with no published price">
                              partial
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </>
        )}

        {!result && (
          <Card>
            <CardContent className="flex items-center gap-3 py-10 text-muted-foreground">
              <ArrowLeftRight className="h-5 w-5" />
              <p>Press "Compare tariffs" to price your real usage profile against published tariffs.</p>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Past comparisons</CardTitle>
            <CardDescription>Previous comparison runs (most recent first)</CardDescription>
          </CardHeader>
          <CardContent>
            {history.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : !history.data || history.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">No comparisons recorded yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Computed</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Cheapest tariff</TableHead>
                    <TableHead>Cheapest cost</TableHead>
                    <TableHead>Savings vs current</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.data.map((c: any) => (
                    <TableRow key={c.id}>
                      <TableCell>{new Date(c.computedAt).toLocaleString()}</TableCell>
                      <TableCell>
                        {c.available ? (
                          <Badge variant="outline">available</Badge>
                        ) : (
                          <Badge variant="secondary" title={c.unavailableReason ?? ""}>
                            unavailable
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>{c.cheapestTariffId != null ? `#${c.cheapestTariffId}` : "—"}</TableCell>
                      <TableCell>{fmtCents(c.cheapestCostCents)}</TableCell>
                      <TableCell>{fmtCents(c.savingsVsCurrentCents)}</TableCell>
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
