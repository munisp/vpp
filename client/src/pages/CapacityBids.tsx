import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { Gavel } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

function fmtW(w: number | null | undefined): string {
  if (w === null || w === undefined) return "—";
  return w >= 1000 ? `${(w / 1000).toFixed(2)} kW` : `${w} W`;
}

const UNAVAILABLE_LABELS: Record<string, string> = {
  no_flexible_assets: "no registered battery or generator assets",
  unknown_capacity: "flexible capacity unknown for at least one asset",
};

export default function CapacityBids() {
  const utils = trpc.useUtils();

  const [deliveryStart, setDeliveryStart] = useState("");
  const [deliveryEnd, setDeliveryEnd] = useState("");
  const [price, setPrice] = useState("");

  const bids = trpc.capacityBids.listBids.useQuery({ limit: 20 });

  const buildMutation = trpc.capacityBids.buildBid.useMutation({
    onSuccess: (bid) => {
      if (bid.bidAvailable) {
        toast.success(`Draft bid #${bid.id} built — offering ${fmtW(bid.offeredCapacityW)}`);
      } else {
        toast.info(
          `Draft bid #${bid.id} recorded as unavailable: ${
            UNAVAILABLE_LABELS[bid.unavailableReason ?? ""] ?? bid.unavailableReason ?? "unknown reason"
          }`
        );
      }
      utils.capacityBids.listBids.invalidate();
    },
    onError: (e) => toast.error(e.message || "Failed to build bid"),
  });

  const submitMutation = trpc.capacityBids.submitBid.useMutation({
    onSuccess: (bid) => {
      toast.success(`Bid #${bid.id} submitted`);
      utils.capacityBids.listBids.invalidate();
    },
    onError: (e) => toast.error(e.message || "Failed to submit bid"),
  });

  const withdrawMutation = trpc.capacityBids.withdrawBid.useMutation({
    onSuccess: (bid) => {
      toast.success(`Bid #${bid.id} withdrawn`);
      utils.capacityBids.listBids.invalidate();
    },
    onError: (e) => toast.error(e.message || "Failed to withdraw bid"),
  });

  const handleBuild = () => {
    if (!deliveryStart || !deliveryEnd) return toast.error("Choose a delivery window");
    const start = new Date(deliveryStart);
    const end = new Date(deliveryEnd);
    if (!(end > start)) return toast.error("Delivery end must be after start");
    const priceFloat = price.trim() === "" ? undefined : parseFloat(price);
    if (priceFloat !== undefined && (!Number.isFinite(priceFloat) || priceFloat < 0)) {
      return toast.error("Price must be a non-negative number");
    }
    buildMutation.mutate({
      deliveryStart: start,
      deliveryEnd: end,
      priceCentsPerKwh: priceFloat === undefined ? undefined : Math.round(priceFloat * 100),
    });
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Capacity Bids</h1>
          <p className="text-muted-foreground">
            Bids are built from your real registered flexible capacity minus real recorded
            commitments. When capacity cannot be established the bid is recorded as unavailable and
            cannot be submitted — never built on assumed numbers.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Gavel className="h-4 w-4" /> Build a bid
            </CardTitle>
            <CardDescription>
              Creates a draft for a delivery window from your registered battery / generator capacity
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="cbStart">Delivery start</Label>
                <Input
                  id="cbStart"
                  type="datetime-local"
                  value={deliveryStart}
                  onChange={(e) => setDeliveryStart(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cbEnd">Delivery end</Label>
                <Input
                  id="cbEnd"
                  type="datetime-local"
                  value={deliveryEnd}
                  onChange={(e) => setDeliveryEnd(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cbPrice">Ask (per kWh, optional)</Label>
                <Input
                  id="cbPrice"
                  type="number"
                  min="0"
                  step="0.01"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="leave blank for no price"
                />
              </div>
            </div>
            <Button onClick={handleBuild} disabled={buildMutation.isPending}>
              {buildMutation.isPending ? "Building…" : "Build draft bid"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">My bids</CardTitle>
            <CardDescription>draft → submitted → awarded/rejected (recorded by an operator)</CardDescription>
          </CardHeader>
          <CardContent>
            {bids.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : bids.error ? (
              <p className="text-sm text-muted-foreground">{bids.error.message}</p>
            ) : !bids.data || bids.data.bids.length === 0 ? (
              <p className="text-sm text-muted-foreground">No bids yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Bid</TableHead>
                    <TableHead>Delivery window</TableHead>
                    <TableHead>Known</TableHead>
                    <TableHead>Committed</TableHead>
                    <TableHead>Offered</TableHead>
                    <TableHead>Ask</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bids.data.bids.map((b: any) => (
                    <TableRow key={b.id}>
                      <TableCell className="text-sm text-muted-foreground">#{b.id}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(b.deliveryStart).toLocaleString()} –{" "}
                        {new Date(b.deliveryEnd).toLocaleString()}
                      </TableCell>
                      <TableCell>{fmtW(b.knownCapacityW)}</TableCell>
                      <TableCell>{fmtW(b.committedCapacityW)}</TableCell>
                      <TableCell className="font-medium">{fmtW(b.offeredCapacityW)}</TableCell>
                      <TableCell className="text-sm">
                        {b.priceCentsPerKwh !== null && b.priceCentsPerKwh !== undefined
                          ? `${(b.priceCentsPerKwh / 100).toFixed(2)}/kWh`
                          : "—"}
                      </TableCell>
                      <TableCell>
                        {b.bidAvailable === false ? (
                          <span className="text-sm text-muted-foreground">
                            <Badge variant="destructive">unavailable</Badge>{" "}
                            {UNAVAILABLE_LABELS[b.unavailableReason ?? ""] ??
                              b.unavailableReason ??
                              "reason not recorded"}
                          </span>
                        ) : (
                          <Badge
                            variant={
                              b.status === "awarded"
                                ? "default"
                                : b.status === "rejected" || b.status === "withdrawn"
                                  ? "outline"
                                  : "secondary"
                            }
                          >
                            {b.status}
                          </Badge>
                        )}
                        {b.outcomeNote && (
                          <p className="text-xs text-muted-foreground mt-1 max-w-48">{b.outcomeNote}</p>
                        )}
                      </TableCell>
                      <TableCell className="text-right space-x-2">
                        {b.status === "draft" && b.bidAvailable && (b.offeredCapacityW ?? 0) > 0 && (
                          <Button
                            size="sm"
                            onClick={() => submitMutation.mutate({ bidId: b.id })}
                            disabled={submitMutation.isPending}
                          >
                            Submit
                          </Button>
                        )}
                        {(b.status === "draft" || b.status === "submitted") && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => withdrawMutation.mutate({ bidId: b.id })}
                            disabled={withdrawMutation.isPending}
                          >
                            Withdraw
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
