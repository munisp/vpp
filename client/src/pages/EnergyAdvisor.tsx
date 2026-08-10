import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { RefreshCw, Sparkles, AlertCircle, Lightbulb, FileText } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

function fmtWh(wh: number | null): string {
  if (wh === null || wh === undefined) return "—";
  if (Math.abs(wh) >= 1000) return `${(wh / 1000).toFixed(1)} kWh`;
  return `${wh} Wh`;
}

function fmtCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

function FactsCard({ facts }: { facts: any }) {
  if (!facts) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Your energy context</CardTitle>
        <CardDescription>
          Real data behind this advice — {facts.windowDays}-day window ending{" "}
          {facts.periodEnd ? new Date(facts.periodEnd).toLocaleDateString() : "—"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-muted-foreground">Solar generation</p>
            <p className="font-medium">{fmtWh(facts.solarGenerationWh)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Grid import</p>
            <p className="font-medium">{fmtWh(facts.meterImportWh)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Battery throughput</p>
            <p className="font-medium">{fmtWh(facts.batteryThroughputWh)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Self-consumption</p>
            <p className="font-medium">
              {facts.selfConsumptionRatio != null ? `${Math.round(facts.selfConsumptionRatio * 100)}%` : "—"}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Trades (30d)</p>
            <p className="font-medium">{facts.trades30d?.executedCount ?? 0} executed</p>
          </div>
          <div>
            <p className="text-muted-foreground">Export revenue (30d)</p>
            <p className="font-medium">{fmtCents(facts.trades30d?.exportRevenueCents)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Payments (30d)</p>
            <p className="font-medium">
              {facts.payments30d?.completedCount ?? 0} completed / {facts.payments30d?.failedCount ?? 0} failed
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Assets</p>
            <p className="font-medium">
              {facts.assets?.total ?? 0} ({facts.assets?.solar ?? 0} solar, {facts.assets?.battery ?? 0} battery)
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function AdvicePanel({ kind }: { kind: "recommendations" | "weekly_digest" }) {
  const utils = trpc.useUtils();
  const [refreshing, setRefreshing] = useState(false);
  const query =
    kind === "recommendations"
      ? trpc.energyAdvisor.getRecommendations.useQuery()
      : trpc.energyAdvisor.getWeeklyDigest.useQuery();
  const { data, isLoading, error } = query;

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const fetcher =
        kind === "recommendations"
          ? utils.energyAdvisor.getRecommendations
          : utils.energyAdvisor.getWeeklyDigest;
      await fetcher.fetch({ refresh: true });
      await query.refetch();
      toast.success("Advice refreshed");
    } catch (e: any) {
      toast.error(e.message || "Failed to refresh advice");
    } finally {
      setRefreshing(false);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (error) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 py-8 text-muted-foreground">
          <AlertCircle className="h-5 w-5" />
          <p>{error.message}</p>
        </CardContent>
      </Card>
    );
  }
  if (!data) return null;

  const items: string[] =
    data.llmAvailable && data.recommendations?.length ? data.recommendations : data.ruleBasedTips ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {data.llmAvailable ? (
            <Badge variant="default">AI generated{data.llmModel ? ` · ${data.llmModel}` : ""}</Badge>
          ) : (
            <Badge variant="secondary">AI unavailable — rule-based tips from your real data</Badge>
          )}
          {data.cached && <Badge variant="outline">cached</Badge>}
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
          <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? "animate-spin" : ""}`} />
          Regenerate
        </Button>
      </div>

      {!data.llmAvailable && (
        <Card className="border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900">
          <CardContent className="flex items-start gap-3 py-4 text-sm">
            <AlertCircle className="h-4 w-4 mt-0.5 text-amber-600" />
            <p>
              The AI advisor is currently unavailable
              {data.llmError ? ` (${data.llmError})` : ""}. The tips below are derived directly from
              your measured energy data.
            </p>
          </CardContent>
        </Card>
      )}

      {data.digest && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="h-4 w-4" /> Weekly digest
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm whitespace-pre-wrap">{data.digest}</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Lightbulb className="h-4 w-4" />
            {kind === "recommendations" ? "Recommendations" : "Tips"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No recommendations could be produced — there is not enough measured data yet.
            </p>
          ) : (
            <ul className="list-disc pl-5 space-y-2 text-sm">
              {items.map((tip, i) => (
                <li key={i}>{tip}</li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <FactsCard facts={data.facts} />
    </div>
  );
}

export default function EnergyAdvisor() {
  const { data: history, isLoading: historyLoading } = trpc.energyAdvisor.getReportHistory.useQuery({ limit: 20 });

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Energy Advisor</h1>
          <p className="text-muted-foreground">
            Personalized advice computed from your real telemetry, trades and billing history.
          </p>
        </div>

        <Tabs defaultValue="recommendations">
          <TabsList>
            <TabsTrigger value="recommendations">Recommendations</TabsTrigger>
            <TabsTrigger value="digest">Weekly digest</TabsTrigger>
            <TabsTrigger value="history">Report history</TabsTrigger>
          </TabsList>
          <TabsContent value="recommendations" className="mt-4">
            <AdvicePanel kind="recommendations" />
          </TabsContent>
          <TabsContent value="digest" className="mt-4">
            <AdvicePanel kind="weekly_digest" />
          </TabsContent>
          <TabsContent value="history" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <FileText className="h-4 w-4" /> Previously generated reports
                </CardTitle>
              </CardHeader>
              <CardContent>
                {historyLoading ? (
                  <Skeleton className="h-32 w-full" />
                ) : !history || history.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No advisor reports have been generated yet.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Kind</TableHead>
                        <TableHead>Source</TableHead>
                        <TableHead>Period</TableHead>
                        <TableHead>Items</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {history.map((r: any) => (
                        <TableRow key={r.id}>
                          <TableCell>{new Date(r.createdAt).toLocaleString()}</TableCell>
                          <TableCell>
                            <Badge variant="outline">{r.kind === "weekly_digest" ? "Weekly digest" : "Recommendations"}</Badge>
                          </TableCell>
                          <TableCell>
                            {r.llmAvailable ? (
                              <Badge variant="default">AI{r.llmModel ? ` · ${r.llmModel}` : ""}</Badge>
                            ) : (
                              <Badge variant="secondary">Rule-based</Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {new Date(r.periodStart).toLocaleDateString()} – {new Date(r.periodEnd).toLocaleDateString()}
                          </TableCell>
                          <TableCell>{r.recommendations?.length ?? 0}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
