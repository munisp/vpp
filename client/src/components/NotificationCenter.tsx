import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Bell, BellOff, Check, Settings, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useNotificationPermission } from "@/hooks/useNotificationPermission";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { formatDistanceToNow } from "date-fns";
import { useLocation } from "wouter";

export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const [, setLocation] = useLocation();
  const { permission, isSupported, requestPermission, isLoading } = useNotificationPermission();
  
  const { data: alertsData, isLoading: alertsLoading } = trpc.alerts.list.useQuery(
    { limit: 50 },
    { enabled: open }
  );
  
  const markAsReadMutation = trpc.alerts.markAsRead.useMutation({
    onSuccess: () => {
      utils.alerts.list.invalidate();
    },
  });
  
  const utils = trpc.useUtils();
  
  const alerts = alertsData?.alerts || [];
  const unread = alerts.filter(a => !a.isRead).length;

  const handleEnableNotifications = async () => {
    const success = await requestPermission();
    if (success) {
      toast.success("Notifications enabled! You'll now receive real-time updates.");
    }
  };

  const handleMarkAsRead = (alertId: number) => {
    markAsReadMutation.mutate({ alertId });
  };

  const handleMarkAllAsRead = async () => {
    // Mark all unread alerts as read
    const unreadAlerts = alerts.filter(a => !a.isRead);
    for (const alert of unreadAlerts) {
      await markAsReadMutation.mutateAsync({ alertId: alert.id });
    }
    toast.success("All notifications marked as read");
  };

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case "critical":
        return "bg-red-100 text-red-800 border-red-200";
      case "error":
        return "bg-orange-100 text-orange-800 border-orange-200";
      case "warning":
        return "bg-yellow-100 text-yellow-800 border-yellow-200";
      default:
        return "bg-blue-100 text-blue-800 border-blue-200";
    }
  };

  const getAlertTypeIcon = (type: string) => {
    switch (type) {
      case "trading":
        return "💰";
      case "billing":
        return "💳";
      case "maintenance":
        return "🔧";
      case "referral":
        return "🎁";
      case "qr_payment":
        return "📱";
      case "reward":
        return "🏆";
      default:
        return "ℹ️";
    }
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="h-5 w-5" />
          {unread > 0 && (
            <Badge
              variant="destructive"
              className="absolute -top-1 -right-1 h-5 w-5 flex items-center justify-center p-0 text-xs"
            >
              {unread > 9 ? "9+" : unread}
            </Badge>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center justify-between">
            <span>Notifications</span>
            {unread > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleMarkAllAsRead}
                disabled={markAsReadMutation.isPending}
              >
                <Check className="h-4 w-4 mr-1" />
                Mark all read
              </Button>
            )}
          </SheetTitle>
          <SheetDescription>
            Stay updated with your energy trading and system alerts
          </SheetDescription>
        </SheetHeader>

        {/* Notification Permission Banner */}
        {isSupported && permission !== "granted" && (
          <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <div className="flex items-start gap-3">
              <Bell className="h-5 w-5 text-blue-600 mt-0.5" />
              <div className="flex-1">
                <h4 className="font-medium text-sm text-blue-900">Enable Push Notifications</h4>
                <p className="text-xs text-blue-700 mt-1">
                  Get real-time alerts for trades, DR events, and system updates
                </p>
                <Button
                  size="sm"
                  className="mt-2"
                  onClick={handleEnableNotifications}
                  disabled={isLoading}
                >
                  {isLoading ? "Enabling..." : "Enable Notifications"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {permission === "denied" && (
          <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg">
            <div className="flex items-start gap-3">
              <BellOff className="h-5 w-5 text-red-600 mt-0.5" />
              <div className="flex-1">
                <h4 className="font-medium text-sm text-red-900">Notifications Blocked</h4>
                <p className="text-xs text-red-700 mt-1">
                  Please enable notifications in your browser settings to receive alerts
                </p>
              </div>
            </div>
          </div>
        )}

        <Separator className="my-4" />

        {/* Notifications List */}
        <ScrollArea className="h-[calc(100vh-300px)]">
          {alertsLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600" />
            </div>
          ) : alerts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Bell className="h-12 w-12 text-muted-foreground mb-3" />
              <h3 className="font-medium text-sm">No notifications yet</h3>
              <p className="text-xs text-muted-foreground mt-1">
                You'll see updates about your energy trading here
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {alerts.map((alert) => (
                <div
                  key={alert.id}
                  className={`p-3 rounded-lg border transition-colors ${
                    alert.isRead
                      ? "bg-background"
                      : "bg-muted/50 border-primary/20"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <span className="text-2xl">{getAlertTypeIcon(alert.alertType)}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <h4 className="font-medium text-sm">{alert.title}</h4>
                        {!alert.isRead && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 shrink-0"
                            onClick={() => handleMarkAsRead(alert.id)}
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                        {alert.message}
                      </p>
                      <div className="flex items-center gap-2 mt-2">
                        <Badge
                          variant="outline"
                          className={`text-xs ${getSeverityColor(alert.severity)}`}
                        >
                          {alert.severity}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {formatDistanceToNow(new Date(alert.createdAt), { addSuffix: true })}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>

        {/* Footer */}
        <div className="mt-4 pt-4 border-t">
          <Button
            variant="outline"
            className="w-full"
            size="sm"
            onClick={() => {
              setOpen(false);
              setLocation("/notification-settings");
            }}
          >
            <Settings className="h-4 w-4 mr-2" />
            Notification Settings
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
