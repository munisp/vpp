import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Bell, Mail, MessageSquare, Smartphone } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export default function NotificationPreferences() {
  const [preferences, setPreferences] = useState({
    email: {
      payments: true,
      tokens: true,
      trading: false,
      billing: true,
      systemUpdates: false,
    },
    sms: {
      payments: false,
      tokens: true,
      trading: false,
      billing: false,
    },
    push: {
      payments: true,
      tokens: true,
      trading: true,
      billing: true,
      systemUpdates: true,
    },
  });

  const handleToggle = (channel: 'email' | 'sms' | 'push', type: string) => {
    setPreferences(prev => {
      const channelPrefs = prev[channel] as any;
      return {
        ...prev,
        [channel]: {
          ...channelPrefs,
          [type]: !channelPrefs[type],
        },
      };
    });
    toast.success("Notification preference updated");
  };

  return (
    <div className="space-y-6">
      {/* Email Notifications */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-50">
              <Mail className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <CardTitle>Email Notifications</CardTitle>
              <CardDescription>
                Receive notifications via email
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Payment Confirmations</Label>
              <p className="text-sm text-muted-foreground">
                Get notified when payments are processed
              </p>
            </div>
            <Switch
              checked={preferences.email.payments}
              onCheckedChange={() => handleToggle('email', 'payments')}
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Token Generation</Label>
              <p className="text-sm text-muted-foreground">
                Receive your prepaid tokens via email
              </p>
            </div>
            <Switch
              checked={preferences.email.tokens}
              onCheckedChange={() => handleToggle('email', 'tokens')}
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Trading Updates</Label>
              <p className="text-sm text-muted-foreground">
                Get updates on your energy trading activities
              </p>
            </div>
            <Switch
              checked={preferences.email.trading}
              onCheckedChange={() => handleToggle('email', 'trading')}
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Billing Reminders</Label>
              <p className="text-sm text-muted-foreground">
                Receive reminders for upcoming bills
              </p>
            </div>
            <Switch
              checked={preferences.email.billing}
              onCheckedChange={() => handleToggle('email', 'billing')}
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>System Updates</Label>
              <p className="text-sm text-muted-foreground">
                Get notified about platform updates and maintenance
              </p>
            </div>
            <Switch
              checked={preferences.email.systemUpdates}
              onCheckedChange={() => handleToggle('email', 'systemUpdates')}
            />
          </div>
        </CardContent>
      </Card>

      {/* SMS Notifications */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-green-50">
              <MessageSquare className="h-5 w-5 text-green-600" />
            </div>
            <div>
              <CardTitle>SMS Notifications</CardTitle>
              <CardDescription>
                Receive notifications via text message
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Payment Confirmations</Label>
              <p className="text-sm text-muted-foreground">
                SMS alerts for successful payments
              </p>
            </div>
            <Switch
              checked={preferences.sms.payments}
              onCheckedChange={() => handleToggle('sms', 'payments')}
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Token Codes</Label>
              <p className="text-sm text-muted-foreground">
                Receive token codes directly via SMS
              </p>
            </div>
            <Switch
              checked={preferences.sms.tokens}
              onCheckedChange={() => handleToggle('sms', 'tokens')}
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Trading Alerts</Label>
              <p className="text-sm text-muted-foreground">
                SMS notifications for trading opportunities
              </p>
            </div>
            <Switch
              checked={preferences.sms.trading}
              onCheckedChange={() => handleToggle('sms', 'trading')}
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Billing Alerts</Label>
              <p className="text-sm text-muted-foreground">
                SMS reminders for due payments
              </p>
            </div>
            <Switch
              checked={preferences.sms.billing}
              onCheckedChange={() => handleToggle('sms', 'billing')}
            />
          </div>
        </CardContent>
      </Card>

      {/* Push Notifications */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-purple-50">
              <Smartphone className="h-5 w-5 text-purple-600" />
            </div>
            <div>
              <CardTitle>Push Notifications</CardTitle>
              <CardDescription>
                Receive real-time browser notifications
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Payment Updates</Label>
              <p className="text-sm text-muted-foreground">
                Instant notifications for payment status
              </p>
            </div>
            <Switch
              checked={preferences.push.payments}
              onCheckedChange={() => handleToggle('push', 'payments')}
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Token Ready</Label>
              <p className="text-sm text-muted-foreground">
                Get notified when your token is generated
              </p>
            </div>
            <Switch
              checked={preferences.push.tokens}
              onCheckedChange={() => handleToggle('push', 'tokens')}
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Trading Opportunities</Label>
              <p className="text-sm text-muted-foreground">
                Real-time alerts for favorable trading prices
              </p>
            </div>
            <Switch
              checked={preferences.push.trading}
              onCheckedChange={() => handleToggle('push', 'trading')}
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Billing Reminders</Label>
              <p className="text-sm text-muted-foreground">
                Push notifications for upcoming bills
              </p>
            </div>
            <Switch
              checked={preferences.push.billing}
              onCheckedChange={() => handleToggle('push', 'billing')}
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>System Alerts</Label>
              <p className="text-sm text-muted-foreground">
                Important system notifications and updates
              </p>
            </div>
            <Switch
              checked={preferences.push.systemUpdates}
              onCheckedChange={() => handleToggle('push', 'systemUpdates')}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
