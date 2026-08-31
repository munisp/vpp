import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { PiggyBank, RefreshCw } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

const PROJECTION_REASONS: Record<string, string> = {
  month_not_started: "month has not started",
  month_complete: "month is complete — actuals exist, projection is meaningless",
  no_consumption_data: "no consumption data for the month",
  insufficient_days: "fewer than 3 days of real data",
};

function fmtKwhFromWh(wh: number | null | undefined): string {
  if (wh === null || wh === undefined) return "—";
  return `${(wh / 1000).toFixed(2)} kWh`;
}

function fmtMoney(cents: number | null | undefined, currency: string | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return `${currency ?? ""} ${(cents / 100).toFixed(2)}`.trim();
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export default function BudgetPlanner() {
  const utils = trpc.useUtils();
  const now = new Date();

  const [year, setYear] = useState(String(now.getUTCFullYear()));
  const [month, setMonth] = useState(String(now.getUTCMonth() + 1));
  const [targetKwh, setTargetKwh] = useState("");
  const [targetCost, setTargetCost] = useState("");
  const [selectedBudgetId, setSelectedBudgetId] = useState<number | null>(null);

  const budgets = trpc.budgetPlanner.listBudgets.useQuery({ limit: 12 });

  // Default the detail view to the current month's budget when it exists.
  useEffect(() => {
    if (selectedBudgetId === null && budgets.data) {
      const current = budgets.data.budgets.find(
        (b: any) => b.year === now.getUTCFullYear() && b.month === now.getUTCMonth() + 1
      );
      if (current) setSelectedBudgetId(current.id);
      else if (budgets.data.budgets.length > 0) setSelectedBudgetId(budgets.data.budgets[0].id);
    }
  }, [budgets.data, selectedBudgetId]); // eslint-disable-line react-hooks/exhaustive-deps

  const checkpoints = trpc.budgetPlanner.listCheckpoints.useQuery(
    { budgetId: selectedBudgetId!, limit: 12 },
    { enabled: selectedBudgetId !== null }
  );

  const setMutation = trpc.budgetPlanner.setBudget.useMutation({
    onSuccess: (b) => {
      toast.success(`Budget set for ${MONTHS[b.month - 1]} ${b.year}`);
      setSelectedBudgetId(b.id);
      utils.budgetPlanner.listBudgets.invalidate();
      utils.budgetPlanner.listCheckpoints.invalidate();
    },
    onError: (e) => toast.error(e.message || "Failed to set budget"),
  });

  const checkpointMutation = trpc.budgetPlanner.recordCheckpoint.useMutation({
    onSuccess: (r) => {
      toast.success(
        r.checkpoint.projectionAvailable
          ? "Checkpoint recorded — projection updated"
          : `Checkpoint recorded — projection unavailable (${
              PROJECTION_REASONS[r.checkpoint.projectionUnavailableReason ?? ""] ??
              r.checkpoint.projectionUnavailableReason ??
              "unknown reason"
            })`
      );
      utils.budgetPlanner.listCheckpoints.invalidate();
    },
    onError: (e) => toast.error(e.message || "Failed to record checkpoint"),
  });

  const handleSet = () => {
    const y = parseInt(year, 10);
    const m = parseInt(month, 10);
    if (!y || !m || m < 1 || m > 12) return toast.error("Enter a valid year and month");
    const kwh = targetKwh.trim() === "" ? null : parseFloat(targetKwh);
    const cost = targetCost.trim() === "" ? null : parseFloat(targetCost);
    if (kwh !== null && (!Number.isFinite(kwh) || kwh <= 0)) return toast.error("kWh target must be positive");
    if (cost !== null && (!Number.isFinite(cost) || cost <= 0)) return toast.error("Cost target must be positive");
    if (kwh === null && cost === null) return toast.error("Set at least one target (kWh and/or cost)");
    setMutation.mutate({
      year: y,
      month: m,
      targetKwh: kwh === null ? null : Math.round(kwh),
      targetCostCents: cost === null ? null : Math.round(cost * 100),
    });
  };

  const selectedBudget = budgets.data?.budgets?.find((b: any) => b.id === selectedBudgetId) ?? null;
  const latestCp = checkpoints.data?.checkpoints?.[0] ?? null;
  // basis_json is an untyped json column; the shape written by
  // server/services/innov3-budget-planner.ts (ConsumptionBasis) is:
  const latestBasis = (latestCp?.basisJson ?? null) as {
    source?: "telemetry" | "billing" | null;
    lowerBound?: boolean;
  } | null;

  // Progress toward the kWh target, from the latest checkpoint's real consumption.
  const kwhPct =
    selectedBudget?.targetKwh != null && latestCp?.consumedWh != null
      ? Math.min(100, Math.round(((latestCp.consumedWh / 1000 / selectedBudget.targetKwh) * 1000) / 10))
      : null;
  const costPct =
    selectedBudget?.targetCostCents != null && latestCp?.billedCostCents != null
      ? Math.min(100, Math.round(((latestCp.billedCostCents / selectedBudget.targetCostCents) * 1000) / 10))
      : null;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Energy Budget Planner</h1>
          <p className="text-muted-foreground">
            Monthly kWh and/or cost targets with weekly checkpoints of your real measured
            consumption pace. Month-end figures are pace projections and are labelled as such.
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <PiggyBank className="h-4 w-4" /> Set a monthly budget
              </CardTitle>
              <CardDescription>Creates or updates the budget for that month</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="bpYear">Year</Label>
                  <Input id="bpYear" type="number" min="2020" max="2100" value={year} onChange={(e) => setYear(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="bpMonth">Month (1-12)</Label>
                  <Input id="bpMonth" type="number" min="1" max="12" value={month} onChange={(e) => setMonth(e.target.value)} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="bpKwh">Target (kWh)</Label>
                  <Input id="bpKwh" type="number" min="0" step="1" value={targetKwh} onChange={(e) => setTargetKwh(e.target.value)} placeholder="optional" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="bpCost">Target cost (optional)</Label>
                  <Input id="bpCost" type="number" min="0" step="0.01" value={targetCost} onChange={(e) => setTargetCost(e.target.value)} placeholder="major units" />
                </div>
              </div>
              <Button onClick={handleSet} disabled={setMutation.isPending}>
                {setMutation.isPending ? "Saving…" : "Set budget"}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">My budgets</CardTitle>
              <CardDescription>Select one to inspect its progress and checkpoints</CardDescription>
            </CardHeader>
            <CardContent>
              {budgets.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : budgets.error ? (
                <p className="text-sm text-muted-foreground">{budgets.error.message}</p>
              ) : !budgets.data || budgets.data.budgets.length === 0 ? (
                <p className="text-sm text-muted-foreground">No budgets set yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Month</TableHead>
                      <TableHead>kWh target</TableHead>
                      <TableHead>Cost target</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {budgets.data.budgets.map((b: any) => (
                      <TableRow key={b.id} className={selectedBudgetId === b.id ? "bg-muted/50" : undefined}>
                        <TableCell className="font-medium">
                          {MONTHS[b.month - 1] ?? b.month} {b.year}
                        </TableCell>
                        <TableCell>{b.targetKwh != null ? `${b.targetKwh} kWh` : "—"}</TableCell>
                        <TableCell>{fmtMoney(b.targetCostCents, b.currency)}</TableCell>
                        <TableCell className="text-right">
                          <Button size="sm" variant="outline" onClick={() => setSelectedBudgetId(b.id)}>
                            View
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

        {selectedBudget && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <CardTitle className="text-base">
                    {MONTHS[selectedBudget.month - 1] ?? selectedBudget.month} {selectedBudget.year} progress
                  </CardTitle>
                  <CardDescription>
                    {latestCp
                      ? `Latest checkpoint ${new Date(latestCp.checkpointAt).toLocaleString()} — day ${
                          latestCp.daysElapsed
                        } of ${latestCp.daysInMonth}`
                      : "No checkpoints recorded for this budget yet"}
                  </CardDescription>
                </div>
                <Button
                  variant="outline"
                  onClick={() => checkpointMutation.mutate({ budgetId: selectedBudget.id })}
                  disabled={checkpointMutation.isPending}
                >
                  <RefreshCw className="h-4 w-4 mr-2" />
                  {checkpointMutation.isPending ? "Recording…" : "Record checkpoint"}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              {checkpoints.isLoading ? (
                <Skeleton className="h-16 w-full" />
              ) : !latestCp ? (
                <p className="text-sm text-muted-foreground">
                  Record a checkpoint to measure real month-to-date consumption against this budget.
                </p>
              ) : (
                <>
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span>Energy used: {fmtKwhFromWh(latestCp.consumedWh)}</span>
                      <span className="text-muted-foreground">
                        {selectedBudget.targetKwh != null
                          ? kwhPct !== null
                            ? `${kwhPct}% of ${selectedBudget.targetKwh} kWh`
                            : "—"
                          : "no kWh target"}
                      </span>
                    </div>
                    {selectedBudget.targetKwh != null && kwhPct !== null && <Progress value={kwhPct} />}
                    {latestCp.consumedWh === null && (
                      <p className="text-sm text-muted-foreground">
                        Consumption is unknown — no usable meter readings or billing rows for this month.
                      </p>
                    )}
                    {latestBasis?.lowerBound === true && latestCp.consumedWh !== null && (
                      <p className="text-xs text-muted-foreground">
                        Lower bound: at least one meter has insufficient readings, so its consumption is
                        unknown rather than zero.
                      </p>
                    )}
                    {latestBasis?.source && (
                      <p className="text-xs text-muted-foreground">
                        Consumption measured from {latestBasis.source === "telemetry" ? "meter register deltas" : "billing rows"}.
                      </p>
                    )}
                  </div>

                  {selectedBudget.targetCostCents != null && (
                    <div className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span>Billed: {fmtMoney(latestCp.billedCostCents, selectedBudget.currency)}</span>
                        <span className="text-muted-foreground">
                          {costPct !== null
                            ? `${costPct}% of ${fmtMoney(selectedBudget.targetCostCents, selectedBudget.currency)}`
                            : "—"}
                        </span>
                      </div>
                      {costPct !== null && <Progress value={costPct} />}
                      {latestCp.billedCostCents === null && (
                        <p className="text-sm text-muted-foreground">
                          No billing rows cover this month — billed cost is unknown.
                        </p>
                      )}
                    </div>
                  )}

                  <div className="rounded-md border p-3 text-sm space-y-1">
                    <p className="font-medium">
                      Month-end projection <Badge variant="outline">projection</Badge>
                    </p>
                    {latestCp.projectionAvailable ? (
                      <p className="text-muted-foreground">
                        At the current pace: {fmtKwhFromWh(latestCp.projectedMonthEndWh)}
                        {latestCp.projectedMonthEndCostCents != null &&
                          `, ${fmtMoney(latestCp.projectedMonthEndCostCents, selectedBudget.currency)} billed`}
                        {" "}by month end.
                      </p>
                    ) : (
                      <p className="text-muted-foreground">
                        Projection unavailable —{" "}
                        {PROJECTION_REASONS[latestCp.projectionUnavailableReason ?? ""] ??
                          latestCp.projectionUnavailableReason ??
                          "reason not recorded"}
                        .
                      </p>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        )}

        {selectedBudget && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Checkpoints</CardTitle>
              <CardDescription>One per ISO week; re-recording refreshes the current week</CardDescription>
            </CardHeader>
            <CardContent>
              {checkpoints.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : !checkpoints.data || checkpoints.data.checkpoints.length === 0 ? (
                <p className="text-sm text-muted-foreground">No checkpoints yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Week of</TableHead>
                      <TableHead>Recorded</TableHead>
                      <TableHead>Day</TableHead>
                      <TableHead>Consumed</TableHead>
                      <TableHead>Billed</TableHead>
                      <TableHead>Projection (kWh)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {checkpoints.data.checkpoints.map((c: any) => (
                      <TableRow key={c.id}>
                        <TableCell className="text-sm">{new Date(c.weekStart).toLocaleDateString()}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {new Date(c.checkpointAt).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-sm">
                          {c.daysElapsed}/{c.daysInMonth}
                        </TableCell>
                        <TableCell>{fmtKwhFromWh(c.consumedWh)}</TableCell>
                        <TableCell>{fmtMoney(c.billedCostCents, selectedBudget.currency)}</TableCell>
                        <TableCell className="text-sm">
                          {c.projectionAvailable ? (
                            fmtKwhFromWh(c.projectedMonthEndWh)
                          ) : (
                            <span className="text-muted-foreground">
                              {PROJECTION_REASONS[c.projectionUnavailableReason ?? ""] ??
                                c.projectionUnavailableReason ??
                                "unavailable"}
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
