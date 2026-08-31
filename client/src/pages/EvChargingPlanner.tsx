import { useMemo, useState } from "react";
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
import { AlertCircle, Car } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

function fmtWh(wh: number | null | undefined): string {
  if (wh === null || wh === undefined) return "—";
  return wh >= 1000 ? `${(wh / 1000).toFixed(2)} kWh` : `${Math.round(wh)} Wh`;
}
function fmtCents(c: number | null | undefined): string {
  if (c === null || c === undefined) return "—";
  return `$${(c / 100).toFixed(2)}`;
}
function pct100(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${(v / 100).toFixed(0)}%`;
}

const UNAVAILABLE_REASONS: Record<string, string> = {
  no_tariff: "No published dynamic tariff for your country — no schedule can be priced.",
  no_soc_telemetry: "No state-of-charge telemetry for this asset — the starting SoC is unknown.",
  insufficient_time: "Not enough time before departure to reach the target at the charge power cap.",
};

interface ChargeWindow {
  startTime: string;
  endTime: string;
  priceCentsPerKwh: number;
  energyWh: number;
  costCents: number;
}

export default function EvChargingPlanner() {
  const utils = trpc.useUtils();
  const { data: assetsData, isLoading: assetsLoading } = trpc.assets.list.useQuery();
  // EVs are modelled as battery assets (the server rejects non-battery types).
  const evAssets = useMemo(
    () => (assetsData?.assets ?? []).filter((a: any) => a.assetType === "battery"),
    [assetsData]
  );

  const [assetId, setAssetId] = useState<number | null>(null);
  const [departure, setDeparture] = useState("");
  const [targetSoc, setTargetSoc] = useState("80");
  const [powerW, setPowerW] = useState("7000");
  const [lastResult, setLastResult] = useState<any>(null);

  const plans = trpc.evChargingPlanner.listPlans.useQuery(
    { assetId: assetId ?? undefined, limit: 20 },
    { enabled: !assetsLoading }
  );

  const createMutation = trpc.evChargingPlanner.createPlan.useMutation({
    onSuccess: (r) => {
      setLastResult(r);
      if (r.scheduleAvailable) {
        toast.success(`Plan created: ${r.windows.length} charge window(s)`);
      } else {
        toast.info(UNAVAILABLE_REASONS[r.unavailableReason ?? ""] ?? "No schedule could be computed");
      }
      utils.evChargingPlanner.listPlans.invalidate();
    },
    onError: (e) => toast.error(e.message || "Failed to create plan"),
  });

  const cancelMutation = trpc.evChargingPlanner.cancelPlan.useMutation({
    onSuccess: () => {
      toast.success("Plan cancelled");
      utils.evChargingPlanner.listPlans.invalidate();
    },
    onError: (e) => toast.error(e.message || "Failed to cancel plan"),
  });

  const handleCreate = () => {
    if (!assetId) return toast.error("Select a vehicle/battery asset");
    if (!departure) return toast.error("Pick a departure time");
    const target = Math.round(parseFloat(targetSoc) * 100);
    const power = Math.round(parseFloat(powerW));
    if (!Number.isFinite(target) || target < 0 || target > 10000) return toast.error("Target SoC must be 0–100%");
    if (!Number.isFinite(power) || power <= 0) return toast.error("Charge power must be positive");
    createMutation.mutate({
      assetId,
      departureTime: new Date(departure),
      targetSocPct100: target,
      maxChargePowerW: power,
    });
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">EV Charging Planner</h1>
          <p className="text-muted-foreground">
            Cost-optimal charge windows priced from your country's published dynamic tariff. When no
            tariff or telemetry exists, the plan says so instead of inventing a schedule.
          </p>
        </div>

        {assetsLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : evAssets.length === 0 ? (
          <Card>
            <CardContent className="flex items-center gap-3 py-10 text-muted-foreground">
              <Car className="h-5 w-5" />
              <p>You have no battery/EV assets. Register one to plan charging.</p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">New charging plan</CardTitle>
              <CardDescription>
                The planner allocates charging to the cheapest tariff hours before departure.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-2">
                <Label>Vehicle / battery</Label>
                <Select value={assetId !== null ? String(assetId) : undefined} onValueChange={(v) => setAssetId(Number(v))}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select asset" />
                  </SelectTrigger>
                  <SelectContent>
                    {evAssets.map((a: any) => (
                      <SelectItem key={a.id} value={String(a.id)}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Departure time</Label>
                <Input type="datetime-local" value={departure} onChange={(e) => setDeparture(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Target SoC (%)</Label>
                <Input type="number" min={0} max={100} value={targetSoc} onChange={(e) => setTargetSoc(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Max charge power (W)</Label>
                <Input type="number" min={1} value={powerW} onChange={(e) => setPowerW(e.target.value)} />
              </div>
              <div className="md:col-span-2 lg:col-span-4">
                <Button onClick={handleCreate} disabled={createMutation.isPending}>
                  {createMutation.isPending ? "Planning…" : "Create plan"}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {lastResult && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                Latest plan result
                {lastResult.scheduleAvailable ? (
                  <Badge variant="outline">scheduled</Badge>
                ) : (
                  <Badge variant="secondary">schedule unavailable</Badge>
                )}
              </CardTitle>
              <CardDescription>
                Departure {new Date(lastResult.departureTime).toLocaleString()} · target{" "}
                {pct100(lastResult.targetSocPct100)} · start SoC {pct100(lastResult.startSocPct100)}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {!lastResult.scheduleAvailable && (
                <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900 p-3 text-sm">
                  <AlertCircle className="h-4 w-4 mt-0.5 text-amber-600" />
                  <p>
                    {UNAVAILABLE_REASONS[lastResult.unavailableReason ?? ""] ??
                      lastResult.unavailableReason ??
                      "Schedule unavailable"}
                    {lastResult.energyNeededWh != null
                      ? ` Energy still needed: ${fmtWh(lastResult.energyNeededWh)}.`
                      : ""}
                  </p>
                </div>
              )}
              <div className="grid gap-4 md:grid-cols-4 text-sm">
                <div>
                  <p className="text-muted-foreground">Energy needed</p>
                  <p className="font-medium">{fmtWh(lastResult.energyNeededWh)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Expected cost</p>
                  <p className="font-medium">{fmtCents(lastResult.expectedCostCents)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Charge-now cost</p>
                  <p className="font-medium">{fmtCents(lastResult.naiveImmediateCostCents)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Savings vs immediate</p>
                  <p className="font-medium">{fmtCents(lastResult.savingsVsImmediateCents)}</p>
                </div>
              </div>
              {(lastResult.windows as ChargeWindow[]).length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Window start</TableHead>
                      <TableHead>Window end</TableHead>
                      <TableHead>Price</TableHead>
                      <TableHead>Energy</TableHead>
                      <TableHead>Cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(lastResult.windows as ChargeWindow[]).map((w, i) => (
                      <TableRow key={i}>
                        <TableCell>{new Date(w.startTime).toLocaleString()}</TableCell>
                        <TableCell>{new Date(w.endTime).toLocaleString()}</TableCell>
                        <TableCell>{(w.priceCentsPerKwh / 100).toFixed(2)} $/kWh</TableCell>
                        <TableCell>{fmtWh(w.energyWh)}</TableCell>
                        <TableCell>{fmtCents(w.costCents)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : lastResult.scheduleAvailable ? (
                <p className="text-sm text-muted-foreground">
                  No charging required — the battery is already at or above the target SoC.
                </p>
              ) : null}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Plans</CardTitle>
            <CardDescription>
              {assetId !== null ? "Plans for the selected asset" : "All your plans"} (most recent first)
            </CardDescription>
          </CardHeader>
          <CardContent>
            {plans.isLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : plans.error ? (
              <p className="text-sm text-muted-foreground">{plans.error.message}</p>
            ) : !plans.data || plans.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">No plans yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Created</TableHead>
                    <TableHead>Departure</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Energy</TableHead>
                    <TableHead>Expected cost</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {plans.data.map((p: any) => (
                    <TableRow key={p.id}>
                      <TableCell>{new Date(p.createdAt).toLocaleString()}</TableCell>
                      <TableCell>{new Date(p.departureTime).toLocaleString()}</TableCell>
                      <TableCell>{pct100(p.targetSocPct100)}</TableCell>
                      <TableCell>{fmtWh(p.energyNeededWh)}</TableCell>
                      <TableCell>{fmtCents(p.expectedCostCents)}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Badge
                            variant={
                              p.status === "scheduled" || p.status === "active"
                                ? "default"
                                : p.status === "infeasible"
                                  ? "secondary"
                                  : "outline"
                            }
                          >
                            {p.status}
                          </Badge>
                          {p.scheduleAvailable === false && (
                            <span className="text-xs text-muted-foreground" title={p.unavailableReason ?? ""}>
                              {p.unavailableReason ?? "unavailable"}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {(p.status === "scheduled" || p.status === "active") && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => cancelMutation.mutate({ planId: p.id })}
                            disabled={cancelMutation.isPending}
                          >
                            Cancel
                          </Button>
                        )}
                      </TableCell>
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
