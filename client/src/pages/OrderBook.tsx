import { useState } from "react";
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
import { ArrowDownUp } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ReferenceLine } from "recharts";

function fmtWh(wh: number): string {
  return wh >= 1000 ? `${(wh / 1000).toFixed(2)} kWh` : `${wh} Wh`;
}

export default function OrderBook() {
  const utils = trpc.useUtils();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [energyKwh, setEnergyKwh] = useState("");
  const [price, setPrice] = useState("");

  const book = trpc.p2pMatching.getOrderBook.useQuery(undefined, { refetchInterval: 30000 });
  const myOrders = trpc.p2pMatching.getMyOrders.useQuery();
  const matches = trpc.p2pMatching.getMatches.useQuery({ limit: 50 });

  const submitMutation = trpc.p2pMatching.submitOrder.useMutation({
    onSuccess: (r) => {
      toast.success(
        r.status === "executed"
          ? `Order fully filled — ${fmtWh(r.filledEnergyWh)} matched across ${r.matches.length} trade(s)`
          : r.filledEnergyWh > 0
            ? `Partially filled: ${fmtWh(r.filledEnergyWh)} of ${fmtWh(r.requestedEnergyWh)} matched`
            : "Order placed on the book"
      );
      setEnergyKwh("");
      setPrice("");
      utils.p2pMatching.getOrderBook.invalidate();
      utils.p2pMatching.getMyOrders.invalidate();
      utils.p2pMatching.getMatches.invalidate();
    },
    onError: (e) => toast.error(e.message || "Failed to submit order"),
  });

  const handleSubmit = () => {
    const kwh = parseFloat(energyKwh);
    const p = parseInt(price, 10);
    if (!kwh || kwh <= 0) return toast.error("Enter a positive energy amount (kWh)");
    if (!p || p <= 0) return toast.error("Enter a positive price (cents/kWh)");
    submitMutation.mutate({ side, energyWh: Math.round(kwh * 1000), priceCentsPerKwh: p });
  };

  // Build a combined depth chart: bids (green, negative side) and asks (red).
  const bids = book.data?.bids ?? [];
  const asks = book.data?.asks ?? [];
  const depthData = [
    ...bids.map((b: any) => ({ price: b.priceCentsPerKwh, energyWh: b.energyWh, side: "bid" as const })),
    ...asks.map((a: any) => ({ price: a.priceCentsPerKwh, energyWh: a.energyWh, side: "ask" as const })),
  ].sort((a, b) => a.price - b.price);

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">P2P Order Book</h1>
          <p className="text-muted-foreground">
            Peer-to-peer energy matching with price-time priority. Orders rest until matched.
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <ArrowDownUp className="h-4 w-4" /> Market depth
              </CardTitle>
              <CardDescription>
                Aggregated unfilled energy per price level
                {book.data?.generatedAt ? ` · updated ${new Date(book.data.generatedAt).toLocaleTimeString()}` : ""}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {book.isLoading ? (
                <Skeleton className="h-64 w-full" />
              ) : depthData.length === 0 ? (
                <p className="text-sm text-muted-foreground py-10 text-center">
                  The order book is empty — there are no resting buy or sell orders.
                </p>
              ) : (
                <>
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={depthData}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="price" tick={{ fontSize: 11 }} tickFormatter={(v) => `${v}¢`} />
                      <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => (v >= 1000 ? `${v / 1000}k` : v)} />
                      <Tooltip
                        formatter={(v: any, _n, props: any) => [
                          fmtWh(Number(v)),
                          props.payload.side === "bid" ? "Bids" : "Asks",
                        ]}
                        labelFormatter={(l) => `${l}¢/kWh`}
                      />
                      <ReferenceLine x={asks[0]?.priceCentsPerKwh ?? 0} stroke="#999" strokeDasharray="3 3" />
                      <Bar dataKey="energyWh" radius={[4, 4, 0, 0]}>
                        {depthData.map((d, i) => (
                          <Cell key={i} fill={d.side === "bid" ? "#6b9e78" : "#b0614f"} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                  <div className="flex gap-4 mt-2 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-sm" style={{ background: "#6b9e78" }} /> bids (buy)</span>
                    <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-sm" style={{ background: "#b0614f" }} /> asks (sell)</span>
                    {asks[0] && bids[0] && (
                      <span>spread: {asks[0].priceCentsPerKwh - bids[0].priceCentsPerKwh}¢/kWh</span>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Submit order</CardTitle>
              <CardDescription>Matched immediately against the resting book</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Side</Label>
                <Select value={side} onValueChange={(v) => setSide(v as "buy" | "sell")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="buy">Buy</SelectItem>
                    <SelectItem value="sell">Sell</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="energy">Energy (kWh)</Label>
                <Input
                  id="energy"
                  type="number"
                  min="0"
                  step="0.1"
                  value={energyKwh}
                  onChange={(e) => setEnergyKwh(e.target.value)}
                  placeholder="e.g. 5"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="price">
                  Price (cents/kWh) — {side === "buy" ? "maximum you'll pay" : "minimum you'll accept"}
                </Label>
                <Input
                  id="price"
                  type="number"
                  min="1"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="e.g. 25"
                />
              </div>
              <Button className="w-full" onClick={handleSubmit} disabled={submitMutation.isPending}>
                {submitMutation.isPending ? "Submitting…" : `Submit ${side} order`}
              </Button>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">My open orders</CardTitle>
              <CardDescription>Resting orders with filled/remaining quantities</CardDescription>
            </CardHeader>
            <CardContent>
              {myOrders.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : !myOrders.data || myOrders.data.length === 0 ? (
                <p className="text-sm text-muted-foreground">You have no open orders.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Side</TableHead>
                      <TableHead>Price</TableHead>
                      <TableHead>Requested</TableHead>
                      <TableHead>Filled</TableHead>
                      <TableHead>Remaining</TableHead>
                      <TableHead>Placed</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {myOrders.data.map((o: any) => (
                      <TableRow key={o.id}>
                        <TableCell>
                          <Badge variant={o.tradeType === "p2p_buy" ? "default" : "secondary"}>
                            {o.tradeType === "p2p_buy" ? "buy" : "sell"}
                          </Badge>
                        </TableCell>
                        <TableCell>{o.price}¢</TableCell>
                        <TableCell>{fmtWh(o.energy)}</TableCell>
                        <TableCell>{fmtWh(o.filledEnergyWh ?? 0)}</TableCell>
                        <TableCell>{fmtWh(Math.max(0, o.energy - (o.filledEnergyWh ?? 0)))}</TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {new Date(o.createdAt).toLocaleString()}
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
              <CardTitle className="text-base">My matches</CardTitle>
              <CardDescription>Executions where you were buyer or seller</CardDescription>
            </CardHeader>
            <CardContent>
              {matches.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : !matches.data || matches.data.length === 0 ? (
                <p className="text-sm text-muted-foreground">No matches executed yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Executed</TableHead>
                      <TableHead>Energy</TableHead>
                      <TableHead>Price</TableHead>
                      <TableHead>Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {matches.data.map((m: any) => (
                      <TableRow key={m.id}>
                        <TableCell className="text-muted-foreground text-sm">
                          {new Date(m.executedAt).toLocaleString()}
                        </TableCell>
                        <TableCell>{fmtWh(m.energyWh)}</TableCell>
                        <TableCell>{m.priceCentsPerKwh}¢/kWh</TableCell>
                        <TableCell>${(m.totalAmountCents / 100).toFixed(2)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardLayout>
  );
}
