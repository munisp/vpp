import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { AlertTriangle, ScanSearch } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

type StatusFilter = "all" | "open" | "acknowledged" | "resolved";

const FAULT_LABELS: Record<string, string> = {
  zero_output_daylight: "Zero output in daylight",
  error_code_reported: "Inverter error code",
  sustained_underperformance: "Sustained underperformance",
};

/** Short, honest summary of the recorded evidence — only facts the detector stored. */
function evidenceSummary(evidence: any): string {
  if (!evidence || typeof evidence !== "object") return "—";
  if (Array.isArray(evidence.recentMessages) && evidence.recentMessages.length > 0) {
    const count = typeof evidence.errorCount === "number" ? `${evidence.errorCount} error(s): ` : "";
    return `${count}${String(evidence.recentMessages[0])}`;
  }
  if (Array.isArray(evidence.days) && evidence.days.length > 0) {
    const d = evidence.days[0];
    const expected = typeof d.expectedClearSkyWh === "number" ? ` (clear-sky expectation ${Math.round(d.expectedClearSkyWh)} Wh)` : "";
    return `${evidence.days.length} day(s) with zero output${expected}`;
  }
  if (typeof evidence.recentPerformanceRatio === "number") {
    const threshold = typeof evidence.learnedThreshold === "number" ? `, learned threshold ${evidence.learnedThreshold}` : "";
    return `recent PR ${evidence.recentPerformanceRatio}${threshold}`;
  }
  return "—";
}

export default function InverterFaults() {
  const utils = trpc.useUtils();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [scanAssetId, setScanAssetId] = useState<string>("");
  const [resolveTarget, setResolveTarget] = useState<any | null>(null);
  const [resolveNote, setResolveNote] = useState("");

  const assetsQ = trpc.assets.list.useQuery();
  const solarAssets = useMemo(
    () => (assetsQ.data?.assets ?? []).filter((a: any) => a.assetType === "solar"),
    [assetsQ.data]
  );
  const assetName = useMemo(() => {
    const map = new Map<number, string>();
    for (const a of assetsQ.data?.assets ?? []) map.set(a.id, a.name);
    return map;
  }, [assetsQ.data]);

  const faults = trpc.inverterFaults.list.useQuery({
    limit: 50,
    status: statusFilter === "all" ? undefined : statusFilter,
  });

  const reportOutcome = (outcomes: any[]) => {
    const raised = outcomes.reduce((n, o) => n + (o.raised?.length ?? 0), 0);
    const skippedReasons = outcomes.flatMap((o) => o.skipped ?? []);
    if (raised > 0) {
      toast.warning(`${raised} new fault(s) detected`);
    } else if (outcomes.length === 0) {
      toast.info("No solar assets to scan");
    } else {
      toast.info(
        skippedReasons.length > 0
          ? `No faults detected — checks ran with ${skippedReasons.length} rule(s) skipped (insufficient evidence or no new findings)`
          : "No faults detected"
      );
    }
    utils.inverterFaults.list.invalidate();
  };

  const detectAllMutation = trpc.inverterFaults.detectForMe.useMutation({
    onSuccess: (outcomes) => reportOutcome(outcomes),
    onError: (e) => toast.error(e.message || "Fault detection failed"),
  });

  const detectAssetMutation = trpc.inverterFaults.detectForAsset.useMutation({
    onSuccess: (outcome) => reportOutcome([outcome]),
    onError: (e) => toast.error(e.message || "Fault detection failed"),
  });

  const ackMutation = trpc.inverterFaults.acknowledge.useMutation({
    onSuccess: () => {
      toast.success("Fault acknowledged");
      utils.inverterFaults.list.invalidate();
    },
    onError: (e) => toast.error(e.message || "Failed to acknowledge fault"),
  });

  const resolveMutation = trpc.inverterFaults.resolve.useMutation({
    onSuccess: () => {
      toast.success("Fault resolved");
      setResolveTarget(null);
      setResolveNote("");
      utils.inverterFaults.list.invalidate();
    },
    onError: (e) => toast.error(e.message || "Failed to resolve fault"),
  });

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Inverter Faults</h1>
            <p className="text-muted-foreground">
              Faults detected from real telemetry and device logs only. Rules with insufficient
              evidence stay silent instead of guessing.
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => detectAllMutation.mutate()}
            disabled={detectAllMutation.isPending}
          >
            <ScanSearch className="h-4 w-4 mr-2" />
            {detectAllMutation.isPending ? "Scanning…" : "Scan all my solar assets"}
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Scan one asset</CardTitle>
            <CardDescription>Run all detection rules against a single solar asset</CardDescription>
          </CardHeader>
          <CardContent className="flex items-end gap-3 flex-wrap">
            <div className="space-y-2 min-w-56">
              <Label>Solar asset</Label>
              <Select value={scanAssetId} onValueChange={setScanAssetId}>
                <SelectTrigger>
                  <SelectValue placeholder={assetsQ.isLoading ? "Loading assets…" : "Choose an asset"} />
                </SelectTrigger>
                <SelectContent>
                  {solarAssets.map((a: any) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!assetsQ.isLoading && solarAssets.length === 0 && (
                <p className="text-sm text-muted-foreground">No solar assets registered.</p>
              )}
            </div>
            <Button
              onClick={() => detectAssetMutation.mutate({ assetId: parseInt(scanAssetId, 10) })}
              disabled={!scanAssetId || detectAssetMutation.isPending}
            >
              {detectAssetMutation.isPending ? "Scanning…" : "Run scan"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4" /> Detected faults
                </CardTitle>
                <CardDescription>Evidence is what the rule actually observed</CardDescription>
              </div>
              <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="acknowledged">Acknowledged</SelectItem>
                  <SelectItem value="resolved">Resolved</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent>
            {faults.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : faults.error ? (
              <p className="text-sm text-muted-foreground">{faults.error.message}</p>
            ) : !faults.data || faults.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No faults recorded. Run a scan to evaluate your solar assets against the detection
                rules.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Detected</TableHead>
                    <TableHead>Asset</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Evidence</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {faults.data.map((f: any) => (
                    <TableRow key={f.id}>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(f.detectedAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-sm">{assetName.get(f.assetId) ?? `#${f.assetId}`}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{FAULT_LABELS[f.faultType] ?? f.faultType}</Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-64">
                        <span className="line-clamp-2">{evidenceSummary(f.evidence)}</span>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            f.status === "open"
                              ? "destructive"
                              : f.status === "acknowledged"
                                ? "secondary"
                                : "default"
                          }
                        >
                          {f.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right space-x-2">
                        {f.status === "open" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => ackMutation.mutate({ faultId: f.id })}
                            disabled={ackMutation.isPending}
                          >
                            Acknowledge
                          </Button>
                        )}
                        {(f.status === "open" || f.status === "acknowledged") && (
                          <Button size="sm" variant="outline" onClick={() => setResolveTarget(f)}>
                            Resolve
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

        <Dialog open={resolveTarget !== null} onOpenChange={(open) => !open && setResolveTarget(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Resolve fault</DialogTitle>
              <DialogDescription>
                {resolveTarget
                  ? `${FAULT_LABELS[resolveTarget.faultType] ?? resolveTarget.faultType} on ${
                      assetName.get(resolveTarget.assetId) ?? `asset #${resolveTarget.assetId}`
                    }`
                  : ""}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="resolutionNote">Resolution note (optional)</Label>
              <Textarea
                id="resolutionNote"
                value={resolveNote}
                onChange={(e) => setResolveNote(e.target.value)}
                placeholder="e.g. cleaned panels, inverter restarted, error cleared"
                maxLength={2000}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setResolveTarget(null)}>
                Back
              </Button>
              <Button
                onClick={() =>
                  resolveTarget &&
                  resolveMutation.mutate({
                    faultId: resolveTarget.id,
                    note: resolveNote.trim() || undefined,
                  })
                }
                disabled={resolveMutation.isPending}
              >
                {resolveMutation.isPending ? "Resolving…" : "Mark resolved"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
