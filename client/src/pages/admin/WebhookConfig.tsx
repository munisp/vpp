import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { AlertCircle, Bell, CheckCircle, Loader2, Send, Webhook } from "lucide-react";
import { toast } from "sonner";

export default function WebhookConfig() {
  const { user } = useAuth();
  const utils = trpc.useUtils();

  const { data: config, isLoading } = trpc.webhookConfig.getConfig.useQuery(undefined, {
    enabled: user?.role === 'admin',
  });

  const testMutation = trpc.webhookConfig.testWebhook.useMutation({
    onSuccess: (data: any) => {
      if (data.success) {
        toast.success(data.message);
      } else {
        toast.error(data.message);
      }
    },
    onError: (error: any) => {
      toast.error(`Test failed: ${error.message}`);
    },
  });

  const sendTestMutation = trpc.webhookConfig.sendTestNotification.useMutation({
    onSuccess: (data: any) => {
      if (data.success) {
        toast.success(data.message);
      } else {
        toast.error(data.message);
      }
    },
    onError: (error: any) => {
      toast.error(`Failed to send: ${error.message}`);
    },
  });

  const handleTest = async () => {
    await testMutation.mutateAsync();
  };

  const handleSendTest = async (type: 'dr_event' | 'grid_stress' | 'system_alert') => {
    await sendTestMutation.mutateAsync({ type });
  };

  if (user?.role !== 'admin') {
    return (
      <div className="container py-8">
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <p className="text-muted-foreground">Admin access required</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="container py-8">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </div>
    );
  }

  return (
    <div className="container py-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Webhook Configuration</h1>
        <p className="text-muted-foreground">
          Configure webhook notifications for DR events and grid alerts
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Webhook Status</CardTitle>
            {config?.configured ? (
              <CheckCircle className="h-4 w-4 text-green-500" />
            ) : (
              <AlertCircle className="h-4 w-4 text-yellow-500" />
            )}
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {config?.configured ? 'Configured' : 'Not Configured'}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {config?.webhookUrl}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Connection Test</CardTitle>
            <Webhook className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <Button
              onClick={handleTest}
              disabled={!config?.configured || testMutation.isPending}
              className="w-full"
            >
              {testMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Testing...
                </>
              ) : (
                <>
                  <Send className="h-4 w-4 mr-2" />
                  Test Connection
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
          <CardDescription>
            Set the ALERT_WEBHOOK_URL environment variable to configure webhook notifications
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="p-4 rounded-lg border bg-muted/50">
            <p className="text-sm font-mono">ALERT_WEBHOOK_URL=https://your-webhook-url.com/endpoint</p>
          </div>

          <div className="space-y-2">
            <h3 className="font-semibold">Supported Webhook Events:</h3>
            <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
              <li>DR Event Triggered - Sent when automated DR events are created</li>
              <li>Grid Stress Detected - Sent when grid conditions exceed thresholds</li>
              <li>System Alerts - Sent for critical system notifications</li>
            </ul>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Test Notifications</CardTitle>
          <CardDescription>
            Send test notifications to verify webhook configuration
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-3">
            <Button
              onClick={() => handleSendTest('dr_event')}
              disabled={!config?.configured || sendTestMutation.isPending}
              variant="outline"
            >
              <Bell className="h-4 w-4 mr-2" />
              DR Event
            </Button>
            <Button
              onClick={() => handleSendTest('grid_stress')}
              disabled={!config?.configured || sendTestMutation.isPending}
              variant="outline"
            >
              <Bell className="h-4 w-4 mr-2" />
              Grid Stress
            </Button>
            <Button
              onClick={() => handleSendTest('system_alert')}
              disabled={!config?.configured || sendTestMutation.isPending}
              variant="outline"
            >
              <Bell className="h-4 w-4 mr-2" />
              System Alert
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Webhook Payload Format</CardTitle>
          <CardDescription>
            Example JSON payload structure sent to your webhook endpoint
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="p-4 rounded-lg bg-muted text-sm overflow-x-auto">
{`{
  "event": "dr_event_triggered",
  "severity": "warning",
  "timestamp": "2024-01-15T10:30:00Z",
  "source": "vpp_platform",
  "data": {
    "event_id": 123,
    "event_name": "Peak Demand Response",
    "target_reduction_kw": 500,
    "start_time": "2024-01-15T18:00:00Z",
    "end_time": "2024-01-15T20:00:00Z",
    "reason": "High grid load detected"
  }
}`}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
