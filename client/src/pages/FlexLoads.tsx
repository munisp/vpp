import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Zap } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

function fmtCents(c: number | null | undefined): string {
  if (c === null || c === undefined) return "—";
  return `$${(c / 100).toFixed(2)}`;
}

const ASSET_TYPE_LABELS: Record<string, string> = {
  solar: "Solar",
  battery: "Battery",
  meter: "Meter",
  generator: "Generator",
  wind: "Wind",
};

export default function FlexLoads() {
  const utils = trpc.useUtils();
  const { data: assetsData, isLoading: assetsLoading } = trpc.assets.list.useQuery();
  const assets = assetsData?.assets ?? [];

  const [enrollProgram, setEnrollProgram] = useState<any | null>(null);
  const [enrollAssetId, setEnrollAssetId] = useState<number | null>(null);

  const programs = trpc.flexLoads.listPrograms.useQuery({ includeRetired: false });
  const myEnrollments = trpc.flexLoads.myEnrollments.useQuery();

  const enrollMutation = trpc.flexLoads.enroll.useMutation({
    onSuccess: () => {
      toast.success("Asset enrolled");
      setEnrollProgram(null);
      setEnrollAssetId(null);
      utils.flexLoads.myEnrollments.invalidate();
    },
    onError: (e) => toast.error(e.message || "Enrollment failed"),
  });

  const statusMutation = trpc.flexLoads.setEnrollmentStatus.useMutation({
    onSuccess: () => {
      toast.success("Enrollment updated");
      utils.flexLoads.myEnrollments.invalidate();
    },
    onError: (e) => toast.error(e.message || "Update failed"),
  });

  const eligibleAssets = enrollProgram
    ? assets.filter((a: any) => a.assetType === enrollProgram.assetType)
    : [];

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Flexible Load Programs</h1>
          <p className="text-muted-foreground">
            Enroll your assets in flexible dispatch programs. Incentives are only shown when a real
            rate and a real recorded compensation exist — otherwise they stay "not yet determined".
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold mb-3">Programs</h2>
          {programs.isLoading || assetsLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : programs.error ? (
            <Card>
              <CardContent className="py-6 text-sm text-muted-foreground">{programs.error.message}</CardContent>
            </Card>
          ) : !programs.data || programs.data.programs.length === 0 ? (
            <Card>
              <CardContent className="flex items-center gap-3 py-10 text-muted-foreground">
                <Zap className="h-5 w-5" />
                <p>No flexible load programs are currently offered.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {programs.data.programs.map((p: any) => (
                <Card key={p.id}>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      {p.name}
                      <Badge variant={p.status === "active" ? "default" : "secondary"}>{p.status}</Badge>
                    </CardTitle>
                    <CardDescription>
                      {ASSET_TYPE_LABELS[p.assetType] ?? p.assetType} assets ·{" "}
                      {p.incentiveRateCentsPerKwh != null
                        ? `${(p.incentiveRateCentsPerKwh / 100).toFixed(2)} $/kWh incentive rate`
                        : "no incentive rate negotiated"}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {p.description && <p className="text-sm text-muted-foreground">{p.description}</p>}
                    {p.eventWindowRules && (
                      <p className="text-xs text-muted-foreground">
                        Window rules:{" "}
                        {[
                          p.eventWindowRules.maxEventsPerDay != null
                            ? `max ${p.eventWindowRules.maxEventsPerDay} event(s)/day`
                            : null,
                          p.eventWindowRules.windowStartHour != null &&
                          p.eventWindowRules.windowEndHour != null
                            ? `${p.eventWindowRules.windowStartHour}:00–${p.eventWindowRules.windowEndHour}:00 UTC`
                            : null,
                          p.eventWindowRules.maxEventMinutes != null
                            ? `max ${p.eventWindowRules.maxEventMinutes} min/event`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ") || "none"}
                      </p>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={p.status !== "active"}
                      onClick={() => { setEnrollProgram(p); setEnrollAssetId(null); }}
                    >
                      {p.status === "active" ? "Enroll an asset" : `Not enrollable (${p.status})`}
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">My enrollments</CardTitle>
            <CardDescription>
              {myEnrollments.data ? `${myEnrollments.data.count} enrollment(s)` : "Loading…"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {myEnrollments.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : myEnrollments.error ? (
              <p className="text-sm text-muted-foreground">{myEnrollments.error.message}</p>
            ) : !myEnrollments.data || myEnrollments.data.enrollments.length === 0 ? (
              <p className="text-sm text-muted-foreground">You have no enrollments yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Program</TableHead>
                    <TableHead>Asset</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Dispatched</TableHead>
                    <TableHead>Incentive</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {myEnrollments.data.enrollments.map((e: any) => (
                    <TableRow key={e.id}>
                      <TableCell>#{e.programId}</TableCell>
                      <TableCell>#{e.assetId}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            e.status === "active" ? "default" : e.status === "suspended" ? "secondary" : "outline"
                          }
                        >
                          {e.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {e.dispatchedAt
                          ? `${new Date(e.dispatchedAt).toLocaleString()} (event #${e.drEventId})`
                          : "never"}
                      </TableCell>
                      <TableCell>
                        {e.incentiveCents != null ? (
                          fmtCents(e.incentiveCents)
                        ) : (
                          <span className="text-muted-foreground">not yet determined</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          {e.status === "active" && (
                            <>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={statusMutation.isPending}
                                onClick={() => statusMutation.mutate({ enrollmentId: e.id, status: "suspended" })}
                              >
                                Suspend
                              </Button>
                              <Button
                                variant="destructive"
                                size="sm"
                                disabled={statusMutation.isPending}
                                onClick={() => statusMutation.mutate({ enrollmentId: e.id, status: "withdrawn" })}
                              >
                                Withdraw
                              </Button>
                            </>
                          )}
                          {e.status === "suspended" && (
                            <>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={statusMutation.isPending}
                                onClick={() => statusMutation.mutate({ enrollmentId: e.id, status: "active" })}
                              >
                                Reactivate
                              </Button>
                              <Button
                                variant="destructive"
                                size="sm"
                                disabled={statusMutation.isPending}
                                onClick={() => statusMutation.mutate({ enrollmentId: e.id, status: "withdrawn" })}
                              >
                                Withdraw
                              </Button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Enroll dialog */}
      <Dialog open={enrollProgram !== null} onOpenChange={(open) => !open && setEnrollProgram(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enroll in {enrollProgram?.name}</DialogTitle>
            <DialogDescription>
              Only your {ASSET_TYPE_LABELS[enrollProgram?.assetType ?? ""] ?? enrollProgram?.assetType}{" "}
              assets are eligible for this program.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Asset</Label>
            {eligibleAssets.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                You own no assets of the required type ({enrollProgram?.assetType}).
              </p>
            ) : (
              <Select
                value={enrollAssetId !== null ? String(enrollAssetId) : undefined}
                onValueChange={(v) => setEnrollAssetId(Number(v))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select asset" />
                </SelectTrigger>
                <SelectContent>
                  {eligibleAssets.map((a: any) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEnrollProgram(null)}>
              Cancel
            </Button>
            <Button
              disabled={enrollAssetId === null || enrollMutation.isPending}
              onClick={() =>
                enrollProgram && enrollAssetId !== null &&
                enrollMutation.mutate({ programId: enrollProgram.id, assetId: enrollAssetId })
              }
            >
              {enrollMutation.isPending ? "Enrolling…" : "Enroll"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
