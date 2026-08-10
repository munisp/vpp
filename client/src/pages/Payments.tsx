import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import { CheckCircle2, CreditCard, Plus, Smartphone, Zap } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";

export default function Payments() {
  const [isPaymentDialogOpen, setIsPaymentDialogOpen] = useState(false);
  const [isTokenDialogOpen, setIsTokenDialogOpen] = useState(false);
  const [paymentData, setPaymentData] = useState({
    amount: "",
    method: "mpesa" as "mpesa" | "airtel_money" | "tigo_pesa" | "bank_transfer" | "card",
    phoneNumber: "",
  });
  const [tokenData, setTokenData] = useState({
    amount: "",
    energyKwh: "",
  });

  const utils = trpc.useUtils();

  const { data: payments = [], isLoading: paymentsLoading } =
    trpc.payments.list.useQuery({ limit: 50 });
  const { data: tokens = [], isLoading: tokensLoading } =
    trpc.payments.listTokens.useQuery();
  const { data: balance, isLoading: balanceLoading } =
    trpc.payments.getBalance.useQuery();

  const createPaymentMutation = trpc.payments.initiate.useMutation({
    onSuccess: () => {
      toast.success("Payment initiated successfully!");
      setIsPaymentDialogOpen(false);
      setPaymentData({ amount: "", method: "mpesa", phoneNumber: "" });
      utils.payments.list.invalidate();
      utils.payments.getBalance.invalidate();
    },
    onError: (error: any) => {
      toast.error(error.message || "Failed to create payment");
    },
  });

  const purchaseTokenMutation = trpc.payments.initiate.useMutation({
    onSuccess: (data: any) => {
      // After payment is initiated, generate token
      if (data.payment) {
        toast.success("Token purchase initiated! Complete payment to receive your token.");
      }
      setIsTokenDialogOpen(false);
      setTokenData({ amount: "", energyKwh: "" });
      utils.payments.list.invalidate();
      utils.payments.listTokens.invalidate();
      utils.payments.getBalance.invalidate();
    },
    onError: (error: any) => {
      toast.error(error.message || "Failed to purchase token");
    },
  });

  const processPaymentWorkflowMutation = trpc.orchestrator.processPayment.useMutation({
    onSuccess: (data) => {
      toast.success("Payment workflow started!", {
        description: `Workflow ID: ${data.workflowId}`,
      });
    },
    onError: (error) => {
      toast.error(error.message || "Failed to start payment workflow");
    },
  });

  const handlePaymentSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createPaymentMutation.mutate({
      paymentType: "invoice",
      amount: Math.round(parseFloat(paymentData.amount) * 100), // Convert to cents
      paymentMethod: paymentData.method,
      phoneNumber: paymentData.phoneNumber || undefined,
    });
  };

  const handlePaymentWorkflow = () => {
    const amount = parseFloat(prompt("Enter payment amount:") || "0");
    const methodInput = prompt("Enter payment method (mpesa/airtel/tigo):");
    const method = methodInput as "mpesa" | "airtel" | "tigo";
    if (amount > 0 && method && ["mpesa", "airtel", "tigo"].includes(method)) {
      processPaymentWorkflowMutation.mutate({ amount, method });
    } else {
      toast.error("Invalid payment method. Use: mpesa, airtel, or tigo");
    }
  };

  const handleTokenPurchase = (e: React.FormEvent) => {
    e.preventDefault();
    purchaseTokenMutation.mutate({
      paymentType: "token_purchase",
      amount: Math.round(parseFloat(tokenData.amount) * 100), // Convert to cents
      paymentMethod: "mpesa",
      phoneNumber: paymentData.phoneNumber,
      energyKwh: parseInt(tokenData.energyKwh),
    });
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, { variant: "default" | "secondary" | "destructive" | "outline", label: string }> = {
      completed: { variant: "default", label: "Completed" },
      pending: { variant: "secondary", label: "Pending" },
      failed: { variant: "destructive", label: "Failed" },
      refunded: { variant: "secondary", label: "Refunded" },
      active: { variant: "default", label: "Active" },
      used: { variant: "secondary", label: "Used" },
      expired: { variant: "secondary", label: "Expired" },
      pending_issuance: { variant: "outline", label: "Pending issuance" },
    };
    const config = variants[status] || { variant: "secondary" as const, label: status };
    return <Badge variant={config.variant}>{config.label}</Badge>;
  };

  const getPaymentMethodIcon = (method: string) => {
    switch (method) {
      case "mpesa":
      case "airtel_money":
      case "tigo_pesa":
        return <Smartphone className="h-5 w-5" />;
      case "card":
        return <CreditCard className="h-5 w-5" />;
      default:
        return <CreditCard className="h-5 w-5" />;
    }
  };

  const getPaymentMethodLabel = (method: string) => {
    const labels: Record<string, string> = {
      mpesa: "M-Pesa",
      airtel_money: "Airtel Money",
      tigo_pesa: "Tigo Pesa",
      bank_transfer: "Bank Transfer",
      card: "Card",
    };
    return labels[method] || method;
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Payments</h1>
            <p className="text-muted-foreground mt-2">
              Manage your payment methods, transaction history, and prepaid tokens.
            </p>
          </div>
          <div className="flex gap-2">
            <Dialog open={isPaymentDialogOpen} onOpenChange={setIsPaymentDialogOpen}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  Make Payment
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Make a Payment</DialogTitle>
                  <DialogDescription>
                    Pay your outstanding invoices using your preferred payment method.
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={handlePaymentSubmit}>
                  <div className="grid gap-4 py-4">
                    <div className="grid gap-2">
                      <Label htmlFor="amount">Amount (TZS) *</Label>
                      <Input
                        id="amount"
                        type="number"
                        step="0.01"
                        value={paymentData.amount}
                        onChange={(e) => setPaymentData({ ...paymentData, amount: e.target.value })}
                        placeholder="e.g., 5000.00"
                        required
                      />
                    </div>

                    <div className="grid gap-2">
                      <Label htmlFor="method">Payment Method *</Label>
                      <Select
                        value={paymentData.method}
                        onValueChange={(value: any) => setPaymentData({ ...paymentData, method: value })}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="mpesa">M-Pesa</SelectItem>
                          <SelectItem value="airtel_money">Airtel Money</SelectItem>
                          <SelectItem value="tigo_pesa">Tigo Pesa</SelectItem>
                          <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                          <SelectItem value="card">Card</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {["mpesa", "airtel_money", "tigo_pesa"].includes(paymentData.method) && (
                      <div className="grid gap-2">
                        <Label htmlFor="phoneNumber">Phone Number *</Label>
                        <Input
                          id="phoneNumber"
                          type="tel"
                          value={paymentData.phoneNumber}
                          onChange={(e) => setPaymentData({ ...paymentData, phoneNumber: e.target.value })}
                          placeholder="e.g., +255123456789"
                          required
                        />
                      </div>
                    )}
                  </div>
                  <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => setIsPaymentDialogOpen(false)}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={createPaymentMutation.isPending}>
                      {createPaymentMutation.isPending ? "Processing..." : "Pay Now"}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>

            <Dialog open={isTokenDialogOpen} onOpenChange={setIsTokenDialogOpen}>
              <DialogTrigger asChild>
                <Button variant="outline">
                  <Zap className="mr-2 h-4 w-4" />
                  Buy Token
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Purchase Prepaid Token</DialogTitle>
                  <DialogDescription>
                    Buy electricity tokens for your prepaid meter.
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleTokenPurchase}>
                  <div className="grid gap-4 py-4">
                    <div className="grid gap-2">
                      <Label htmlFor="energyKwh">Energy (kWh) *</Label>
                      <Input
                        id="energyKwh"
                        type="number"
                        value={tokenData.energyKwh}
                        onChange={(e) => setTokenData({ ...tokenData, energyKwh: e.target.value })}
                        placeholder="e.g., 50"
                        required
                      />
                    </div>

                    <div className="grid gap-2">
                      <Label htmlFor="tokenAmount">Amount (TZS) *</Label>
                      <Input
                        id="tokenAmount"
                        type="number"
                        step="0.01"
                        value={tokenData.amount}
                        onChange={(e) => setTokenData({ ...tokenData, amount: e.target.value })}
                        placeholder="e.g., 10000.00"
                        required
                      />
                    </div>

                    <div className="grid gap-2">
                      <Label htmlFor="tokenPhone">Phone Number *</Label>
                      <Input
                        id="tokenPhone"
                        type="tel"
                        value={paymentData.phoneNumber}
                        onChange={(e) => setPaymentData({ ...paymentData, phoneNumber: e.target.value })}
                        placeholder="e.g., +255123456789"
                        required
                      />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => setIsTokenDialogOpen(false)}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={purchaseTokenMutation.isPending}>
                      {purchaseTokenMutation.isPending ? "Processing..." : "Purchase Token"}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        {/* Account Balance */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Account Balance</CardTitle>
            <CreditCard className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {balanceLoading ? (
              <Skeleton className="h-8 w-40" />
            ) : balance ? (
              <div className="space-y-1">
                <p className="text-2xl font-bold">
                  {(balance.balanceCents / 100).toFixed(2)} TZS
                </p>
                <p className="text-xs text-muted-foreground">
                  Total paid: {(balance.totalPaidCents / 100).toFixed(2)} TZS · Total billed:{" "}
                  {(balance.totalBilledCents / 100).toFixed(2)} TZS
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Balance unavailable</p>
            )}
          </CardContent>
        </Card>

        {/* Payment Methods */}
        <div className="grid gap-4 md:grid-cols-3">
          <Card className="border-2 border-green-200 bg-green-50/50">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">M-Pesa</CardTitle>
              <Smartphone className="h-4 w-4 text-green-600" />
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">Mobile money payment</p>
              <div className="flex items-center gap-2 mt-2">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                <span className="text-xs font-medium">Available</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Airtel Money</CardTitle>
              <Smartphone className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">Mobile money payment</p>
              <div className="flex items-center gap-2 mt-2">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                <span className="text-xs font-medium">Available</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Tigo Pesa</CardTitle>
              <Smartphone className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">Mobile money payment</p>
              <div className="flex items-center gap-2 mt-2">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                <span className="text-xs font-medium">Available</span>
              </div>
            </CardContent>
          </Card>
        </div>

        <Tabs defaultValue="history" className="space-y-4">
          <TabsList>
            <TabsTrigger value="history">Payment History</TabsTrigger>
            <TabsTrigger value="tokens">Prepaid Tokens</TabsTrigger>
          </TabsList>

          <TabsContent value="history" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Transaction History</CardTitle>
                <CardDescription>
                  View all your payment transactions
                </CardDescription>
              </CardHeader>
              <CardContent>
                {paymentsLoading ? (
                  <div className="space-y-4">
                    {[1, 2, 3].map((i) => (
                      <Skeleton key={i} className="h-16 w-full" />
                    ))}
                  </div>
                ) : payments.length === 0 ? (
                  <div className="text-center py-12">
                    <CreditCard className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                    <h3 className="text-lg font-semibold mb-2">No payments yet</h3>
                    <p className="text-sm text-muted-foreground mb-4">
                      Your payment history will appear here.
                    </p>
                    <Button onClick={() => setIsPaymentDialogOpen(true)}>
                      <Plus className="mr-2 h-4 w-4" />
                      Make Your First Payment
                    </Button>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead>Method</TableHead>
                        <TableHead>Amount</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Transaction ID</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {payments.map((payment: any) => (
                        <TableRow key={payment.id}>
                          <TableCell>{new Date(payment.createdAt).toLocaleString()}</TableCell>
                          <TableCell className="capitalize">{payment.description}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              {getPaymentMethodIcon(payment.paymentMethod)}
                              <span>{getPaymentMethodLabel(payment.paymentMethod)}</span>
                            </div>
                          </TableCell>
                          <TableCell className="font-semibold">
                            {(payment.amount / 100).toFixed(2)} {payment.currency}
                          </TableCell>
                          <TableCell>{getStatusBadge(payment.status)}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {payment.transactionId || "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="tokens" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Prepaid Tokens</CardTitle>
                <CardDescription>
                  View and manage your electricity tokens
                </CardDescription>
              </CardHeader>
              <CardContent>
                {tokensLoading ? (
                  <div className="space-y-4">
                    {[1, 2, 3].map((i) => (
                      <Skeleton key={i} className="h-16 w-full" />
                    ))}
                  </div>
                ) : tokens.length === 0 ? (
                  <div className="text-center py-12">
                    <Zap className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                    <h3 className="text-lg font-semibold mb-2">No tokens purchased</h3>
                    <p className="text-sm text-muted-foreground mb-4">
                      Purchase prepaid electricity tokens for your meter.
                    </p>
                    <Button onClick={() => setIsTokenDialogOpen(true)}>
                      <Zap className="mr-2 h-4 w-4" />
                      Buy Your First Token
                    </Button>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Token Code</TableHead>
                        <TableHead>Energy</TableHead>
                        <TableHead>Amount</TableHead>
                        <TableHead>Created</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {tokens.map((token: any) => (
                        <TableRow key={token.id}>
                          <TableCell className="font-mono font-semibold">
                            {token.token ?? (
                              <span className="font-sans font-normal text-muted-foreground">
                                Not yet vended
                              </span>
                            )}
                          </TableCell>
                          <TableCell>{token.energyKwh} kWh</TableCell>
                          <TableCell>{(token.amount / 100).toFixed(2)} TZS</TableCell>
                          <TableCell>{new Date(token.createdAt).toLocaleDateString()}</TableCell>
                          <TableCell>{getStatusBadge(token.status)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
