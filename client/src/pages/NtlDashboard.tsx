import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { ShieldAlert, Play } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

type NtlStatus = "suspected" | "under_review" | "confirmed" | "cleared";
const STATUSES: NtlStatus[] = ["suspected", "under_review", "confirmed", "cleared"];

function statusBadge(status: string) {
  if (status === "confirmed") return <Badge variant="destructive">confirmed</Badge>;
  if (status === "suspected") return <Badge variant="secondary">suspected</Badge>;
  if (status === "under_review") return <Badge variant="default">under review</Badge>;
  return <Badge variant="outline">cleared</Badge>;
}

function riskColor(score: number): string {
  if (score >= 70) return "text-red-700 dark:text-red-400";
  if (score >= 40) return "text-amber-600";
  return "text-green-700 dark:text-green-400";
}

export default function NtlDashboard() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [investigating, setInvestigating] = useState<any | null>(null);
  const [newStatus, setNewStatus] = useState<NtlStatus>("under_review");
  const [notes, setNotes] = useState("");
  const [riskAssetId, setRiskAssetId] = useState("");
  const [riskLookupId, setRiskLookupId] = useState<number | null>(null);

  const flags = trpc.ntlDetection.getFlags.useQuery(
    { status: statusFilter === "all" ? undefined : (statusFilter as NtlStatus), limit: 200 },
    { enabled: user?.role === "admin" }
  );
  const risk = trpc.ntlDetection.getAssetRiskScore.useQuery(
    { assetId: riskLookupId! },
    { enabled: riskLookupId !== null, retry: false }
  );

  const investigateMutation = trpc.ntlDetection.investigateFlag.useMutation({
    onSuccess: () => {
      toast.success("Flag updated");
      setInvestigating(null);
      setNotes("");
      utils.ntlDetection.getFlags.invalidate();
    },
    onError: (e) => toast.error(e.message || "Failed to update flag"),
  });

  const runMutation = trpc.ntlDetection.runAnalysis.useMutation({
    onSuccess: (r) => {
      if (r.scope === "fleet") {
        toast.success("Fleet analysis complete");
      } else {
        const res: any = r.result;
        toast.success(
          res.divergenceDetected
            ? `Analysis complete — divergence detected (risk ${res.riskScore}/100)`
            : `Analysis complete — no divergence (risk ${res.riskScore}/100)`
        );
      }
      utils.ntlDetection.getFlags.invalidate();
    },
    onError: (e) => toast.error(e.message || "Analysis failed"),
  });

  if (user?.role !== "admin") {
    return (
      <DashboardLayout>
        <div className="container py-8">
          <Card>
            <CardContent className="flex items-center justify-center py-12">
              <p className="text-muted-foreground">Admin access required</p>
            </CardContent>
          </Card>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <ShieldAlert className="h-6 w-6" /> NTL Detection
            </h1>
            <p className="text-muted-foreground">
              Non-technical-loss (theft/bypass) investigation queue. Human-in-the-loop workflow:
              suspected → under review → confirmed | cleared.
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => runMutation.mutate({})}
            disabled={runMutation.isPending}
          >
            <Play className="h-4 w-4 mr-2" />
            {runMutation.isPending ? "Analyzing…" : "Run fleet analysis"}
          </Button>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <CardTitle className="text-base">Flags queue</CardTitle>
                <CardDescription>{flags.data ? `${flags.data.count} flag(s)` : "Loading…"}</CardDescription>
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent>
            {flags.isLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : flags.error ? (
              <p className="text-sm text-muted-foreground">{flags.error.message}</p>
            ) : !flags.data || flags.data.flags.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">No flags match this filter.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Flag</TableHead>
                    <TableHead>Asset / User</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Risk</TableHead>
                    <TableHead>Window</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {flags.data.flags.map((f: any) => (
                    <TableRow key={f.id}>
                      <TableCell>#{f.id}</TableCell>
                      <TableCell className="text-sm">
                        asset #{f.assetId} · user #{f.userId}
                      </TableCell>
                      <TableCell className="text-sm">{String(f.flagType).replace(/_/g, " ")}</TableCell>
                      <TableCell>
                        <span className={`font-semibold ${riskColor(f.riskScore)}`}>{f.riskScore}/100</span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(f.windowStart).toLocaleDateString()} – {new Date(f.windowEnd).toLocaleDateString()}
                      </TableCell>
                      <TableCell>{statusBadge(f.status)}</TableCell>
                      <TableCell>
                        {f.status !== "confirmed" && f.status !== "cleared" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setInvestigating(f);
                              setNewStatus(f.status === "suspected" ? "under_review" : "confirmed");
                              setNotes(f.resolutionNotes ?? "");
                            }}
                          >
                            Investigate
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

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Asset risk score lookup</CardTitle>
            <CardDescription>Computed from real billed-vs-metered divergence and bypass signatures</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-end gap-2">
              <div className="space-y-2">
                <Label htmlFor="riskAsset">Asset ID</Label>
                <Input
                  id="riskAsset"
                  type="number"
                  min="1"
                  value={riskAssetId}
                  onChange={(e) => setRiskAssetId(e.target.value)}
                  className="w-40"
                />
              </div>
              <Button
                variant="outline"
                onClick={() => {
                  const id = parseInt(riskAssetId, 10);
                  if (!id) return toast.error("Enter a valid asset ID");
                  setRiskLookupId(id);
                }}
              >
                Lookup
              </Button>
            </div>
            {riskLookupId !== null && risk.isLoading && <Skeleton className="h-20 w-full" />}
            {riskLookupId !== null && risk.error && (
              <p className="text-sm text-muted-foreground">{risk.error.message}</p>
            )}
            {riskLookupId !== null && risk.data && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div>
                  <p className="text-muted-foreground">Risk score</p>
                  <p className={`text-xl font-bold ${riskColor(risk.data.riskScore)}`}>
                    {risk.data.riskScore}/100
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Divergence</p>
                  <p className="font-medium">{risk.data.divergenceDetected ? "detected" : "none"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Latest billed/metered ratio</p>
                  <p className="font-medium">
                    {risk.data.latestRatio != null ? risk.data.latestRatio.toFixed(2) : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Bypass signature</p>
                  <p className="font-medium">
                    {!risk.data.bypassSignature.evaluated
                      ? "not evaluated"
                      : risk.data.bypassSignature.detected
                        ? "detected"
                        : "none"}
                  </p>
                </div>
                {risk.data.insufficientHistory && (
                  <p className="col-span-full text-xs text-amber-600">
                    Insufficient billing/telemetry history for this asset — score is based on limited
                    real data ({risk.data.analyzedPeriods} period(s) analyzed).
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Dialog open={investigating !== null} onOpenChange={(open) => !open && setInvestigating(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Investigate flag #{investigating?.id}</DialogTitle>
              <DialogDescription>
                Transition the flag through the review workflow. Evidence is retained on the flag.
              </DialogDescription>
            </DialogHeader>
            {investigating && (
              <div className="space-y-4">
                <div className="text-sm space-y-1">
                  <p>
                    Asset #{investigating.assetId} · user #{investigating.userId} · risk{" "}
                    {investigating.riskScore}/100
                  </p>
                  <p className="text-muted-foreground">
                    Current status: {String(investigating.status).replace(/_/g, " ")}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label>New status</Label>
                  <Select value={newStatus} onValueChange={(v) => setNewStatus(v as NtlStatus)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="notes">Notes</Label>
                  <Textarea
                    id="notes"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Investigation notes…"
                    rows={4}
                  />
                </div>
              </div>
            )}
            <DialogFooter>
              <Button
                onClick={() =>
                  investigating &&
                  investigateMutation.mutate({
                    flagId: investigating.id,
                    newStatus,
                    notes: notes || undefined,
                  })
                }
                disabled={investigateMutation.isPending}
              >
                {investigateMutation.isPending ? "Saving…" : "Save transition"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
