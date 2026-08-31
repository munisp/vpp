import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { BatteryCharging, Unplug } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

function fmtHours(hoursX100: number | null | undefined): string {
  if (hoursX100 === null || hoursX100 === undefined) return "unavailable";
  return `${(hoursX100 / 100).toFixed(2)} h`;
}

function fmtW(w: number | null | undefined): string {
  if (w === null || w === undefined) return "—";
  return w >= 1000 ? `${(w / 1000).toFixed(2)} kW` : `${w} W`;
}

function fmtWh(wh: number | null | undefined): string {
  if (wh === null || wh === undefined) return "—";
  return wh >= 1000 ? `${(wh / 1000).toFixed(2)} kWh` : `${wh} Wh`;
}

export default function IslandMonitor() {
  const utils = trpc.useUtils();

  const assessments = trpc.islandMonitor.listAssessments.useQuery({ limit: 20 });

  const assessMutation = trpc.islandMonitor.assessNow.useMutation({
    onSuccess: (r) => {
      if (r.row.assessmentAvailable) {
        toast.success(`Assessed — autonomy ${fmtHours(r.row.autonomyHoursX100)}`);
      } else {
        toast.info(`Assessment recorded as unavailable: ${r.row.unavailableReason ?? "unknown reason"}`);
      }
      utils.islandMonitor.listAssessments.invalidate();
    },
    onError: (e) => toast.error(e.message || "Assessment failed"),
  });

  const latest = assessments.data?.assessments?.[0] ?? null;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Island-Mode Monitor</h1>
            <p className="text-muted-foreground">
              If the grid drops right now, how long does your registered storage keep you running?
              Computed from registered battery capacity, measured state of charge and measured
              demand — never from assumed values.
            </p>
          </div>
          <Button onClick={() => assessMutation.mutate()} disabled={assessMutation.isPending}>
            <Unplug className="h-4 w-4 mr-2" />
            {assessMutation.isPending ? "Assessing…" : "Assess now"}
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <BatteryCharging className="h-4 w-4" /> Latest assessment
            </CardTitle>
            <CardDescription>
              {latest ? `Assessed ${new Date(latest.assessedAt).toLocaleString()}` : "No assessment yet"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {assessments.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : assessments.error ? (
              <p className="text-sm text-muted-foreground">{assessments.error.message}</p>
            ) : !latest ? (
              <p className="text-sm text-muted-foreground">
                Run an assessment to see your current ride-through autonomy.
              </p>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center gap-3 flex-wrap">
                  <p className="text-4xl font-bold">{fmtHours(latest.autonomyHoursX100)}</p>
                  {latest.assessmentAvailable ? (
                    <Badge variant="outline">
                      {latest.autonomyBasis === "measured" ? "measured" : "partial"} basis
                    </Badge>
                  ) : (
                    <Badge variant="destructive">unavailable</Badge>
                  )}
                </div>
                {!latest.assessmentAvailable && (
                  <p className="text-sm text-muted-foreground">
                    Reason: {latest.unavailableReason ?? "not recorded"}
                  </p>
                )}
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 text-sm">
                  <div>
                    <p className="text-muted-foreground">Net drain on storage</p>
                    <p className="font-medium">{fmtW(latest.netDrainWatts)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Usable stored energy</p>
                    <p className="font-medium">{fmtWh(latest.usableEnergyWh)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Batteries assessed / registered</p>
                    <p className="font-medium">
                      {latest.assessedBatteries ?? "—"} / {latest.registeredBatteries ?? "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Telemetry staleness bound</p>
                    <p className="font-medium">
                      {latest.telemetryStalenessMinutes != null
                        ? `${latest.telemetryStalenessMinutes} min`
                        : "—"}
                    </p>
                  </div>
                </div>
                {Array.isArray(latest.limitations) && latest.limitations.length > 0 && (
                  <div>
                    <p className="text-sm font-medium mb-1">Limitations</p>
                    <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-0.5">
                      {latest.limitations.map((l: string, i: number) => (
                        <li key={i}>{l}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {latest.eventDetection === "unavailable" && (
                  <p className="text-sm text-muted-foreground">
                    Island event detection: unavailable —{" "}
                    {latest.eventDetectionReason ?? "no per-site grid-status telemetry field"}.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Assessment history</CardTitle>
            <CardDescription>Each row is what the platform could honestly say at that moment</CardDescription>
          </CardHeader>
          <CardContent>
            {assessments.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : !assessments.data || assessments.data.assessments.length === 0 ? (
              <p className="text-sm text-muted-foreground">No assessments recorded yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Assessed at</TableHead>
                    <TableHead>Autonomy</TableHead>
                    <TableHead>Basis</TableHead>
                    <TableHead>Net drain</TableHead>
                    <TableHead>Usable energy</TableHead>
                    <TableHead>Note</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {assessments.data.assessments.map((a: any) => (
                    <TableRow key={a.id}>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(a.assessedAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="font-medium">{fmtHours(a.autonomyHoursX100)}</TableCell>
                      <TableCell className="text-sm">{a.assessmentAvailable ? a.autonomyBasis ?? "—" : "—"}</TableCell>
                      <TableCell>{fmtW(a.netDrainWatts)}</TableCell>
                      <TableCell>{fmtWh(a.usableEnergyWh)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-64">
                        {a.assessmentAvailable
                          ? Array.isArray(a.limitations) && a.limitations.length > 0
                            ? `${a.limitations.length} limitation(s)`
                            : "—"
                          : a.unavailableReason ?? "unavailable"}
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
