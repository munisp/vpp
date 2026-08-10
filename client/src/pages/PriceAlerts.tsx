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
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Bell, BellOff, Plus, Trash2, Edit, TrendingUp, TrendingDown, Activity, Mail, Smartphone, MessageSquare } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

export default function PriceAlerts() {
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [editingAlert, setEditingAlert] = useState<any>(null);

  const { data: alerts, isLoading, refetch } = trpc.priceAlerts.list.useQuery();
  const createMutation = trpc.priceAlerts.create.useMutation();
  const updateMutation = trpc.priceAlerts.update.useMutation();
  const deleteMutation = trpc.priceAlerts.delete.useMutation();

  const [formData, setFormData] = useState({
    name: "",
    description: "",
    alertType: "above" as "above" | "below" | "between",
    targetPrice: "",
    minPrice: "",
    maxPrice: "",
    notifyEmail: true,
    notifyPush: true,
    notifySMS: false,
    cooldownMinutes: 60,
    maxTriggers: "",
  });

  const resetForm = () => {
    setFormData({
      name: "",
      description: "",
      alertType: "above",
      targetPrice: "",
      minPrice: "",
      maxPrice: "",
      notifyEmail: true,
      notifyPush: true,
      notifySMS: false,
      cooldownMinutes: 60,
      maxTriggers: "",
    });
    setEditingAlert(null);
  };

  const handleCreate = async () => {
    try {
      await createMutation.mutateAsync({
        name: formData.name,
        description: formData.description,
        alertType: formData.alertType,
        targetPrice: formData.targetPrice ? parseFloat(formData.targetPrice) : undefined,
        minPrice: formData.minPrice ? parseFloat(formData.minPrice) : undefined,
        maxPrice: formData.maxPrice ? parseFloat(formData.maxPrice) : undefined,
        notifyEmail: formData.notifyEmail,
        notifyPush: formData.notifyPush,
        notifySMS: formData.notifySMS,
        cooldownMinutes: formData.cooldownMinutes,
        maxTriggers: formData.maxTriggers ? parseInt(formData.maxTriggers) : undefined,
      });
      toast.success("Price alert created successfully");
      setIsCreateDialogOpen(false);
      resetForm();
      refetch();
    } catch (error: any) {
      toast.error(error.message || "Failed to create alert");
    }
  };

  const handleUpdate = async () => {
    if (!editingAlert) return;
    
    try {
      await updateMutation.mutateAsync({
        id: editingAlert.id,
        name: formData.name,
        description: formData.description,
        alertType: formData.alertType,
        targetPrice: formData.targetPrice ? parseFloat(formData.targetPrice) : undefined,
        minPrice: formData.minPrice ? parseFloat(formData.minPrice) : undefined,
        maxPrice: formData.maxPrice ? parseFloat(formData.maxPrice) : undefined,
        notifyEmail: formData.notifyEmail,
        notifyPush: formData.notifyPush,
        notifySMS: formData.notifySMS,
        cooldownMinutes: formData.cooldownMinutes,
        maxTriggers: formData.maxTriggers ? parseInt(formData.maxTriggers) : undefined,
      });
      toast.success("Price alert updated successfully");
      setIsCreateDialogOpen(false);
      resetForm();
      refetch();
    } catch (error: any) {
      toast.error(error.message || "Failed to update alert");
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Are you sure you want to delete this alert?")) return;
    
    try {
      await deleteMutation.mutateAsync({ id });
      toast.success("Alert deleted successfully");
      refetch();
    } catch (error: any) {
      toast.error(error.message || "Failed to delete alert");
    }
  };

  const handleToggleActive = async (id: number, isActive: boolean) => {
    try {
      await updateMutation.mutateAsync({ id, isActive: !isActive });
      toast.success(isActive ? "Alert deactivated" : "Alert activated");
      refetch();
    } catch (error: any) {
      toast.error(error.message || "Failed to toggle alert");
    }
  };

  const handleEdit = (alert: any) => {
    setEditingAlert(alert);
    setFormData({
      name: alert.name,
      description: alert.description || "",
      alertType: alert.alertType,
      targetPrice: alert.targetPrice?.toString() || "",
      minPrice: alert.minPrice?.toString() || "",
      maxPrice: alert.maxPrice?.toString() || "",
      notifyEmail: alert.notifyEmail,
      notifyPush: alert.notifyPush,
      notifySMS: alert.notifySMS,
      cooldownMinutes: alert.cooldownMinutes,
      maxTriggers: alert.maxTriggers?.toString() || "",
    });
    setIsCreateDialogOpen(true);
  };

  const getAlertTypeIcon = (type: string) => {
    switch (type) {
      case "above": return <TrendingUp className="h-4 w-4" />;
      case "below": return <TrendingDown className="h-4 w-4" />;
      case "between": return <Activity className="h-4 w-4" />;
      default: return <Bell className="h-4 w-4" />;
    }
  };

  const getAlertTypeLabel = (alert: any) => {
    switch (alert.alertType) {
      case "above":
        return `Price above ${alert.targetPrice} TZS/kWh`;
      case "below":
        return `Price below ${alert.targetPrice} TZS/kWh`;
      case "between":
        return `Price between ${alert.minPrice} - ${alert.maxPrice} TZS/kWh`;
      default:
        return "Unknown alert type";
    }
  };

  return (
    <DashboardLayout>
      <div className="container mx-auto py-8">
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-bold">Price Alerts</h1>
            <p className="text-muted-foreground mt-2">
              Get notified when energy prices reach your target levels
            </p>
          </div>
          <Dialog open={isCreateDialogOpen} onOpenChange={(open) => {
            setIsCreateDialogOpen(open);
            if (!open) resetForm();
          }}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Create Alert
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>{editingAlert ? "Edit" : "Create"} Price Alert</DialogTitle>
                <DialogDescription>
                  Set up notifications for when energy prices reach specific thresholds
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-4">
                {/* Alert Name */}
                <div className="space-y-2">
                  <Label htmlFor="name">Alert Name *</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="e.g., High Price Alert"
                  />
                </div>

                {/* Description */}
                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    placeholder="Optional description"
                    rows={2}
                  />
                </div>

                {/* Alert Type */}
                <div className="space-y-2">
                  <Label htmlFor="alertType">Alert Type *</Label>
                  <Select
                    value={formData.alertType}
                    onValueChange={(value: any) => setFormData({ ...formData, alertType: value })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="above">Price Above Threshold</SelectItem>
                      <SelectItem value="below">Price Below Threshold</SelectItem>
                      <SelectItem value="between">Price Within Range</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Price Thresholds */}
                {(formData.alertType === "above" || formData.alertType === "below") && (
                  <div className="space-y-2">
                    <Label htmlFor="targetPrice">Target Price (TZS/kWh) *</Label>
                    <Input
                      id="targetPrice"
                      type="number"
                      value={formData.targetPrice}
                      onChange={(e) => setFormData({ ...formData, targetPrice: e.target.value })}
                      placeholder="e.g., 150"
                    />
                  </div>
                )}

                {formData.alertType === "between" && (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="minPrice">Min Price (TZS/kWh) *</Label>
                      <Input
                        id="minPrice"
                        type="number"
                        value={formData.minPrice}
                        onChange={(e) => setFormData({ ...formData, minPrice: e.target.value })}
                        placeholder="e.g., 100"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="maxPrice">Max Price (TZS/kWh) *</Label>
                      <Input
                        id="maxPrice"
                        type="number"
                        value={formData.maxPrice}
                        onChange={(e) => setFormData({ ...formData, maxPrice: e.target.value })}
                        placeholder="e.g., 200"
                      />
                    </div>
                  </div>
                )}

                {/* Notification Methods */}
                <div className="space-y-3">
                  <Label>Notification Methods</Label>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Mail className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm">Email</span>
                    </div>
                    <Switch
                      checked={formData.notifyEmail}
                      onCheckedChange={(checked) => setFormData({ ...formData, notifyEmail: checked })}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Smartphone className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm">Push Notification</span>
                    </div>
                    <Switch
                      checked={formData.notifyPush}
                      onCheckedChange={(checked) => setFormData({ ...formData, notifyPush: checked })}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <MessageSquare className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm">SMS</span>
                    </div>
                    <Switch
                      checked={formData.notifySMS}
                      onCheckedChange={(checked) => setFormData({ ...formData, notifySMS: checked })}
                    />
                  </div>
                </div>

                {/* Advanced Settings */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="cooldown">Cooldown (minutes)</Label>
                    <Input
                      id="cooldown"
                      type="number"
                      value={formData.cooldownMinutes}
                      onChange={(e) => setFormData({ ...formData, cooldownMinutes: parseInt(e.target.value) || 60 })}
                      placeholder="60"
                    />
                    <p className="text-xs text-muted-foreground">Time between notifications</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="maxTriggers">Max Triggers</Label>
                    <Input
                      id="maxTriggers"
                      type="number"
                      value={formData.maxTriggers}
                      onChange={(e) => setFormData({ ...formData, maxTriggers: e.target.value })}
                      placeholder="Unlimited"
                    />
                    <p className="text-xs text-muted-foreground">Auto-disable after</p>
                  </div>
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => {
                  setIsCreateDialogOpen(false);
                  resetForm();
                }}>
                  Cancel
                </Button>
                <Button 
                  onClick={editingAlert ? handleUpdate : handleCreate} 
                  disabled={!formData.name || createMutation.isPending || updateMutation.isPending}
                >
                  {editingAlert ? "Update" : "Create"} Alert
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        {/* Alerts List */}
        <div className="grid gap-4">
          {isLoading && (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                Loading alerts...
              </CardContent>
            </Card>
          )}

          {alerts && alerts.length === 0 && (
            <Card>
              <CardContent className="py-12 text-center">
                <Bell className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold mb-2">No price alerts yet</h3>
                <p className="text-muted-foreground mb-4">
                  Create your first alert to get notified about price changes
                </p>
                <Button onClick={() => setIsCreateDialogOpen(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  Create Alert
                </Button>
              </CardContent>
            </Card>
          )}

          {alerts?.map((alert) => (
            <Card key={alert.id} className={!alert.isActive ? "opacity-60" : ""}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      {getAlertTypeIcon(alert.alertType)}
                      <CardTitle className="text-xl">{alert.name}</CardTitle>
                      {alert.isActive ? (
                        <Badge variant="default" className="bg-green-500">Active</Badge>
                      ) : (
                        <Badge variant="secondary">Inactive</Badge>
                      )}
                    </div>
                    <CardDescription>{alert.description || getAlertTypeLabel(alert)}</CardDescription>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleToggleActive(alert.id, alert.isActive)}
                    >
                      {alert.isActive ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleEdit(alert)}
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDelete(alert.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <div className="text-muted-foreground">Threshold</div>
                    <div className="font-medium">{getAlertTypeLabel(alert)}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Notifications</div>
                    <div className="flex gap-1 mt-1">
                      {alert.notifyEmail && <Mail className="h-4 w-4" />}
                      {alert.notifyPush && <Smartphone className="h-4 w-4" />}
                      {alert.notifySMS && <MessageSquare className="h-4 w-4" />}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Triggered</div>
                    <div className="font-medium">{alert.triggerCount} times</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Last Triggered</div>
                    <div className="font-medium">
                      {alert.lastTriggeredAt 
                        ? new Date(alert.lastTriggeredAt).toLocaleDateString()
                        : "Never"}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </DashboardLayout>
  );
}
