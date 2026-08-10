import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { AlertCircle, AlertTriangle, Bell, CheckCircle2, Info, Trash2, XCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";

export default function Alerts() {
  const [selectedType, setSelectedType] = useState<"all" | "system" | "trading" | "billing" | "maintenance">("all");
  const [selectedSeverity, setSelectedSeverity] = useState<"all" | "info" | "warning" | "error" | "critical">("all");

  const utils = trpc.useUtils();
  const { data: alertsData, isLoading } = trpc.alerts.list.useQuery({ limit: 50 });
  const alerts = alertsData?.alerts || [];

  const markAsReadMutation = trpc.alerts.markAsRead.useMutation({
    onSuccess: () => {
      toast.success("Alert marked as read");
      utils.alerts.list.invalidate();
    },
    onError: (error: any) => {
      toast.error(error.message || "Failed to mark alert as read");
    },
  });

  const deleteAlertMutation = trpc.alerts.delete.useMutation({
    onSuccess: () => {
      toast.success("Alert deleted");
      utils.alerts.list.invalidate();
    },
    onError: (error: any) => {
      toast.error(error.message || "Failed to delete alert");
    },
  });

  // Filter alerts
  const filteredAlerts = alerts.filter((alert: any) => {
    const typeMatch = selectedType === "all" || alert.alertType === selectedType;
    const severityMatch = selectedSeverity === "all" || alert.severity === selectedSeverity;
    return typeMatch && severityMatch;
  });

  // Group by severity
  const groupedAlerts = {
    critical: filteredAlerts.filter((a: any) => a.severity === "critical"),
    error: filteredAlerts.filter((a: any) => a.severity === "error"),
    warning: filteredAlerts.filter((a: any) => a.severity === "warning"),
    info: filteredAlerts.filter((a: any) => a.severity === "info"),
  };

  const unreadCount = alerts.filter((a: any) => !a.isRead).length;

  const getSeverityIcon = (severity: string) => {
    switch (severity) {
      case "critical":
        return <XCircle className="h-5 w-5 text-red-600" />;
      case "error":
        return <AlertCircle className="h-5 w-5 text-red-500" />;
      case "warning":
        return <AlertTriangle className="h-5 w-5 text-amber-500" />;
      case "info":
        return <Info className="h-5 w-5 text-blue-500" />;
      default:
        return <Bell className="h-5 w-5" />;
    }
  };

  const getSeverityBadge = (severity: string) => {
    const variants: Record<string, { variant: "default" | "secondary" | "destructive", label: string, className: string }> = {
      critical: { variant: "destructive", label: "Critical", className: "bg-red-600" },
      error: { variant: "destructive", label: "Error", className: "bg-red-500" },
      warning: { variant: "secondary", label: "Warning", className: "bg-amber-500 text-white" },
      info: { variant: "secondary", label: "Info", className: "bg-blue-500 text-white" },
    };
    const config = variants[severity] || variants.info;
    return <Badge variant={config.variant} className={config.className}>{config.label}</Badge>;
  };

  const getTypeBadge = (type: string) => {
    const labels: Record<string, string> = {
      system: "System",
      trading: "Trading",
      billing: "Billing",
      maintenance: "Maintenance",
    };
    return <Badge variant="outline">{labels[type] || type}</Badge>;
  };

  const handleMarkAsRead = (id: number) => {
    markAsReadMutation.mutate({ alertId: id });
  };

  const handleDelete = (id: number) => {
    deleteAlertMutation.mutate({ alertId: id });
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Alerts</h1>
            <p className="text-muted-foreground mt-2">
              View and manage system notifications and alerts.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-lg px-3 py-1">
              {unreadCount} Unread
            </Badge>
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Critical</CardTitle>
              <XCircle className="h-4 w-4 text-red-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-600">{groupedAlerts.critical.length}</div>
              <p className="text-xs text-muted-foreground mt-1">Requires immediate attention</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Errors</CardTitle>
              <AlertCircle className="h-4 w-4 text-red-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-500">{groupedAlerts.error.length}</div>
              <p className="text-xs text-muted-foreground mt-1">Action required</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Warnings</CardTitle>
              <AlertTriangle className="h-4 w-4 text-amber-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-amber-600">{groupedAlerts.warning.length}</div>
              <p className="text-xs text-muted-foreground mt-1">Review recommended</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Info</CardTitle>
              <Info className="h-4 w-4 text-blue-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-blue-600">{groupedAlerts.info.length}</div>
              <p className="text-xs text-muted-foreground mt-1">Informational</p>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <div className="flex gap-4">
          <Select value={selectedType} onValueChange={(value: any) => setSelectedType(value)}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Filter by type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="trading">Trading</SelectItem>
              <SelectItem value="billing">Billing</SelectItem>
              <SelectItem value="maintenance">Maintenance</SelectItem>
            </SelectContent>
          </Select>

          <Select value={selectedSeverity} onValueChange={(value: any) => setSelectedSeverity(value)}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Filter by severity" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Severities</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
              <SelectItem value="error">Error</SelectItem>
              <SelectItem value="warning">Warning</SelectItem>
              <SelectItem value="info">Info</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Alerts List */}
        <div className="space-y-4">
          {isLoading ? (
            <>
              {[1, 2, 3, 4].map((i) => (
                <Card key={i}>
                  <CardContent className="p-6">
                    <Skeleton className="h-20 w-full" />
                  </CardContent>
                </Card>
              ))}
            </>
          ) : filteredAlerts.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-12">
                <CheckCircle2 className="h-12 w-12 text-green-600 mb-4" />
                <h3 className="text-lg font-semibold mb-2">All clear!</h3>
                <p className="text-sm text-muted-foreground text-center">
                  {selectedType === "all" && selectedSeverity === "all"
                    ? "You don't have any alerts at the moment."
                    : "No alerts match your current filters."}
                </p>
              </CardContent>
            </Card>
          ) : (
            filteredAlerts.map((alert: any) => (
              <Card
                key={alert.id}
                className={`${!alert.isRead ? "border-l-4 border-l-primary bg-primary/5" : ""}`}
              >
                <CardContent className="p-6">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-4 flex-1">
                      <div className="p-3 rounded-lg bg-muted">
                        {getSeverityIcon(alert.severity)}
                      </div>
                      <div className="flex-1 space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-semibold text-lg">{alert.title}</h3>
                          {!alert.isRead && (
                            <Badge variant="default" className="text-xs">New</Badge>
                          )}
                          {getSeverityBadge(alert.severity)}
                          {getTypeBadge(alert.alertType)}
                        </div>
                        <p className="text-muted-foreground">{alert.message}</p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(alert.createdAt).toLocaleString()}
                          {alert.readAt && ` • Read ${new Date(alert.readAt).toLocaleString()}`}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      {!alert.isRead && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleMarkAsRead(alert.id)}
                          disabled={markAsReadMutation.isPending}
                        >
                          <CheckCircle2 className="h-4 w-4 mr-2" />
                          Mark Read
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(alert.id)}
                        disabled={deleteAlertMutation.isPending}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
