import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { AlertCircle, CalendarClock } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";

function fmtCents(c: number | null | undefined): string {
  if (c === null || c === undefined) return "—";
  return `$${(c / 100).toFixed(2)}`;
}

export default function V2G() {
  const utils = trpc.useUtils();
  const { data: assetsData } = trpc.assets.list.useQuery();
  const batteries = useMemo(
    () => (assetsData?.assets ?? []).filter((a: any) => a.assetType === "battery"),
    [assetsData]
  );

  const [evId, setEvId] = useState<string>("");
  const [departure, setDeparture] = useState("");
  const [targetSoc, setTargetSoc] = useState("90");
  const [startSoc, setStartSoc] = useState("50");
  const [capacityKwh, setCapacityKwh] = useState("");
  const [allowV2g, setAllowV2g] = useState(false);
  const [plan, setPlan] = useState<any | null>(null);

  const schedules = trpc.v2gOptimizer.listSchedules.useQuery({ limit: 20 });

  const planMutation = trpc.v2gOptimizer.planSchedule.useMutation({
    onSuccess: (r) => {
      setPlan(r);
      if (r.scheduleAvailable) {
        toast.success(`Schedule #${r.scheduleId} planned (${r.priceSource?.replace(/_/g, " ")})`);
        utils.v2gOptimizer.listSchedules.invalidate();
      }
    },
    onError: (e) => toast.error(e.message || "Failed to plan schedule"),
  });

  const cancelMutation = trpc.v2gOptimizer.cancelSchedule.useMutation({
    onSuccess: () => {
      toast.success("Schedule cancelled");
      utils.v2gOptimizer.listSchedules.invalidate();
    },
    onError: (e) => toast.error(e.message || "Failed to cancel schedule"),
  });

  const handlePlan = () => {
    if (!evId) return toast.error("Select a battery/EV asset");
    if (!departure) return toast.error("Set a departure time");
    const target = parseFloat(targetSoc);
    if (isNaN(target) || target < 0 || target > 100) return toast.error("Target SoC must be 0–100");
    planMutation.mutate({
      evId: Number(evId),
      departureTime: new Date(departure),
      targetSocPercent: target,
      startSocPercent: startSoc ? parseFloat(startSoc) : undefined,
      batteryCapacityKwh: capacityKwh ? parseFloat(capacityKwh) : undefined,
      allowV2g,
    });
  };

  const intervals = (plan?.intervals ?? []).map((i: any) => ({
    hour: new Date(i.startTime).getHours().toString().padStart(2, "0") + ":00",
    powerKw: i.powerKw,
    soc: i.socAfterPercent,
    price: i.priceCentsPerKwh,
  }));

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">V2G Optimizer</h1>
          <p className="text-muted-foreground">
            Departure-aware charge/discharge scheduling against real market prices or the trained ML forecast.
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <CalendarClock className="h-4 w-4" /> Plan a schedule
              </CardTitle>
              <CardDescription>Charging is shifted to the cheapest real price hours</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Battery / EV asset</Label>
                <Select value={evId} onValueChange={setEvId}>
                  <SelectTrigger><SelectValue placeholder="Select asset" /></SelectTrigger>
                  <SelectContent>
                    {batteries.map((b: any) => (
                      <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="departure">Departure time</Label>
                <Input id="departure" type="datetime-local" value={departure} onChange={(e) => setDeparture(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="target">Target SoC %</Label>
                  <Input id="target" type="number" min="0" max="100" value={targetSoc} onChange={(e) => setTargetSoc(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="start">Current SoC % (optional)</Label>
                  <Input id="start" type="number" min="0" max="100" value={startSoc} onChange={(e) => setStartSoc(e.target.value)} />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="cap">Battery capacity kWh (optional)</Label>
                <Input id="cap" type="number" min="0" step="0.1" value={capacityKwh} onChange={(e) => setCapacityKwh(e.target.value)} placeholder="Uses asset capacity if blank" />
              </div>
              <div className="flex items-center justify-between">
                <Label htmlFor="allowV2g">Allow V2G discharge (sell back)</Label>
                <Switch id="allowV2g" checked={allowV2g} onCheckedChange={setAllowV2g} />
              </div>
              <Button className="w-full" onClick={handlePlan} disabled={planMutation.isPending}>
                {planMutation.isPending ? "Computing…" : "Plan schedule"}
              </Button>
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">Plan result</CardTitle>
              <CardDescription>
                {plan?.scheduleAvailable
                  ? `Price source: ${String(plan.priceSource).replace(/_/g, " ")}`
                  : "Latest planning result"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!plan ? (
                <p className="text-sm text-muted-foreground py-10 text-center">
                  Plan a schedule to see the hourly charge/discharge profile and economics.
                </p>
              ) : !plan.scheduleAvailable ? (
                <div className="flex items-start gap-3 py-6 text-sm text-muted-foreground">
                  <AlertCircle className="h-5 w-5 mt-0.5" />
                  <p>
                    No schedule could be produced: {plan.reason ?? "no real price series available"}.
                    No estimated prices are substituted.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                    <div>
                      <p className="text-muted-foreground">Energy to charge</p>
                      <p className="font-medium">{plan.energyToChargeKwh?.toFixed(2) ?? "—"} kWh</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Expected cost</p>
                      <p className="font-medium">{fmtCents(plan.expectedCostCents)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">V2G revenue</p>
                      <p className="font-medium">{fmtCents(plan.expectedRevenueCents)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Savings vs naive</p>
                      <p className="font-medium">{fmtCents(plan.expectedSavingsCents)}</p>
                    </div>
                  </div>
                  {plan.maxReachableSocPercent != null &&
                    plan.targetSocPercent != null &&
                    plan.maxReachableSocPercent < plan.targetSocPercent && (
                      <p className="text-sm text-amber-600">
                        Note: maximum reachable SoC before departure is {plan.maxReachableSocPercent.toFixed(0)}%
                        (target {plan.targetSocPercent}%).
                      </p>
                    )}
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={intervals}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="hour" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} />
                      <Tooltip
                        formatter={(v: any, name) =>
                          name === "powerKw" ? [`${Number(v).toFixed(2)} kW`, "Power (+charge / −V2G)"] : v
                        }
                      />
                      <Bar dataKey="powerKw" radius={[3, 3, 0, 0]}>
                        {intervals.map((d: any, i: number) => (
                          <Cell key={i} fill={d.powerKw >= 0 ? "#6b9e78" : "#b0614f"} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                  <div className="flex gap-4 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-sm" style={{ background: "#6b9e78" }} /> charge</span>
                    <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-sm" style={{ background: "#b0614f" }} /> V2G discharge</span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">My schedules</CardTitle>
            <CardDescription>Newest first</CardDescription>
          </CardHeader>
          <CardContent>
            {schedules.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : !schedules.data || schedules.data.schedules.length === 0 ? (
              <p className="text-sm text-muted-foreground">No schedules planned yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>Departure</TableHead>
                    <TableHead>Target SoC</TableHead>
                    <TableHead>Price source</TableHead>
                    <TableHead>Expected cost</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {schedules.data.schedules.map((s: any) => (
                    <TableRow key={s.id}>
                      <TableCell>#{s.id}</TableCell>
                      <TableCell>{new Date(s.departureTime).toLocaleString()}</TableCell>
                      <TableCell>{(s.targetSocPercent / 100).toFixed(0)}%</TableCell>
                      <TableCell className="text-sm">{String(s.priceSource).replace(/_/g, " ")}</TableCell>
                      <TableCell>{fmtCents(s.expectedCostCents)}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            s.status === "active" ? "default" : s.status === "cancelled" ? "secondary" : "outline"
                          }
                        >
                          {s.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {(s.status === "draft" || s.status === "active") && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => cancelMutation.mutate({ scheduleId: s.id })}
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
