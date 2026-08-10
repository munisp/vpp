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
import { trpc } from "@/lib/trpc";
import { Battery, Plus, Sun, Wind, Zap, Gauge, Trash2, Play, Square } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";

const assetTypeIcons = {
  solar: Sun,
  battery: Battery,
  wind: Wind,
  generator: Zap,
  meter: Gauge,
};

const assetTypeLabels = {
  solar: "Solar Panel",
  battery: "Battery Storage",
  wind: "Wind Turbine",
  generator: "Generator",
  meter: "Smart Meter",
};

export default function Assets() {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    assetType: "solar" as "solar" | "battery" | "wind" | "generator" | "meter",
    capacity: "",
    make: "",
    model: "",
    serialNumber: "",
    installationDate: "",
  });

  const utils = trpc.useUtils();
  const { data: assetsData, isLoading } = trpc.assets.list.useQuery();
  const assets = assetsData?.assets || [];

  const registerMutation = trpc.assets.register.useMutation({
    onSuccess: () => {
      toast.success("Asset registered successfully!");
      setIsDialogOpen(false);
      setFormData({
        name: "",
        assetType: "solar",
        capacity: "",
        make: "",
        model: "",
        serialNumber: "",
        installationDate: "",
      });
      utils.assets.list.invalidate();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to register asset");
    },
  });

  const deleteMutation = trpc.assets.delete.useMutation({
    onSuccess: () => {
      toast.success("Asset deleted successfully!");
      utils.assets.list.invalidate();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to delete asset");
    },
  });

  const startAutoTradingMutation = trpc.orchestrator.startAutoTrading.useMutation({
    onSuccess: (data) => {
      toast.success("Auto-trading workflow started!", {
        description: `Workflow ID: ${data.workflowId}`,
      });
    },
    onError: (error) => {
      toast.error(error.message || "Failed to start auto-trading");
    },
  });

  const handleStartAutoTrading = (assetId: number, assetName: string) => {
    if (window.confirm(`Enable auto-trading for "${assetName}"? This will automatically sell surplus energy when available.`)) {
      startAutoTradingMutation.mutate({ assetId: String(assetId) });
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    registerMutation.mutate({
      name: formData.name,
      assetType: formData.assetType,
      capacity: parseFloat(formData.capacity),
      make: formData.make || undefined,
      model: formData.model || undefined,
      serialNumber: formData.serialNumber || undefined,
      installationDate: formData.installationDate ? new Date(formData.installationDate) : undefined,
    });
  };

  const handleDelete = (id: number, name: string) => {
    if (window.confirm(`Are you sure you want to delete "${name}"?`)) {
      deleteMutation.mutate({ assetId: id });
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">My Assets</h1>
            <p className="text-muted-foreground mt-2">
              Manage your solar panels, batteries, and other energy equipment.
            </p>
          </div>
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Register Asset
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Register New Asset</DialogTitle>
                <DialogDescription>
                  Add a new energy asset to your Virtual Power Plant.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleSubmit}>
                <div className="grid gap-4 py-4">
                  <div className="grid gap-2">
                    <Label htmlFor="name">Asset Name *</Label>
                    <Input
                      id="name"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      placeholder="e.g., Rooftop Solar Panel"
                      required
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="assetType">Asset Type *</Label>
                    <Select
                      value={formData.assetType}
                      onValueChange={(value: any) => setFormData({ ...formData, assetType: value })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="solar">Solar Panel</SelectItem>
                        <SelectItem value="battery">Battery Storage</SelectItem>
                        <SelectItem value="wind">Wind Turbine</SelectItem>
                        <SelectItem value="generator">Generator</SelectItem>
                        <SelectItem value="meter">Smart Meter</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="capacity">Capacity (kW) *</Label>
                    <Input
                      id="capacity"
                      type="number"
                      step="0.01"
                      value={formData.capacity}
                      onChange={(e) => setFormData({ ...formData, capacity: e.target.value })}
                      placeholder="e.g., 5.5"
                      required
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label htmlFor="make">Manufacturer</Label>
                      <Input
                        id="make"
                        value={formData.make}
                        onChange={(e) => setFormData({ ...formData, make: e.target.value })}
                        placeholder="e.g., Tesla"
                      />
                    </div>

                    <div className="grid gap-2">
                      <Label htmlFor="model">Model</Label>
                      <Input
                        id="model"
                        value={formData.model}
                        onChange={(e) => setFormData({ ...formData, model: e.target.value })}
                        placeholder="e.g., Powerwall 2"
                      />
                    </div>
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="serialNumber">Serial Number</Label>
                    <Input
                      id="serialNumber"
                      value={formData.serialNumber}
                      onChange={(e) => setFormData({ ...formData, serialNumber: e.target.value })}
                      placeholder="e.g., SN123456789"
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="installationDate">Installation Date</Label>
                    <Input
                      id="installationDate"
                      type="date"
                      value={formData.installationDate}
                      onChange={(e) => setFormData({ ...formData, installationDate: e.target.value })}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setIsDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={registerMutation.isPending}>
                    {registerMutation.isPending ? "Registering..." : "Register Asset"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        {isLoading ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <Card key={i}>
                <CardHeader>
                  <Skeleton className="h-6 w-32" />
                  <Skeleton className="h-4 w-24 mt-2" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-20 w-full" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : assets.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Zap className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">No assets registered</h3>
              <p className="text-sm text-muted-foreground text-center mb-4">
                Get started by registering your first energy asset.
              </p>
              <Button onClick={() => setIsDialogOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Register Asset
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {assets.map((asset) => {
              const Icon = assetTypeIcons[asset.assetType];
              return (
                <Card key={asset.id}>
                  <CardHeader>
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-primary/10">
                          <Icon className="h-5 w-5 text-primary" />
                        </div>
                        <div>
                          <CardTitle className="text-lg">{asset.name}</CardTitle>
                          <CardDescription>{assetTypeLabels[asset.assetType]}</CardDescription>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDelete(asset.id, asset.name)}
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Capacity:</span>
                        <span className="font-medium">{asset.capacity} kW</span>
                      </div>
                      {asset.make && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Make:</span>
                          <span className="font-medium">{asset.make}</span>
                        </div>
                      )}
                      {asset.model && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Model:</span>
                          <span className="font-medium">{asset.model}</span>
                        </div>
                      )}
                      {asset.serialNumber && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Serial:</span>
                          <span className="font-medium text-xs">{asset.serialNumber}</span>
                        </div>
                      )}
                      <div className="flex justify-between pt-2 border-t">
                        <span className="text-muted-foreground">Status:</span>
                        <span className="font-medium text-green-600">Active</span>
                      </div>
                    </div>
                    <div className="mt-4 pt-4 border-t flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1"
                        onClick={() => handleStartAutoTrading(asset.id, asset.name)}
                        disabled={startAutoTradingMutation.isPending}
                      >
                        <Play className="h-3 w-3 mr-1" />
                        Auto-Trade
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
