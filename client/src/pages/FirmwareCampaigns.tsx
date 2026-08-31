import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
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
import { Cpu, Plus, RefreshCw } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { useAuth } from "@/_core/hooks/useAuth";

function campaignVariant(s: string): "default" | "secondary" | "destructive" | "outline" {
  if (s === "active") return "default";
  if (s === "cancelled") return "destructive";
  if (s === "draft" || s === "paused") return "secondary";
  return "outline";
}
function targetVariant(s: string): "default" | "secondary" | "destructive" | "outline" {
  if (s === "applied") return "default";
  if (s === "failed") return "destructive";
  if (s === "pending" || s === "excluded") return "secondary";
  return "outline";
}

export default function FirmwareCampaigns() {
  const utils = trpc.useUtils();
  const { user } = useAuth();
  // Firmware pushes change device behavior fleet-wide, so this surface is
  // admin-only: a member gets an explicit notice, and no campaign query is
  // ever fired on their behalf.
  const isAdmin = user?.role === "admin";
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [action, setAction] = useState<{ kind: "fail" | "exclude"; targetId: number } | null>(null);
  const [actionReason, setActionReason] = useState("");

  const [cName, setCName] = useState("");
  const [cModel, setCModel] = useState("");
  const [cFromVersion, setCFromVersion] = useState("");
  const [cTargetVersion, setCTargetVersion] = useState("");
  const [cNotes, setCNotes] = useState("");

  const list = trpc.firmwareCampaigns.list.useQuery({ limit: 50 }, { enabled: isAdmin });
  const progress = trpc.firmwareCampaigns.progress.useQuery(
    { campaignId: selectedId! },
    { enabled: isAdmin && selectedId !== null }
  );
  const targets = trpc.firmwareCampaigns.listTargets.useQuery(
    { campaignId: selectedId! },
    { enabled: isAdmin && selectedId !== null }
  );

  const invalidateAll = () => {
    utils.firmwareCampaigns.list.invalidate();
    utils.firmwareCampaigns.progress.invalidate();
    utils.firmwareCampaigns.listTargets.invalidate();
  };

  const createMutation = trpc.firmwareCampaigns.create.useMutation({
    onSuccess: (r) => {
      toast.success(`Campaign created with ${r.targetCount} target(s)`);
      setCreateOpen(false);
      setCName("");
      setCModel("");
      setCFromVersion("");
      setCTargetVersion("");
      setCNotes("");
      invalidateAll();
    },
    onError: (e) => toast.error(e.message || "Failed to create campaign"),
  });

  const startMutation = trpc.firmwareCampaigns.start.useMutation({
    onSuccess: () => { toast.success("Campaign started"); invalidateAll(); },
    onError: (e) => toast.error(e.message),
  });
  const pauseMutation = trpc.firmwareCampaigns.pause.useMutation({
    onSuccess: () => { toast.success("Campaign paused"); invalidateAll(); },
    onError: (e) => toast.error(e.message),
  });
  const cancelMutation = trpc.firmwareCampaigns.cancel.useMutation({
    onSuccess: () => { toast.success("Campaign cancelled"); invalidateAll(); },
    onError: (e) => toast.error(e.message),
  });
  const reconcileMutation = trpc.firmwareCampaigns.reconcile.useMutation({
    onSuccess: (r) => {
      toast.success(`Reconciled: ${r.updated} target(s) updated, ${r.applied} applied`);
      invalidateAll();
    },
    onError: (e) => toast.error(e.message),
  });
  const failMutation = trpc.firmwareCampaigns.markTargetFailed.useMutation({
    onSuccess: () => { toast.success("Target marked failed"); setAction(null); setActionReason(""); invalidateAll(); },
    onError: (e) => toast.error(e.message),
  });
  const excludeMutation = trpc.firmwareCampaigns.excludeTarget.useMutation({
    onSuccess: () => { toast.success("Target excluded"); setAction(null); setActionReason(""); invalidateAll(); },
    onError: (e) => toast.error(e.message),
  });

  const handleCreate = () => {
    if (!cName.trim()) return toast.error("Enter a campaign name");
    if (!cTargetVersion.trim()) return toast.error("Enter the target version");
    createMutation.mutate({
      name: cName.trim(),
      targetVersion: cTargetVersion.trim(),
      model: cModel.trim() || undefined,
      fromVersion: cFromVersion.trim() || undefined,
      notes: cNotes.trim() || undefined,
    });
  };

  const submitAction = () => {
    if (!action || !actionReason.trim()) return toast.error("A reason is required");
    if (action.kind === "fail") failMutation.mutate({ targetId: action.targetId, reason: actionReason.trim() });
    else excludeMutation.mutate({ targetId: action.targetId, reason: actionReason.trim() });
  };

  const selected = list.data?.campaigns.find((c: any) => c.id === selectedId) ?? null;
  const p = progress.data;

  if (!isAdmin) {
    return (
      <DashboardLayout>
        <div className="p-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Cpu className="h-5 w-5" /> Firmware Campaigns
              </CardTitle>
              <CardDescription>
                Firmware rollout management is restricted to fleet administrators.
              </CardDescription>
            </CardHeader>
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
            <h1 className="text-2xl font-bold tracking-tight">Firmware Campaigns</h1>
            <p className="text-muted-foreground">
              Fleet firmware rollouts. A target counts as applied only when the device itself reports
              the expected version — the platform never marks it applied on its own.
            </p>
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 mr-2" /> New campaign
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Campaigns</CardTitle>
            <CardDescription>{list.data ? `${list.data.count} campaign(s)` : "Loading…"}</CardDescription>
          </CardHeader>
          <CardContent>
            {list.isLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : list.error ? (
              <p className="text-sm text-muted-foreground">{list.error.message}</p>
            ) : !list.data || list.data.campaigns.length === 0 ? (
              <div className="flex items-center gap-3 py-6 text-muted-foreground text-sm">
                <Cpu className="h-5 w-5" />
                <p>No firmware campaigns yet.</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Target version</TableHead>
                    <TableHead>Model filter</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.data.campaigns.map((c: any) => (
                    <TableRow key={c.id} className={c.id === selectedId ? "bg-muted/50" : ""}>
                      <TableCell className="font-medium">{c.name}</TableCell>
                      <TableCell>{c.targetVersion}</TableCell>
                      <TableCell>{c.model ?? "all models"}</TableCell>
                      <TableCell>
                        <Badge variant={campaignVariant(c.status)}>{c.status}</Badge>
                      </TableCell>
                      <TableCell>{new Date(c.createdAt).toLocaleDateString()}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1 flex-wrap">
                          <Button variant="outline" size="sm" onClick={() => setSelectedId(c.id)}>
                            View
                          </Button>
                          {(c.status === "draft" || c.status === "paused") && (
                            <Button variant="outline" size="sm" onClick={() => startMutation.mutate({ campaignId: c.id })}>
                              Start
                            </Button>
                          )}
                          {c.status === "active" && (
                            <Button variant="outline" size="sm" onClick={() => pauseMutation.mutate({ campaignId: c.id })}>
                              Pause
                            </Button>
                          )}
                          {c.status !== "completed" && c.status !== "cancelled" && (
                            <Button variant="destructive" size="sm" onClick={() => cancelMutation.mutate({ campaignId: c.id })}>
                              Cancel
                            </Button>
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

        {selected && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <CardTitle className="text-base">{selected.name} — progress</CardTitle>
                  <CardDescription>
                    Target version {selected.targetVersion}
                    {selected.fromVersion ? ` · upgrading from ${selected.fromVersion}` : ""}
                  </CardDescription>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => reconcileMutation.mutate({ campaignId: selected.id })}
                  disabled={reconcileMutation.isPending}
                >
                  <RefreshCw className={`h-4 w-4 mr-2 ${reconcileMutation.isPending ? "animate-spin" : ""}`}
                  />
                  Reconcile device reports
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {progress.isLoading ? (
                <Skeleton className="h-16 w-full" />
              ) : p ? (
                <>
                  <div className="flex items-center gap-3">
                    <Progress value={p.appliedPct100 != null ? p.appliedPct100 / 100 : 0} className="flex-1" />
                    <span className="text-sm font-medium">
                      {p.appliedPct100 != null ? `${(p.appliedPct100 / 100).toFixed(0)}%` : "—"}
                    </span>
                  </div>
                  {p.appliedPct100 == null && (
                    <p className="text-xs text-muted-foreground">
                      No applicable targets — progress cannot be expressed as a percentage.
                    </p>
                  )}
                  <div className="flex gap-4 text-sm flex-wrap">
                    <span>total {p.total}</span>
                    <span>pending {p.pending}</span>
                    <span>offered {p.offered}</span>
                    <span className="text-green-600">applied {p.applied}</span>
                    <span className="text-red-600">failed {p.failed}</span>
                    <span className="text-muted-foreground">excluded {p.excluded}</span>
                  </div>
                </>
              ) : null}

              {targets.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : targets.error ? (
                <p className="text-sm text-muted-foreground">{targets.error.message}</p>
              ) : !targets.data || targets.data.targets.length === 0 ? (
                <p className="text-sm text-muted-foreground">No targets in this campaign.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Device</TableHead>
                      <TableHead>Asset</TableHead>
                      <TableHead>Expected</TableHead>
                      <TableHead>Reported</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {targets.data.targets.map((t: any) => (
                      <TableRow key={t.id}>
                        <TableCell>#{t.deviceId}</TableCell>
                        <TableCell>#{t.assetId}</TableCell>
                        <TableCell>{t.expectedVersion}</TableCell>
                        <TableCell>
                          {t.reportedVersion ?? <span className="text-muted-foreground">not reported</span>}
                        </TableCell>
                        <TableCell>
                          <Badge variant={targetVariant(t.status)}>{t.status}</Badge>
                        </TableCell>
                        <TableCell className="max-w-48 truncate" title={t.statusReason ?? ""}>
                          {t.statusReason ?? "—"}
                        </TableCell>
                        <TableCell>
                          {(t.status === "pending" || t.status === "offered" || t.status === "failed") && (
                            <div className="flex gap-1">
                              {t.status !== "failed" && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => { setAction({ kind: "fail", targetId: t.id }); setActionReason(""); }}
                                >
                                  Fail
                                </Button>
                              )}
                              {t.status !== "failed" && t.status !== "excluded" && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => { setAction({ kind: "exclude", targetId: t.id }); setActionReason(""); }}
                                >
                                  Exclude
                                </Button>
                              )}
                            </div>
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

      {/* Create campaign dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New firmware campaign</DialogTitle>
            <DialogDescription>
              Targets are auto-selected from enabled devices matching the optional model/from-version
              filters.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={cName} onChange={(e) => setCName(e.target.value)} maxLength={255} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Model filter (optional)</Label>
                <Input value={cModel} onChange={(e) => setCModel(e.target.value)} maxLength={255} />
              </div>
              <div className="space-y-2">
                <Label>From version (optional)</Label>
                <Input value={cFromVersion} onChange={(e) => setCFromVersion(e.target.value)} maxLength={50} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Target version</Label>
              <Input value={cTargetVersion} onChange={(e) => setCTargetVersion(e.target.value)} maxLength={50} />
            </div>
            <div className="space-y-2">
              <Label>Notes (optional)</Label>
              <Textarea value={cNotes} onChange={(e) => setCNotes(e.target.value)} maxLength={5000} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={createMutation.isPending}>
              {createMutation.isPending ? "Creating…" : "Create campaign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Fail / exclude reason dialog */}
      <Dialog open={action !== null} onOpenChange={(open) => !open && setAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{action?.kind === "fail" ? "Mark target failed" : "Exclude target"}</DialogTitle>
            <DialogDescription>
              A human-recorded reason is required — the platform has no device error channel.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Reason</Label>
            <Textarea value={actionReason} onChange={(e) => setActionReason(e.target.value)} maxLength={2000} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAction(null)}>
              Cancel
            </Button>
            <Button onClick={submitAction} disabled={failMutation.isPending || excludeMutation.isPending}>
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
