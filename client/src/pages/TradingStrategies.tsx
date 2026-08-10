import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Play, Pause, Trash2, Plus, TrendingUp, Target, Clock, Battery, DollarSign, BarChart3, Sparkles, GitCompare } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { useLocation } from "wouter";

export default function TradingStrategies() {
  const [, setLocation] = useLocation();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [selectedStrategy, setSelectedStrategy] = useState<number | null>(null);

  const { data: strategies, isLoading, refetch } = trpc.tradingStrategies.list.useQuery();
  const createMutation = trpc.tradingStrategies.create.useMutation();
  const updateMutation = trpc.tradingStrategies.update.useMutation();
  const deleteMutation = trpc.tradingStrategies.delete.useMutation();
  const activateMutation = trpc.tradingStrategies.activate.useMutation();
  const deactivateMutation = trpc.tradingStrategies.deactivate.useMutation();
  const backtestMutation = trpc.tradingStrategies.backtest.useMutation();

  const [formData, setFormData] = useState({
    name: "",
    description: "",
    tradingMode: "both" as "export" | "import" | "both",
    priority: 0,
    conditions: {
      priceThresholds: {
        minExportPrice: undefined as number | undefined,
        maxExportPrice: undefined as number | undefined,
        minImportPrice: undefined as number | undefined,
        maxImportPrice: undefined as number | undefined,
      },
      batteryLevels: {
        minSOC: undefined as number | undefined,
        maxSOC: undefined as number | undefined,
      },
      timeWindows: {
        startHour: undefined as number | undefined,
        endHour: undefined as number | undefined,
        daysOfWeek: [] as number[],
      },
      energyLimits: {
        minTradeSize: undefined as number | undefined,
        maxTradeSize: undefined as number | undefined,
        dailyLimit: undefined as number | undefined,
      },
    },
  });

  const handleCreate = async () => {
    try {
      await createMutation.mutateAsync(formData);
      toast.success("Strategy created successfully");
      setIsCreateDialogOpen(false);
      refetch();
      // Reset form
      setFormData({
        name: "",
        description: "",
        tradingMode: "both",
        priority: 0,
        conditions: {
          priceThresholds: {
            minExportPrice: undefined,
            maxExportPrice: undefined,
            minImportPrice: undefined,
            maxImportPrice: undefined,
          },
          batteryLevels: {
            minSOC: undefined,
            maxSOC: undefined,
          },
          timeWindows: {
            startHour: undefined,
            endHour: undefined,
            daysOfWeek: [],
          },
          energyLimits: {
            minTradeSize: undefined,
            maxTradeSize: undefined,
            dailyLimit: undefined,
          },
        },
      });
    } catch (error: any) {
      toast.error(error.message || "Failed to create strategy");
    }
  };

  const handleToggleActive = async (id: number, isActive: boolean) => {
    try {
      if (isActive) {
        await deactivateMutation.mutateAsync({ id });
        toast.success("Strategy deactivated");
      } else {
        await activateMutation.mutateAsync({ id });
        toast.success("Strategy activated");
      }
      refetch();
    } catch (error: any) {
      toast.error(error.message || "Failed to toggle strategy");
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Are you sure you want to delete this strategy?")) return;
    
    try {
      await deleteMutation.mutateAsync({ id });
      toast.success("Strategy deleted successfully");
      refetch();
    } catch (error: any) {
      toast.error(error.message || "Failed to delete strategy");
    }
  };

  const handleBacktest = async (id: number, period: "7d" | "30d" | "90d") => {
    try {
      const result = await backtestMutation.mutateAsync({ id, period });
      toast.success(`Backtest completed: ${result.results.simulatedTrades} trades simulated`);
      refetch();
    } catch (error: any) {
      toast.error(error.message || "Failed to run backtest");
    }
  };

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="container mx-auto py-8">
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-bold">Trading Strategies</h1>
            <p className="text-muted-foreground mt-2">
              Create and manage automated trading strategies with backtesting
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setLocation("/trading/comparison")}>
              <GitCompare className="mr-2 h-4 w-4" />
              Compare Strategies
            </Button>
            <Button variant="outline" onClick={() => setLocation("/trading/templates")}>
              <Sparkles className="mr-2 h-4 w-4" />
              Browse Templates
            </Button>
            <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  Create Strategy
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Create Trading Strategy</DialogTitle>
                <DialogDescription>
                  Define rules and conditions for automatic trading
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-6 py-4">
                {/* Basic Info */}
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="name">Strategy Name *</Label>
                    <Input
                      id="name"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      placeholder="e.g., Peak Hour Export"
                    />
                  </div>

                  <div>
                    <Label htmlFor="description">Description</Label>
                    <Textarea
                      id="description"
                      value={formData.description}
                      onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                      placeholder="Describe your strategy..."
                    />
                  </div>

                  <div>
                    <Label htmlFor="tradingMode">Trading Mode</Label>
                    <Select
                      value={formData.tradingMode}
                      onValueChange={(value: any) => setFormData({ ...formData, tradingMode: value })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="export">Export Only</SelectItem>
                        <SelectItem value="import">Import Only</SelectItem>
                        <SelectItem value="both">Both</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <Label htmlFor="priority">Priority (higher executes first)</Label>
                    <Input
                      id="priority"
                      type="number"
                      value={formData.priority}
                      onChange={(e) => setFormData({ ...formData, priority: parseInt(e.target.value) || 0 })}
                    />
                  </div>
                </div>

                {/* Price Thresholds */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg flex items-center gap-2">
                      <DollarSign className="h-5 w-5" />
                      Price Thresholds
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label>Min Export Price (TZS/kWh)</Label>
                        <Input
                          type="number"
                          step="0.01"
                          placeholder="e.g., 0.15"
                          value={formData.conditions.priceThresholds.minExportPrice || ""}
                          onChange={(e) => setFormData({
                            ...formData,
                            conditions: {
                              ...formData.conditions,
                              priceThresholds: {
                                ...formData.conditions.priceThresholds,
                                minExportPrice: e.target.value ? parseFloat(e.target.value) : undefined,
                              },
                            },
                          })}
                        />
                      </div>
                      <div>
                        <Label>Max Export Price (TZS/kWh)</Label>
                        <Input
                          type="number"
                          step="0.01"
                          placeholder="e.g., 0.25"
                          value={formData.conditions.priceThresholds.maxExportPrice || ""}
                          onChange={(e) => setFormData({
                            ...formData,
                            conditions: {
                              ...formData.conditions,
                              priceThresholds: {
                                ...formData.conditions.priceThresholds,
                                maxExportPrice: e.target.value ? parseFloat(e.target.value) : undefined,
                              },
                            },
                          })}
                        />
                      </div>
                      <div>
                        <Label>Min Import Price (TZS/kWh)</Label>
                        <Input
                          type="number"
                          step="0.01"
                          placeholder="e.g., 0.10"
                          value={formData.conditions.priceThresholds.minImportPrice || ""}
                          onChange={(e) => setFormData({
                            ...formData,
                            conditions: {
                              ...formData.conditions,
                              priceThresholds: {
                                ...formData.conditions.priceThresholds,
                                minImportPrice: e.target.value ? parseFloat(e.target.value) : undefined,
                              },
                            },
                          })}
                        />
                      </div>
                      <div>
                        <Label>Max Import Price (TZS/kWh)</Label>
                        <Input
                          type="number"
                          step="0.01"
                          placeholder="e.g., 0.20"
                          value={formData.conditions.priceThresholds.maxImportPrice || ""}
                          onChange={(e) => setFormData({
                            ...formData,
                            conditions: {
                              ...formData.conditions,
                              priceThresholds: {
                                ...formData.conditions.priceThresholds,
                                maxImportPrice: e.target.value ? parseFloat(e.target.value) : undefined,
                              },
                            },
                          })}
                        />
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* Battery Levels */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg flex items-center gap-2">
                      <Battery className="h-5 w-5" />
                      Battery Levels (SOC %)
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label>Min SOC to Sell (%)</Label>
                        <Input
                          type="number"
                          min="0"
                          max="100"
                          placeholder="e.g., 80"
                          value={formData.conditions.batteryLevels.minSOC || ""}
                          onChange={(e) => setFormData({
                            ...formData,
                            conditions: {
                              ...formData.conditions,
                              batteryLevels: {
                                ...formData.conditions.batteryLevels,
                                minSOC: e.target.value ? parseFloat(e.target.value) : undefined,
                              },
                            },
                          })}
                        />
                      </div>
                      <div>
                        <Label>Max SOC to Buy (%)</Label>
                        <Input
                          type="number"
                          min="0"
                          max="100"
                          placeholder="e.g., 50"
                          value={formData.conditions.batteryLevels.maxSOC || ""}
                          onChange={(e) => setFormData({
                            ...formData,
                            conditions: {
                              ...formData.conditions,
                              batteryLevels: {
                                ...formData.conditions.batteryLevels,
                                maxSOC: e.target.value ? parseFloat(e.target.value) : undefined,
                              },
                            },
                          })}
                        />
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* Time Windows */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg flex items-center gap-2">
                      <Clock className="h-5 w-5" />
                      Time Windows
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label>Start Hour (0-23)</Label>
                        <Input
                          type="number"
                          min="0"
                          max="23"
                          placeholder="e.g., 9"
                          value={formData.conditions.timeWindows.startHour ?? ""}
                          onChange={(e) => setFormData({
                            ...formData,
                            conditions: {
                              ...formData.conditions,
                              timeWindows: {
                                ...formData.conditions.timeWindows,
                                startHour: e.target.value ? parseInt(e.target.value) : undefined,
                              },
                            },
                          })}
                        />
                      </div>
                      <div>
                        <Label>End Hour (0-23)</Label>
                        <Input
                          type="number"
                          min="0"
                          max="23"
                          placeholder="e.g., 17"
                          value={formData.conditions.timeWindows.endHour ?? ""}
                          onChange={(e) => setFormData({
                            ...formData,
                            conditions: {
                              ...formData.conditions,
                              timeWindows: {
                                ...formData.conditions.timeWindows,
                                endHour: e.target.value ? parseInt(e.target.value) : undefined,
                              },
                            },
                          })}
                        />
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* Energy Limits */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg flex items-center gap-2">
                      <Target className="h-5 w-5" />
                      Energy Limits (kWh)
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label>Min Trade Size (kWh)</Label>
                        <Input
                          type="number"
                          step="0.1"
                          placeholder="e.g., 1"
                          value={formData.conditions.energyLimits.minTradeSize || ""}
                          onChange={(e) => setFormData({
                            ...formData,
                            conditions: {
                              ...formData.conditions,
                              energyLimits: {
                                ...formData.conditions.energyLimits,
                                minTradeSize: e.target.value ? parseFloat(e.target.value) : undefined,
                              },
                            },
                          })}
                        />
                      </div>
                      <div>
                        <Label>Max Trade Size (kWh)</Label>
                        <Input
                          type="number"
                          step="0.1"
                          placeholder="e.g., 50"
                          value={formData.conditions.energyLimits.maxTradeSize || ""}
                          onChange={(e) => setFormData({
                            ...formData,
                            conditions: {
                              ...formData.conditions,
                              energyLimits: {
                                ...formData.conditions.energyLimits,
                                maxTradeSize: e.target.value ? parseFloat(e.target.value) : undefined,
                              },
                            },
                          })}
                        />
                      </div>
                      <div className="col-span-2">
                        <Label>Daily Limit (kWh)</Label>
                        <Input
                          type="number"
                          step="0.1"
                          placeholder="e.g., 100"
                          value={formData.conditions.energyLimits.dailyLimit || ""}
                          onChange={(e) => setFormData({
                            ...formData,
                            conditions: {
                              ...formData.conditions,
                              energyLimits: {
                                ...formData.conditions.energyLimits,
                                dailyLimit: e.target.value ? parseFloat(e.target.value) : undefined,
                              },
                            },
                          })}
                        />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleCreate} disabled={!formData.name || createMutation.isPending}>
                  {createMutation.isPending ? "Creating..." : "Create Strategy"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          </div>
        </div>

        {/* Strategies List */}
        <div className="grid gap-6">
          {strategies && strategies.length === 0 && (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12">
                <TrendingUp className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold mb-2">No strategies yet</h3>
                <p className="text-muted-foreground text-center mb-4">
                  Create your first automated trading strategy to get started
                </p>
                <Button onClick={() => setIsCreateDialogOpen(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  Create Strategy
                </Button>
              </CardContent>
            </Card>
          )}

          {strategies?.map((strategy) => (
            <Card key={strategy.id} className={strategy.isActive ? "border-primary" : ""}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3">
                      <CardTitle>{strategy.name}</CardTitle>
                      {strategy.isActive && (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                          Active
                        </span>
                      )}
                    </div>
                    <CardDescription className="mt-2">
                      {strategy.description || "No description"}
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={strategy.isActive}
                      onCheckedChange={() => handleToggleActive(strategy.id, strategy.isActive)}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDelete(strategy.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                  <div>
                    <p className="text-sm text-muted-foreground">Trading Mode</p>
                    <p className="font-medium capitalize">{strategy.tradingMode}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Priority</p>
                    <p className="font-medium">{strategy.priority}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Total Trades</p>
                    <p className="font-medium">
                      {(strategy.performanceMetrics as any)?.totalTrades || 0}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Total Profit</p>
                    <p className="font-medium">
                      {((strategy.performanceMetrics as any)?.totalProfit || 0).toFixed(2)} TZS
                    </p>
                  </div>
                </div>

                {strategy.backtestResults && (
                  <div className="bg-muted p-4 rounded-lg mb-4">
                    <h4 className="font-semibold mb-3 flex items-center gap-2">
                      <BarChart3 className="h-4 w-4" />
                      Backtest Results ({(strategy.backtestResults as any).period})
                    </h4>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div>
                        <p className="text-sm text-muted-foreground">Simulated Trades</p>
                        <p className="font-medium">{(strategy.backtestResults as any).simulatedTrades}</p>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Projected Profit</p>
                        <p className="font-medium">
                          {((strategy.backtestResults as any).projectedProfit || 0).toFixed(2)} TZS
                        </p>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Energy Traded</p>
                        <p className="font-medium">
                          {((strategy.backtestResults as any).projectedEnergyTraded || 0).toFixed(2)} kWh
                        </p>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Success Rate</p>
                        <p className="font-medium">
                          {((strategy.backtestResults as any).successRate || 0).toFixed(1)}%
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleBacktest(strategy.id, "7d")}
                    disabled={backtestMutation.isPending}
                  >
                    Backtest 7d
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleBacktest(strategy.id, "30d")}
                    disabled={backtestMutation.isPending}
                  >
                    Backtest 30d
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleBacktest(strategy.id, "90d")}
                    disabled={backtestMutation.isPending}
                  >
                    Backtest 90d
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </DashboardLayout>
  );
}
