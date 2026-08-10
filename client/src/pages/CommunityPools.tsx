import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { Play, Users } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

type RuleType = "proportional_consumption" | "equal" | "proportional_generation" | "custom_weights";

function fmtWh(wh: number | null | undefined): string {
  if (wh === null || wh === undefined) return "—";
  return wh >= 1000 ? `${(wh / 1000).toFixed(1)} kWh` : `${wh} Wh`;
}
function fmtCents(c: number | null | undefined): string {
  if (c === null || c === undefined) return "—";
  return `$${(c / 100).toFixed(2)}`;
}

export default function CommunityPools() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const communities = trpc.community.getUserCommunities.useQuery();

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const communityId = selectedId ?? communities.data?.[0]?.id ?? null;

  const membership = useMemo(() => {
    const c = communities.data?.find((x: any) => x.id === communityId);
    return c?.membership ?? null;
  }, [communities.data, communityId]);
  const canAdmin =
    user?.role === "admin" || membership?.role === "admin" || membership?.role === "operator";

  const rules = trpc.communityPools.getPoolRules.useQuery(
    { communityId: communityId! },
    { enabled: communityId !== null, retry: false }
  );
  const runs = trpc.communityPools.listRuns.useQuery(
    { communityId: communityId!, limit: 20 },
    { enabled: communityId !== null, retry: false }
  );
  const statement = trpc.communityPools.getMyStatement.useQuery(
    { communityId: communityId! },
    { enabled: communityId !== null, retry: false }
  );

  const [ruleType, setRuleType] = useState<RuleType>("proportional_consumption");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");

  const setRulesMutation = trpc.communityPools.setPoolRules.useMutation({
    onSuccess: () => {
      toast.success("Pool rules updated");
      utils.communityPools.getPoolRules.invalidate();
    },
    onError: (e) => toast.error(e.message || "Failed to set rules"),
  });

  const runMutation = trpc.communityPools.runAllocation.useMutation({
    onSuccess: (r) => {
      toast.success(`Allocation run #${r.run.id} computed for ${r.entries.length} member(s)`);
      utils.communityPools.listRuns.invalidate();
      utils.communityPools.getMyStatement.invalidate();
    },
    onError: (e) => toast.error(e.message || "Allocation run failed"),
  });

  const stmt = statement.data;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Community Pools</h1>
            <p className="text-muted-foreground">
              Surplus/deficit allocation across your energy community at real period prices.
            </p>
          </div>
          <Select
            value={communityId !== null ? String(communityId) : undefined}
            onValueChange={(v) => setSelectedId(Number(v))}
          >
            <SelectTrigger className="w-64">
              <SelectValue placeholder="Select a community" />
            </SelectTrigger>
            <SelectContent>
              {(communities.data ?? []).map((c: any) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {communities.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : (communities.data ?? []).length === 0 ? (
          <Card>
            <CardContent className="flex items-center gap-3 py-10 text-muted-foreground">
              <Users className="h-5 w-5" />
              <p>You are not a member of any energy community yet.</p>
            </CardContent>
          </Card>
        ) : communityId !== null ? (
          <>
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Allocation rule</CardTitle>
                  <CardDescription>How pool value is distributed across members</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {rules.isLoading ? (
                    <Skeleton className="h-12 w-full" />
                  ) : rules.error ? (
                    <p className="text-sm text-muted-foreground">{rules.error.message}</p>
                  ) : rules.data?.rule ? (
                    <div className="flex items-center gap-2">
                      <Badge variant="default">{String(rules.data.rule.ruleType).replace(/_/g, " ")}</Badge>
                      <span className="text-xs text-muted-foreground">
                        updated {new Date(rules.data.rule.updatedAt).toLocaleString()}
                      </span>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No allocation rule has been configured.</p>
                  )}

                  {canAdmin && (
                    <div className="flex items-end gap-2 pt-2 border-t">
                      <div className="flex-1 space-y-2">
                        <Label>Set rule type</Label>
                        <Select value={ruleType} onValueChange={(v) => setRuleType(v as RuleType)}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="proportional_consumption">Proportional to consumption</SelectItem>
                            <SelectItem value="proportional_generation">Proportional to generation</SelectItem>
                            <SelectItem value="equal">Equal shares</SelectItem>
                            <SelectItem value="custom_weights">Custom weights</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <Button
                        variant="outline"
                        onClick={() => setRulesMutation.mutate({ communityId, ruleType })}
                        disabled={setRulesMutation.isPending}
                      >
                        Save rule
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Run an allocation</CardTitle>
                  <CardDescription>
                    {canAdmin
                      ? "Values the pool surplus/deficit at real period prices"
                      : "Only pool admins can run allocations"}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="pStart">Period start</Label>
                      <Input id="pStart" type="datetime-local" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="pEnd">Period end</Label>
                      <Input id="pEnd" type="datetime-local" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
                    </div>
                  </div>
                  <Button
                    onClick={() => {
                      if (!periodStart || !periodEnd) return toast.error("Set both period bounds");
                      runMutation.mutate({
                        communityId,
                        periodStart: new Date(periodStart),
                        periodEnd: new Date(periodEnd),
                      });
                    }}
                    disabled={!canAdmin || runMutation.isPending}
                  >
                    <Play className="h-4 w-4 mr-2" />
                    {runMutation.isPending ? "Running…" : "Run allocation"}
                  </Button>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">My statement</CardTitle>
                <CardDescription>Your share of the latest allocation run</CardDescription>
              </CardHeader>
              <CardContent>
                {statement.isLoading ? (
                  <Skeleton className="h-20 w-full" />
                ) : statement.error ? (
                  <p className="text-sm text-muted-foreground">{statement.error.message}</p>
                ) : stmt ? (
                  <div className="space-y-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <span>
                        Run #{stmt.run.id} · {new Date(stmt.run.periodStart).toLocaleDateString()} –{" "}
                        {new Date(stmt.run.periodEnd).toLocaleDateString()}
                      </span>
                      <Badge variant="outline">{String(stmt.run.ruleType).replace(/_/g, " ")}</Badge>
                      <Badge variant={stmt.run.status === "finalized" ? "default" : "secondary"}>{stmt.run.status}</Badge>
                    </div>
                    {stmt.entry ? (
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                        <div>
                          <p className="text-muted-foreground">Share</p>
                          <p className="font-medium">{(stmt.entry.shareBps / 100).toFixed(2)}%</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Your generation</p>
                          <p className="font-medium">{fmtWh(stmt.entry.generationWh)}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Your consumption</p>
                          <p className="font-medium">{fmtWh(stmt.entry.consumptionWh)}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Allocated value</p>
                          <p className={`font-medium ${stmt.entry.allocatedValueCents >= 0 ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}>
                            {stmt.entry.allocatedValueCents >= 0 ? "+" : ""}
                            {fmtCents(stmt.entry.allocatedValueCents)}
                          </p>
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        You have no entry in this run (no generation/consumption data in the period).
                      </p>
                    )}
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs text-muted-foreground border-t pt-3">
                      <span>Pool generation: {fmtWh(stmt.run.totalGenerationWh)}</span>
                      <span>Pool consumption: {fmtWh(stmt.run.totalConsumptionWh)}</span>
                      <span>Surplus: {fmtWh(stmt.run.surplusWh)}</span>
                      <span>Deficit: {fmtWh(stmt.run.deficitWh)}</span>
                      <span>Net value: {fmtCents(stmt.run.netValueCents)}</span>
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Allocation runs</CardTitle>
                <CardDescription>Newest first</CardDescription>
              </CardHeader>
              <CardContent>
                {runs.isLoading ? (
                  <Skeleton className="h-24 w-full" />
                ) : runs.error ? (
                  <p className="text-sm text-muted-foreground">{runs.error.message}</p>
                ) : !runs.data || runs.data.runs.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No allocation runs yet.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Run</TableHead>
                        <TableHead>Period</TableHead>
                        <TableHead>Rule</TableHead>
                        <TableHead>Surplus</TableHead>
                        <TableHead>Net value</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {runs.data.runs.map((r: any) => (
                        <TableRow key={r.id}>
                          <TableCell>#{r.id}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {new Date(r.periodStart).toLocaleDateString()} – {new Date(r.periodEnd).toLocaleDateString()}
                          </TableCell>
                          <TableCell className="text-sm">{String(r.ruleType).replace(/_/g, " ")}</TableCell>
                          <TableCell>{fmtWh(r.surplusWh)}</TableCell>
                          <TableCell>{fmtCents(r.netValueCents)}</TableCell>
                          <TableCell>
                            <Badge variant={r.status === "finalized" ? "default" : "secondary"}>{r.status}</Badge>
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
