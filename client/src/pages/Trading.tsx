import DashboardLayout from "@/components/DashboardLayout";
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
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import { ArrowDownUp, CheckCircle2, Clock, Plus, TrendingUp, XCircle, Share2, Settings2 } from "lucide-react";
import { useLocation } from "wouter";
import { ShareButton } from "@/components/ShareButton";
import { useWebShare, shareTradeOpportunity } from "@/hooks/useWebShare";
import { useState } from "react";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

export default function Trading() {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [formData, setFormData] = useState({
    assetId: "",
    quantity: "",
    price: "",
    tradeType: "sell" as "sell" | "buy",
  });

  const utils = trpc.useUtils();
  const [, navigate] = useLocation();
  const { data: assetsData } = trpc.assets.list.useQuery();
  const assets = assetsData?.assets || [];

  const { data: tradesData, isLoading: tradesLoading } = trpc.trading.list.useQuery({ limit: 50 });
  const trades = tradesData?.trades || [];

  const { data: preferences, isLoading: preferencesLoading } = trpc.trading.getPreferences.useQuery();

  const createTradeMutation = trpc.trading.create.useMutation({
    onSuccess: () => {
      toast.success("Trade created successfully!");
      setIsDialogOpen(false);
      setFormData({
        assetId: "",
        quantity: "",
        price: "",
        tradeType: "sell",
      });
      utils.trading.list.invalidate();
    },
    onError: (error: any) => {
      toast.error(error.message || "Failed to create trade");
    },
  });

  const startManualTradeMutation = trpc.orchestrator.startManualTrade.useMutation({
    onSuccess: (data) => {
      toast.success("Manual trade workflow started!", {
        description: `Workflow ID: ${data.workflowId}`,
      });
      utils.trading.list.invalidate();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to start manual trade");
    },
  });

  const startP2PTradeMutation = trpc.orchestrator.startP2PTrade.useMutation({
    onSuccess: (data) => {
      toast.success("P2P trade workflow started!", {
        description: `Workflow ID: ${data.workflowId}`,
      });
      utils.trading.list.invalidate();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to start P2P trade");
    },
  });

  const updatePreferencesMutation = trpc.trading.updatePreferences.useMutation({
    onSuccess: () => {
      toast.success("Trading preferences updated!");
      utils.trading.getPreferences.invalidate();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to update preferences");
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const tradeTypeMap: Record<string, "export" | "import"> = {
      sell: "export",
      buy: "import",
    };
    createTradeMutation.mutate({
      tradeType: tradeTypeMap[formData.tradeType],
      tradingMode: "manual",
      energy: Math.round(parseFloat(formData.quantity) * 1000), // Convert kWh to Wh
      price: Math.round(parseFloat(formData.price) * 100), // Convert to cents
    });
  };

  const handleManualTradeWorkflow = () => {
    const amount = parseFloat(prompt("Enter amount (kWh):") || "0");
    const maxPrice = parseFloat(prompt("Enter max price per kWh:") || "0");
    if (amount > 0 && maxPrice > 0) {
      startManualTradeMutation.mutate({ amount, maxPrice });
    }
  };

  const handleP2PTradeWorkflow = () => {
    const buyerId = prompt("Enter buyer user ID:");
    const amount = parseFloat(prompt("Enter amount (kWh):") || "0");
    const price = parseFloat(prompt("Enter price per kWh:") || "0");
    if (buyerId && amount > 0 && price > 0) {
      startP2PTradeMutation.mutate({ buyerId, amount, price });
    }
  };

  const handlePreferenceToggle = (field: "autoTrading" | "p2pEnabled" | "communityTrading", value: boolean) => {
    const fieldMap: Record<typeof field, string> = {
      autoTrading: "tradingMode",
      p2pEnabled: "enableP2P",
      communityTrading: "enableNotifications",
    };
    
    if (field === "autoTrading") {
      updatePreferencesMutation.mutate({
        tradingMode: value ? "automatic" : "manual",
      });
    } else {
      updatePreferencesMutation.mutate({
        [fieldMap[field]]: value,
      } as any);
    }
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, { variant: "default" | "secondary" | "destructive" | "outline", label: string }> = {
      pending: { variant: "secondary", label: "Pending" },
      completed: { variant: "default", label: "Completed" },
      cancelled: { variant: "destructive", label: "Cancelled" },
    };
    const config = variants[status] || variants.pending;
    return <Badge variant={config.variant}>{config.label}</Badge>;
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "completed":
        return <CheckCircle2 className="h-5 w-5 text-green-600" />;
      case "cancelled":
        return <XCircle className="h-5 w-5 text-red-600" />;
      default:
        return <Clock className="h-5 w-5 text-amber-600" />;
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Power Trading</h1>
            <p className="text-muted-foreground mt-2">
              Trade your excess power in the marketplace or enable automatic trading.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => navigate("/trading/strategies")}>
              <Settings2 className="mr-2 h-4 w-4" />
              Manage Strategies
            </Button>
            <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  Create Trade
                </Button>
              </DialogTrigger>
            </Dialog>
            <Button variant="outline" onClick={handleManualTradeWorkflow} disabled={startManualTradeMutation.isPending}>
              <TrendingUp className="mr-2 h-4 w-4" />
              Quick Buy
            </Button>
            <Button variant="outline" onClick={handleP2PTradeWorkflow} disabled={startP2PTradeMutation.isPending}>
              <Share2 className="mr-2 h-4 w-4" />
              P2P Trade
            </Button>
          </div>
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create New Trade</DialogTitle>
                <DialogDescription>
                  Sell your excess power or buy power from the marketplace.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleSubmit}>
                <div className="grid gap-4 py-4">
                  <div className="grid gap-2">
                    <Label htmlFor="tradeType">Trade Type *</Label>
                    <Select
                      value={formData.tradeType}
                      onValueChange={(value: any) => setFormData({ ...formData, tradeType: value })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="sell">Sell Power</SelectItem>
                        <SelectItem value="buy">Buy Power</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="assetId">Asset *</Label>
                    <Select
                      value={formData.assetId}
                      onValueChange={(value) => setFormData({ ...formData, assetId: value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select asset" />
                      </SelectTrigger>
                      <SelectContent>
                        {assets.map((asset) => (
                          <SelectItem key={asset.id} value={asset.id.toString()}>
                            {asset.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="quantity">Quantity (kWh) *</Label>
                    <Input
                      id="quantity"
                      type="number"
                      step="0.01"
                      value={formData.quantity}
                      onChange={(e) => setFormData({ ...formData, quantity: e.target.value })}
                      placeholder="e.g., 10.5"
                      required
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="price">Price per kWh (TZS/NGN) *</Label>
                    <Input
                      id="price"
                      type="number"
                      step="0.01"
                      value={formData.price}
                      onChange={(e) => setFormData({ ...formData, price: e.target.value })}
                      placeholder="e.g., 250.00"
                      required
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setIsDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={createTradeMutation.isPending}>
                    {createTradeMutation.isPending ? "Creating..." : "Create Trade"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        <Tabs defaultValue="overview" className="space-y-4">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="trades">My Trades</TabsTrigger>
            <TabsTrigger value="preferences">Preferences</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Total Trades</CardTitle>
                  <ArrowDownUp className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{trades.length}</div>
                  <p className="text-xs text-muted-foreground mt-1">All time</p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Completed Trades</CardTitle>
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {trades.filter((t: any) => t.status === "completed").length}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">Successfully executed</p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Total Revenue</CardTitle>
                  <TrendingUp className="h-4 w-4 text-green-600" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {trades
                      .filter((t: any) => t.status === "completed" && t.tradeType === "sell")
                      .reduce((sum: number, t: any) => sum + t.quantity * t.price, 0)
                      .toFixed(2)}{" "}
                    TZS
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">From power sales</p>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Trading Models</CardTitle>
                <CardDescription>
                  Choose how you want to participate in the power marketplace
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="border rounded-lg p-4 space-y-2">
                  <h3 className="font-semibold">Automatic Trading (70/30)</h3>
                  <p className="text-sm text-muted-foreground">
                    VPP automatically trades your excess power. You keep 70% of revenue, VPP takes 30%.
                  </p>
                  <div className="flex items-center justify-between pt-2">
                    <span className="text-sm font-medium">
                      {preferences?.tradingMode === "automatic" ? "Enabled" : "Disabled"}
                    </span>
                    <Switch
                      checked={preferences?.tradingMode === "automatic"}
                      onCheckedChange={(checked) => handlePreferenceToggle("autoTrading", checked)}
                      disabled={preferencesLoading}
                    />
                  </div>
                </div>

                <div className="border rounded-lg p-4 space-y-2">
                  <h3 className="font-semibold">Manual Trading</h3>
                  <p className="text-sm text-muted-foreground">
                    You control when and how much power to trade. Set your own prices and quantities.
                  </p>
                  <div className="pt-2">
                    <Button variant="outline" onClick={() => setIsDialogOpen(true)} className="w-full">
                      Create Manual Trade
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="trades" className="space-y-4">
            {tradesLoading ? (
              <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                  <Card key={i}>
                    <CardContent className="p-6">
                      <Skeleton className="h-20 w-full" />
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : trades.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="flex flex-col items-center justify-center py-12">
                  <ArrowDownUp className="h-12 w-12 text-muted-foreground mb-4" />
                  <h3 className="text-lg font-semibold mb-2">No trades yet</h3>
                  <p className="text-sm text-muted-foreground text-center mb-4">
                    Create your first trade to start buying or selling power.
                  </p>
                  <Button onClick={() => setIsDialogOpen(true)}>
                    <Plus className="mr-2 h-4 w-4" />
                    Create Trade
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-4">
                {trades.map((trade: any) => (
                  <Card key={trade.id}>
                    <CardContent className="p-6">
                      <div className="flex items-start justify-between">
                        <div className="flex items-start gap-4">
                          <div className="p-3 rounded-lg bg-primary/10">
                            {getStatusIcon(trade.status)}
                          </div>
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <h3 className="font-semibold">
                                {trade.tradeType === "sell" ? "Sell" : "Buy"} {trade.quantity} kWh
                              </h3>
                              {getStatusBadge(trade.status)}
                            </div>
                            <p className="text-sm text-muted-foreground">
                              Price: {trade.price} TZS/kWh • Total: {(trade.quantity * trade.price).toFixed(2)} TZS
                            </p>
                            <p className="text-xs text-muted-foreground">
                              Created: {new Date(trade.createdAt).toLocaleString()}
                            </p>
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="preferences" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Trading Preferences</CardTitle>
                <CardDescription>
                  Configure your automated trading settings and preferences
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Automatic Trading</Label>
                    <p className="text-sm text-muted-foreground">
                      Enable automatic trading of excess power (70/30 split)
                    </p>
                  </div>
                  <Switch
                    checked={preferences?.tradingMode === "automatic"}
                    onCheckedChange={(checked) => handlePreferenceToggle("autoTrading", checked)}
                    disabled={preferencesLoading}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>P2P Trading</Label>
                    <p className="text-sm text-muted-foreground">
                      Allow peer-to-peer trading with other VPP members
                    </p>
                  </div>
                  <Switch
                    checked={preferences?.enableP2P || false}
                    onCheckedChange={(checked) => handlePreferenceToggle("p2pEnabled", checked)}
                    disabled={preferencesLoading}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Community Trading</Label>
                    <p className="text-sm text-muted-foreground">
                      Participate in community-based power sharing programs
                    </p>
                  </div>
                  <Switch
                    checked={preferences?.enableNotifications || false}
                    onCheckedChange={(checked) => handlePreferenceToggle("communityTrading", checked)}
                    disabled={preferencesLoading}
                  />
                </div>

                <div className="space-y-2 pt-4 border-t">
                  <Label>Minimum Export Price (TZS/kWh)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="e.g., 200.00"
                    defaultValue={preferences && 'minExportPrice' in preferences && preferences.minExportPrice ? (preferences.minExportPrice / 100).toFixed(2) : ""}
                    onBlur={(e) => {
                      const value = parseFloat(e.target.value);
                      if (!isNaN(value)) {
                        updatePreferencesMutation.mutate({ minExportPrice: Math.round(value * 100) });
                      }
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    Minimum price you're willing to accept for selling power
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>Maximum Import Price (TZS/kWh)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="e.g., 500.00"
                    defaultValue={preferences && 'maxImportPrice' in preferences && preferences.maxImportPrice ? (preferences.maxImportPrice / 100).toFixed(2) : ""}
                    onBlur={(e) => {
                      const value = parseFloat(e.target.value);
                      if (!isNaN(value)) {
                        updatePreferencesMutation.mutate({ maxImportPrice: Math.round(value * 100) });
                      }
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    Maximum price you're willing to pay for buying power
                  </p>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
