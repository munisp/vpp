import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { TrendingUp, TrendingDown, Plus } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { Redirect } from "wouter";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useState } from "react";

export default function MarketPricing() {
  const { user, loading } = useAuth();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [priceType, setPriceType] = useState<"export" | "import">("export");
  const [price, setPrice] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(new Date().toISOString().split('T')[0]);

  const { data: prices, isLoading, refetch } = trpc.admin.getMarketPrices.useQuery();
  const setPriceMutation = trpc.admin.setMarketPrice.useMutation({
    onSuccess: (data) => {
      toast.success(data.message);
      setShowAddDialog(false);
      setPrice("");
      refetch();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to set market price");
    },
  });

  // Check if user is admin
  if (!loading && user?.role !== 'admin') {
    return <Redirect to="/" />;
  }

  const handleSetPrice = () => {
    const priceInCents = Math.round(parseFloat(price) * 100);
    if (isNaN(priceInCents) || priceInCents <= 0) {
      toast.error("Please enter a valid price");
      return;
    }

    setPriceMutation.mutate({
      priceType,
      price: priceInCents,
      effectiveFrom: new Date(effectiveDate),
    });
  };

  const getPriceTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      peak: "Peak Hours",
      off_peak: "Off-Peak Hours",
      shoulder: "Shoulder Hours",
      super_peak: "Super Peak Hours",
    };
    return labels[type] || type;
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Market Pricing</h1>
            <p className="text-muted-foreground mt-2">
              Configure energy trading prices for the VPP marketplace.
            </p>
          </div>
          <Button onClick={() => setShowAddDialog(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Set New Price
          </Button>
        </div>

        {/* Current Prices */}
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-lg bg-green-50">
                  <TrendingUp className="h-6 w-6 text-green-600" />
                </div>
                <div>
                  <CardTitle>Export Price</CardTitle>
                  <CardDescription>Price for selling energy to grid</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-green-600">
                TZS 150
                <span className="text-base font-normal text-muted-foreground ml-2">/ kWh</span>
              </div>
              <p className="text-sm text-muted-foreground mt-2">
                Effective from: {new Date().toLocaleDateString()}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-lg bg-red-50">
                  <TrendingDown className="h-6 w-6 text-red-600" />
                </div>
                <div>
                  <CardTitle>Import Price</CardTitle>
                  <CardDescription>Price for buying energy from grid</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-red-600">
                TZS 250
                <span className="text-base font-normal text-muted-foreground ml-2">/ kWh</span>
              </div>
              <p className="text-sm text-muted-foreground mt-2">
                Effective from: {new Date().toLocaleDateString()}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Price History */}
        <Card>
          <CardHeader>
            <CardTitle>Price History</CardTitle>
            <CardDescription>
              Historical market prices and changes
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="border rounded-lg">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Price Type</TableHead>
                    <TableHead>Price</TableHead>
                    <TableHead>Country</TableHead>
                    <TableHead>Effective From</TableHead>
                    <TableHead>Valid Until</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-8">
                        Loading prices...
                      </TableCell>
                    </TableRow>
                  ) : !prices || prices.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-8">
                        No price history available
                      </TableCell>
                    </TableRow>
                  ) : (
                    prices.map((p: any) => {
                      const now = new Date();
                      const effectiveFrom = new Date(p.timestamp);
                      const validUntil = new Date(p.validUntil);
                      const isActive = now >= effectiveFrom && now <= validUntil;

                      return (
                        <TableRow key={p.id}>
                          <TableCell>
                            <Badge variant="outline">
                              {getPriceTypeLabel(p.priceType)}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-medium">
                            TZS {(p.price / 100).toFixed(2)} / kWh
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {p.country === 'tanzania' ? 'Tanzania' : p.country}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {effectiveFrom.toLocaleDateString()}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {validUntil.toLocaleDateString()}
                          </TableCell>
                          <TableCell>
                            <Badge variant={isActive ? "default" : "secondary"}>
                              {isActive ? "Active" : "Expired"}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Set Price Dialog */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set Market Price</DialogTitle>
            <DialogDescription>
              Configure a new market price for energy trading
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="priceType">Price Type</Label>
              <Select value={priceType} onValueChange={(value: "export" | "import") => setPriceType(value)}>
                <SelectTrigger id="priceType">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="export">
                    <div className="flex items-center gap-2">
                      <TrendingUp className="h-4 w-4 text-green-600" />
                      <span>Export (Selling to Grid)</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="import">
                    <div className="flex items-center gap-2">
                      <TrendingDown className="h-4 w-4 text-red-600" />
                      <span>Import (Buying from Grid)</span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="price">Price (TZS per kWh)</Label>
              <Input
                id="price"
                type="number"
                step="0.01"
                placeholder="e.g., 150.00"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Enter the price in Tanzanian Shillings per kilowatt-hour
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="effectiveDate">Effective From</Label>
              <Input
                id="effectiveDate"
                type="date"
                value={effectiveDate}
                onChange={(e) => setEffectiveDate(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                The date when this price becomes active
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSetPrice}
              disabled={setPriceMutation.isPending || !price}
            >
              {setPriceMutation.isPending ? "Setting..." : "Set Price"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
