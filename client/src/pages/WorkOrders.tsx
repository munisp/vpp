import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
import { ClipboardList, Plus } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

type Status = "open" | "assigned" | "in_progress" | "done" | "verified" | "cancelled";
const STATUSES: Status[] = ["open", "assigned", "in_progress", "done", "verified", "cancelled"];
const PRIORITIES = ["low", "medium", "high", "critical"] as const;

/** Forward transitions enforced by the server; terminal states have none. */
const TRANSITIONS: Record<Status, Status[]> = {
  open: ["assigned", "cancelled"],
  assigned: ["in_progress", "cancelled"],
  in_progress: ["done"],
  done: ["verified"],
  verified: [],
  cancelled: [],
};

function statusVariant(s: Status): "default" | "secondary" | "destructive" | "outline" {
  if (s === "open") return "secondary";
  if (s === "cancelled") return "destructive";
  if (s === "verified") return "default";
  return "outline";
}

export default function WorkOrders() {
  const utils = trpc.useUtils();
  const { data: assetsData, isLoading: assetsLoading } = trpc.assets.list.useQuery();
  const assets = assetsData?.assets ?? [];

  const [statusFilter, setStatusFilter] = useState<Status | "all">("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);

  // Create form state
  const [cAssetId, setCAssetId] = useState<number | null>(null);
  const [cTitle, setCTitle] = useState("");
  const [cDescription, setCDescription] = useState("");
  const [cPriority, setCPriority] = useState<(typeof PRIORITIES)[number]>("medium");
  const [cAnomalyId, setCAnomalyId] = useState("");
  const [cNtlFlagId, setCNtlFlagId] = useState("");
  const [noteText, setNoteText] = useState("");

  const list = trpc.workOrders.list.useQuery(
    { status: statusFilter === "all" ? undefined : statusFilter, limit: 50 },
    { enabled: !assetsLoading }
  );

  const detail = trpc.workOrders.get.useQuery(
    { workOrderId: detailId! },
    { enabled: detailId !== null }
  );

  const createMutation = trpc.workOrders.create.useMutation({
    onSuccess: () => {
      toast.success("Work order created");
      setCreateOpen(false);
      setCTitle("");
      setCDescription("");
      setCAnomalyId("");
      setCNtlFlagId("");
      utils.workOrders.list.invalidate();
    },
    onError: (e) => toast.error(e.message || "Failed to create work order"),
  });

  const statusMutation = trpc.workOrders.updateStatus.useMutation({
    onSuccess: () => {
      toast.success("Status updated");
      utils.workOrders.list.invalidate();
      utils.workOrders.get.invalidate();
    },
    onError: (e) => toast.error(e.message || "Status update failed"),
  });

  const noteMutation = trpc.workOrders.addNote.useMutation({
    onSuccess: () => {
      toast.success("Note added");
      setNoteText("");
      utils.workOrders.get.invalidate();
    },
    onError: (e) => toast.error(e.message || "Failed to add note"),
  });

  const handleCreate = () => {
    if (!cAssetId) return toast.error("Select an asset");
    if (!cTitle.trim()) return toast.error("Enter a title");
    const anomaly = cAnomalyId.trim() ? Number(cAnomalyId) : undefined;
    const ntl = cNtlFlagId.trim() ? Number(cNtlFlagId) : undefined;
    if (anomaly !== undefined && (!Number.isInteger(anomaly) || anomaly <= 0)) {
      return toast.error("Anomaly score id must be a positive integer");
    }
    if (ntl !== undefined && (!Number.isInteger(ntl) || ntl <= 0)) {
      return toast.error("NTL flag id must be a positive integer");
    }
    createMutation.mutate({
      assetId: cAssetId,
      title: cTitle.trim(),
      description: cDescription.trim() || undefined,
      priority: cPriority,
      gridAnomalyScoreId: anomaly,
      ntlFlagId: ntl,
    });
  };

  const order = detail.data?.order;
  const events = detail.data?.events ?? [];
  const nextStatuses = order ? TRANSITIONS[order.status as Status] ?? [] : [];

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Work Orders</h1>
            <p className="text-muted-foreground">
              Asset-linked maintenance orders with an enforced status flow
              (open → assigned → in_progress → done → verified) and an append-only event log.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as Status | "all")}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s.replace("_", " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4 mr-2" /> New order
            </Button>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Orders</CardTitle>
            <CardDescription>{list.data ? `${list.data.count} order(s)` : "Loading…"}</CardDescription>
          </CardHeader>
          <CardContent>
            {list.isLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : list.error ? (
              <p className="text-sm text-muted-foreground">{list.error.message}</p>
            ) : !list.data || list.data.orders.length === 0 ? (
              <div className="flex items-center gap-3 py-6 text-muted-foreground text-sm">
                <ClipboardList className="h-5 w-5" />
                <p>No work orders{statusFilter !== "all" ? ` with status "${statusFilter}"` : ""}.</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Created</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Asset</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.data.orders.map((o: any) => (
                    <TableRow key={o.id}>
                      <TableCell>{new Date(o.createdAt).toLocaleString()}</TableCell>
                      <TableCell className="font-medium">{o.title}</TableCell>
                      <TableCell>#{o.assetId}</TableCell>
                      <TableCell>
                        <Badge variant={o.priority === "critical" || o.priority === "high" ? "destructive" : "outline"}>
                          {o.priority}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(o.status)}>{o.status.replace("_", " ")}</Badge>
                      </TableCell>
                      <TableCell>{o.dueAt ? new Date(o.dueAt).toLocaleDateString() : "—"}</TableCell>
                      <TableCell>
                        <Button variant="outline" size="sm" onClick={() => setDetailId(o.id)}>
                          Open
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

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New work order</DialogTitle>
            <DialogDescription>
              Optionally link a real grid anomaly score or NTL flag id — the reference is validated
              against the detection tables.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Asset</Label>
              <Select value={cAssetId !== null ? String(cAssetId) : undefined} onValueChange={(v) => setCAssetId(Number(v))}>
                <SelectTrigger>
                  <SelectValue placeholder="Select asset" />
                </SelectTrigger>
                <SelectContent>
                  {assets.map((a: any) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Title</Label>
              <Input value={cTitle} onChange={(e) => setCTitle(e.target.value)} maxLength={255} />
            </div>
            <div className="space-y-2">
              <Label>Priority</Label>
              <Select value={cPriority} onValueChange={(v) => setCPriority(v as (typeof PRIORITIES)[number])}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Description (optional)</Label>
              <Textarea value={cDescription} onChange={(e) => setCDescription(e.target.value)} maxLength={5000} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Grid anomaly score id (optional)</Label>
                <Input type="number" min={1} value={cAnomalyId} onChange={(e) => setCAnomalyId(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>NTL flag id (optional)</Label>
                <Input type="number" min={1} value={cNtlFlagId} onChange={(e) => setCNtlFlagId(e.target.value)} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={createMutation.isPending}>
              {createMutation.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail dialog */}
      <Dialog open={detailId !== null} onOpenChange={(open) => !open && setDetailId(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{order ? order.title : "Work order"}</DialogTitle>
            <DialogDescription>
              {order
                ? `Asset #${order.assetId} · created ${new Date(order.createdAt).toLocaleString()}`
                : "Loading…"}
            </DialogDescription>
          </DialogHeader>
          {detail.isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : detail.error ? (
            <p className="text-sm text-muted-foreground">{detail.error.message}</p>
          ) : order ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3 flex-wrap">
                <Badge variant={statusVariant(order.status)}>{order.status.replace("_", " ")}</Badge>
                <Badge variant="outline">{order.priority}</Badge>
                {order.assignedTo != null && (
                  <span className="text-sm text-muted-foreground">assigned to user #{order.assignedTo}</span>
                )}
                {order.gridAnomalyScoreId != null && (
                  <span className="text-sm text-muted-foreground">anomaly #{order.gridAnomalyScoreId}</span>
                )}
                {order.ntlFlagId != null && (
                  <span className="text-sm text-muted-foreground">NTL flag #{order.ntlFlagId}</span>
                )}
              </div>
              {order.description && <p className="text-sm">{order.description}</p>}

              {nextStatuses.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-muted-foreground">Transition to:</span>
                  {nextStatuses.map((s) => (
                    <Button
                      key={s}
                      variant={s === "cancelled" ? "destructive" : "outline"}
                      size="sm"
                      disabled={statusMutation.isPending}
                      onClick={() => statusMutation.mutate({ workOrderId: order.id, toStatus: s })}
                    >
                      {s.replace("_", " ")}
                    </Button>
                  ))}
                </div>
              )}

              <div>
                <p className="text-sm font-medium mb-2">Event timeline</p>
                {events.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No events.</p>
                ) : (
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {events.map((e: any) => (
                      <div key={e.id} className="flex items-start gap-3 text-sm border-l-2 border-muted pl-3">
                        <div>
                          <p>
                            <span className="font-medium">{e.eventType.replace("_", " ")}</span>
                            {e.fromStatus || e.toStatus
                              ? ` · ${e.fromStatus ?? "—"} → ${e.toStatus ?? "—"}`
                              : ""}
                          </p>
                          {e.note && <p className="text-muted-foreground">{e.note}</p>}
                          <p className="text-xs text-muted-foreground">
                            {new Date(e.createdAt).toLocaleString()} · user #{e.actorUserId}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex gap-2">
                <Input
                  placeholder="Add a note…"
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  maxLength={2000}
                />
                <Button
                  variant="outline"
                  disabled={noteMutation.isPending || !noteText.trim()}
                  onClick={() => noteMutation.mutate({ workOrderId: order.id, note: noteText.trim() })}
                >
                  Add note
                </Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
