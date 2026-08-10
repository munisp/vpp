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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { Bell, BellOff, Plus, Trash2, Edit, TrendingUp, TrendingDown, Activity, Mail, Smartphone, MessageSquare, Globe, Play } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { useAuth } from "@/_core/hooks/useAuth";

/**
 * Market-scoped price alert subscriptions backed by the price alert engine
 * (country + tariff-band scope, evaluated against real market prices).
 */
function MarketSubscriptions() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    alertType: "above" as "above" | "below" | "between",
    targetPrice: "",
    minPrice: "",
    maxPrice: "",
    country: "tanzania" as "nigeria" | "tanzania",
    priceType: "peak" as "off_peak" | "shoulder" | "peak" | "super_peak",
    notifyPush: true,
    notifySMS: false,
    cooldownMinutes: 60,
  });

  const subs = trpc.priceAlertEngine.listMySubscriptions.useQuery();
  const subscribeMutation = trpc.priceAlertEngine.subscribe.useMutation({
    onSuccess: () => {
      toast.success("Subscription created");
      setOpen(false);
      utils.priceAlertEngine.listMySubscriptions.invalidate();
    },
    onError: (e) => toast.error(e.message || "Failed to subscribe"),
  });
  const unsubscribeMutation = trpc.priceAlertEngine.unsubscribe.useMutation({
    onSuccess: () => {
      toast.success("Unsubscribed");
      utils.priceAlertEngine.listMySubscriptions.invalidate();
    },
    onError: (e) => toast.error(e.message || "Failed to unsubscribe"),
  });
  const runEvalMutation = trpc.priceAlertEngine.runEvaluation.useMutation({
    onSuccess: (r) => {
      toast.success(
        `Evaluation complete — ${r.activeAlerts} active alert(s), ${r.triggered} triggered, ${r.skippedNoPrice} skipped (no real price)`
      );
    },
    onError: (e) => toast.error(e.message || "Evaluation failed"),
  });

  const handleSubscribe = () => {
    if (!form.name.trim()) return toast.error("Name is required");
    const payload: any = {
      name: form.name.trim(),
      alertType: form.alertType,
      country: form.country,
      priceType: form.priceType,
      notifyPush: form.notifyPush,
      notifySMS: form.notifySMS,
      cooldownMinutes: form.cooldownMinutes,
    };
    if (form.alertType === "between") {
      payload.minPrice = parseInt(form.minPrice, 10);
      payload.maxPrice = parseInt(form.maxPrice, 10);
    } else {
      payload.targetPrice = parseInt(form.targetPrice, 10);
    }
    subscribeMutation.mutate(payload);
  };

  const thresholdLabel = (s: any) => {
    if (s.alertType === "between") return `${s.minPrice}–${s.maxPrice}¢`;
    return `${s.alertType} ${s.targetPrice}¢`;
  };

  return (
    <Card className="mt-10">
      <CardHeader>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Globe className="h-5 w-5" /> Market price subscriptions
            </CardTitle>
            <CardDescription>
              Evaluated by the alert engine against real published market prices per country and tariff band
            </CardDescription>
          </div>
          <div className="flex gap-2">
            {isAdmin && (
              <Button
                variant="outline"
                onClick={() => runEvalMutation.mutate()}
                disabled={runEvalMutation.isPending}
              >
                <Play className="mr-2 h-4 w-4" />
                {runEvalMutation.isPending ? "Evaluating…" : "Run evaluation"}
              </Button>
            )}
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button variant="outline">
                  <Plus className="mr-2 h-4 w-4" /> Subscribe
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg">
                <DialogHeader>
                  <DialogTitle>Subscribe to a market price threshold</DialogTitle>
                  <DialogDescription>
                    Alerts fire when the real market price for the chosen band crosses your threshold
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-2">
                  <div className="space-y-2">
                    <Label>Name *</Label>
                    <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g., Peak price spike" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Country</Label>
                      <Select value={form.country} onValueChange={(v: any) => setForm({ ...form, country: v })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="nigeria">Nigeria</SelectItem>
                          <SelectItem value="tanzania">Tanzania</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Tariff band</Label>
                      <Select value={form.priceType} onValueChange={(v: any) => setForm({ ...form, priceType: v })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="off_peak">Off-peak</SelectItem>
                          <SelectItem value="shoulder">Shoulder</SelectItem>
                          <SelectItem value="peak">Peak</SelectItem>
                          <SelectItem value="super_peak">Super-peak</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Condition</Label>
                    <Select value={form.alertType} onValueChange={(v: any) => setForm({ ...form, alertType: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="above">Price above</SelectItem>
                        <SelectItem value="below">Price below</SelectItem>
                        <SelectItem value="between">Price between</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {form.alertType === "between" ? (
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Min (cents/kWh)</Label>
                        <Input type="number" min="1" value={form.minPrice} onChange={(e) => setForm({ ...form, minPrice: e.target.value })} />
                      </div>
                      <div className="space-y-2">
                        <Label>Max (cents/kWh)</Label>
                        <Input type="number" min="1" value={form.maxPrice} onChange={(e) => setForm({ ...form, maxPrice: e.target.value })} />
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Label>Target (cents/kWh)</Label>
                      <Input type="number" min="1" value={form.targetPrice} onChange={(e) => setForm({ ...form, targetPrice: e.target.value })} />
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Smartphone className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm">Push</span>
                    </div>
                    <Switch checked={form.notifyPush} onCheckedChange={(c) => setForm({ ...form, notifyPush: c })} />
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <MessageSquare className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm">SMS</span>
                    </div>
                    <Switch checked={form.notifySMS} onCheckedChange={(c) => setForm({ ...form, notifySMS: c })} />
                  </div>
                  <div className="space-y-2">
                    <Label>Cooldown (minutes)</Label>
                    <Input
                      type="number"
                      min="1"
                      value={form.cooldownMinutes}
                      onChange={(e) => setForm({ ...form, cooldownMinutes: parseInt(e.target.value) || 60 })}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button onClick={handleSubscribe} disabled={subscribeMutation.isPending}>
                    {subscribeMutation.isPending ? "Subscribing…" : "Subscribe"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {subs.isLoading ? (
          <p className="text-sm text-muted-foreground py-4">Loading subscriptions…</p>
        ) : subs.error ? (
          <p className="text-sm text-muted-foreground py-4">{subs.error.message}</p>
        ) : !subs.data || subs.data.subscriptions.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            No market subscriptions yet. Subscribe above to get alerted when a real market price band
            crosses your threshold.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Market scope</TableHead>
                <TableHead>Condition</TableHead>
                <TableHead>Channels</TableHead>
                <TableHead>Triggered</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {subs.data.subscriptions.map((s: any) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell className="text-sm">
                    {s.scope ? (
                      <Badge variant="outline">
                        {s.scope.country} · {String(s.scope.priceType).replace(/_/g, "-")}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">no market scope</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">{thresholdLabel(s)}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {s.notifyPush && <Smartphone className="h-4 w-4" />}
                      {s.notifySMS && <MessageSquare className="h-4 w-4" />}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">{s.triggerCount}×</TableCell>
                  <TableCell>
                    {s.isActive ? <Badge variant="default">active</Badge> : <Badge variant="secondary">inactive</Badge>}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => unsubscribeMutation.mutate({ priceAlertId: s.id })}
                      disabled={unsubscribeMutation.isPending}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

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

        <MarketSubscriptions />
      </div>
    </DashboardLayout>
  );
}
