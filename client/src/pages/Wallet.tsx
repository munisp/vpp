import { useEffect, useState } from "react";
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
import { Wallet as WalletIcon, RefreshCw } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

type Method = "mpesa" | "airtel_money" | "tigo_pesa";

function fmtMoney(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

export default function Wallet() {
  const utils = trpc.useUtils();
  const wallet = trpc.energyWallet.getWallet.useQuery();
  const attempts = trpc.energyWallet.listTopUpAttempts.useQuery({ limit: 20 });

  const [threshold, setThreshold] = useState("");
  const [autoTopUp, setAutoTopUp] = useState(false);
  const [topUpAmount, setTopUpAmount] = useState("");
  const [method, setMethod] = useState<Method>("mpesa");
  const [phone, setPhone] = useState("");
  const [manualAmount, setManualAmount] = useState("");

  // Populate the settings form once wallet data arrives.
  useEffect(() => {
    const s = wallet.data?.settings;
    if (s) {
      setThreshold(s.lowBalanceThresholdCents != null ? (s.lowBalanceThresholdCents / 100).toString() : "");
      setAutoTopUp(!!s.autoTopUp);
      setTopUpAmount(s.topUpAmountCents != null ? (s.topUpAmountCents / 100).toString() : "");
      if (s.preferredMethod) setMethod(s.preferredMethod as Method);
      if (s.phoneNumber) setPhone(s.phoneNumber);
    }
  }, [wallet.data]);

  const saveMutation = trpc.energyWallet.updateWalletSettings.useMutation({
    onSuccess: () => {
      toast.success("Wallet settings saved");
      utils.energyWallet.getWallet.invalidate();
    },
    onError: (e) => toast.error(e.message || "Failed to save settings"),
  });

  const topUpMutation = trpc.energyWallet.requestTopUp.useMutation({
    onSuccess: (r) => {
      if (r.topUpInitiated) {
        toast.success(r.gatewayMessage || "Top-up initiated — approve it on your phone");
      } else {
        toast.info(r.reason || "Top-up not initiated");
      }
      utils.energyWallet.listTopUpAttempts.invalidate();
      utils.energyWallet.getWallet.invalidate();
    },
    onError: (e) => toast.error(e.message || "Top-up failed"),
  });

  const checkMutation = trpc.energyWallet.checkAutoTopUp.useMutation({
    onSuccess: (r) => {
      toast.info(r.topUpInitiated ? "Auto top-up initiated" : r.reason || "No top-up needed");
      utils.energyWallet.getWallet.invalidate();
      utils.energyWallet.listTopUpAttempts.invalidate();
    },
    onError: (e) => toast.error(e.message || "Auto top-up check failed"),
  });

  const w = wallet.data;

  const handleSave = () => {
    saveMutation.mutate({
      lowBalanceThresholdCents: threshold ? Math.round(parseFloat(threshold) * 100) : null,
      autoTopUp,
      topUpAmountCents: topUpAmount ? Math.round(parseFloat(topUpAmount) * 100) : null,
      preferredMethod: method,
      phoneNumber: phone || null,
    });
  };

  const handleManualTopUp = () => {
    const amt = parseFloat(manualAmount);
    if (!amt || amt <= 0) return toast.error("Enter a positive amount");
    if (!phone || phone.length < 9) return toast.error("Enter a valid phone number");
    topUpMutation.mutate({ amountCents: Math.round(amt * 100), method, phoneNumber: phone });
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Energy Wallet</h1>
          <p className="text-muted-foreground">
            Balance derived from your real payments/billing ledger on every read.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <WalletIcon className="h-4 w-4" /> Balance
              </CardTitle>
              <CardDescription>
                {w?.snapshot?.computedAt ? `Computed ${new Date(w.snapshot.computedAt).toLocaleString()}` : "Live from the ledger"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {wallet.isLoading ? (
                <Skeleton className="h-20 w-full" />
              ) : wallet.error ? (
                <p className="text-sm text-muted-foreground">{wallet.error.message}</p>
              ) : w ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <p className="text-4xl font-bold">{fmtMoney(w.balanceCents)}</p>
                    {w.belowThreshold === true && <Badge variant="destructive">below threshold</Badge>}
                    {w.belowThreshold === false && <Badge variant="outline">healthy</Badge>}
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-sm text-muted-foreground">
                    <div>
                      <p>Payments in</p>
                      <p className="text-foreground font-medium">{fmtMoney(w.ledger.paymentsCompletedCents)}</p>
                    </div>
                    <div>
                      <p>Bills issued</p>
                      <p className="text-foreground font-medium">{fmtMoney(w.ledger.billingsIssuedCents)}</p>
                    </div>
                    <div>
                      <p>Token purchases</p>
                      <p className="text-foreground font-medium">{fmtMoney(w.ledger.tokenPurchasesCents)}</p>
                    </div>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Top up now</CardTitle>
              <CardDescription>Initiates a real mobile-money payment request</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="manualAmount">Amount ($)</Label>
                  <Input id="manualAmount" type="number" min="0" step="0.01" value={manualAmount} onChange={(e) => setManualAmount(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Method</Label>
                  <Select value={method} onValueChange={(v) => setMethod(v as Method)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mpesa">M-Pesa</SelectItem>
                      <SelectItem value="airtel_money">Airtel Money</SelectItem>
                      <SelectItem value="tigo_pesa">Tigo Pesa</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="phone">Phone number</Label>
                <Input id="phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="e.g. 2547XXXXXXXX" />
              </div>
              <div className="flex gap-2">
                <Button onClick={handleManualTopUp} disabled={topUpMutation.isPending}>
                  {topUpMutation.isPending ? "Initiating…" : "Top up"}
                </Button>
                <Button variant="outline" onClick={() => checkMutation.mutate()} disabled={checkMutation.isPending}>
                  <RefreshCw className="h-4 w-4 mr-2" /> Run auto top-up check
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Auto top-up settings</CardTitle>
            <CardDescription>Top up automatically when the balance drops below a threshold</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="threshold">Low-balance threshold ($)</Label>
                <Input id="threshold" type="number" min="0" step="0.01" value={threshold} onChange={(e) => setThreshold(e.target.value)} placeholder="Leave blank to disable threshold" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="topUpAmount">Auto top-up amount ($)</Label>
                <Input id="topUpAmount" type="number" min="0" step="0.01" value={topUpAmount} onChange={(e) => setTopUpAmount(e.target.value)} />
              </div>
            </div>
            <div className="flex items-center justify-between max-w-md">
              <Label htmlFor="autoTopUp">Enable auto top-up</Label>
              <Switch id="autoTopUp" checked={autoTopUp} onCheckedChange={setAutoTopUp} />
            </div>
            <Button onClick={handleSave} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? "Saving…" : "Save settings"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top-up attempts</CardTitle>
            <CardDescription>Statuses are reconciled against the payment gateway</CardDescription>
          </CardHeader>
          <CardContent>
            {attempts.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : !attempts.data || attempts.data.attempts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No top-up attempts yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead>Trigger</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {attempts.data.attempts.map((a: any) => (
                    <TableRow key={a.id}>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(a.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell>{fmtMoney(a.amountCents)}</TableCell>
                      <TableCell className="text-sm">{String(a.method).replace(/_/g, " ")}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{a.triggerType}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            a.status === "completed" ? "default" : a.status === "failed" ? "destructive" : "secondary"
                          }
                        >
                          {a.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-48 truncate">
                        {a.errorMessage ?? "—"}
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
