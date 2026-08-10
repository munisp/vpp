import { useState, useEffect } from 'react';
import { usePushNotifications } from '@/hooks/usePushNotifications';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Bell, BellOff, Smartphone, TestTube, CheckCircle2, XCircle, Loader2, Mail } from 'lucide-react';
import { toast } from 'sonner';

export default function NotificationSettings() {
  const {
    isSupported,
    isSubscribed,
    isLoading,
    permission,
    subscribe,
    unsubscribe,
    sendTestNotification,
  } = usePushNotifications();

  const statusQuery = trpc.notifications?.getPushStatus.useQuery();
  const [isTesting, setIsTesting] = useState(false);

  // Fetch and manage preferences
  const { data: preferencesData } = trpc.notificationPreferences.get.useQuery();
  const updatePreferencesMutation = trpc.notificationPreferences.update.useMutation({
    onSuccess: () => {
      toast.success('Preferences updated');
    },
    onError: () => {
      toast.error('Failed to update preferences');
    },
  });

  const [preferences, setPreferences] = useState({
    pushTradeExecuted: true,
    pushTradeFailed: true,
    pushPaymentReceived: true,
    pushDREventCreated: true,
    pushDREventReminder: true,
    pushSystemAlert: true,
    pushBillingAlert: true,
    pushAchievementUnlocked: true,
    emailTradeExecuted: true,
    emailTradeFailed: true,
    emailPaymentReceived: true,
    emailDREventCreated: true,
    emailSystemAlert: true,
    emailWeeklySummary: false,
    emailMonthlySummary: false,
  });

  // Update local state when data loads
  useEffect(() => {
    if (preferencesData) {
      setPreferences({
        pushTradeExecuted: preferencesData.pushTradeExecuted,
        pushTradeFailed: preferencesData.pushTradeFailed,
        pushPaymentReceived: preferencesData.pushPaymentReceived,
        pushDREventCreated: preferencesData.pushDREventCreated,
        pushDREventReminder: preferencesData.pushDREventReminder,
        pushSystemAlert: preferencesData.pushSystemAlert,
        pushBillingAlert: preferencesData.pushBillingAlert,
        pushAchievementUnlocked: preferencesData.pushAchievementUnlocked,
        emailTradeExecuted: preferencesData.emailTradeExecuted ?? true,
        emailTradeFailed: preferencesData.emailTradeFailed ?? true,
        emailPaymentReceived: preferencesData.emailPaymentReceived ?? true,
        emailDREventCreated: preferencesData.emailDREventCreated ?? true,
        emailSystemAlert: preferencesData.emailSystemAlert ?? true,
        emailWeeklySummary: preferencesData.emailWeeklySummary ?? false,
        emailMonthlySummary: preferencesData.emailMonthlySummary ?? false,
      });
    }
  }, [preferencesData]);

  const handlePreferenceChange = async (key: keyof typeof preferences) => {
    const newValue = !preferences[key];
    setPreferences(prev => ({ ...prev, [key]: newValue }));
    
    // Save to backend
    try {
      await updatePreferencesMutation.mutateAsync({ [key]: newValue });
    } catch (error) {
      // Revert on error
      setPreferences(prev => ({ ...prev, [key]: !newValue }));
    }
  };

  const handleToggleSubscription = async () => {
    if (isSubscribed) {
      const success = await unsubscribe();
      if (success) {
        toast.success('Push notifications disabled');
        statusQuery.refetch();
      } else {
        toast.error('Failed to disable notifications');
      }
    } else {
      const success = await subscribe();
      if (success) {
        toast.success('Push notifications enabled');
        statusQuery.refetch();
      } else {
        toast.error('Failed to enable notifications. Please check permissions.');
      }
    }
  };

  const handleTestNotification = async () => {
    setIsTesting(true);
    try {
      await sendTestNotification();
      toast.success('Test notification sent! Check your device.');
    } catch (error) {
      toast.error('Failed to send test notification');
    } finally {
      setIsTesting(false);
    }
  };

  if (!isSupported) {
    return (
      <div className="container max-w-4xl py-8">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BellOff className="h-5 w-5" />
              Push Notifications Not Supported
            </CardTitle>
            <CardDescription>
              Your browser doesn't support push notifications. Please use a modern browser like Chrome, Firefox, or Safari.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="container max-w-4xl py-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Notification Settings</h1>
        <p className="text-muted-foreground mt-2">
          Manage your push notification preferences and test notifications
        </p>
      </div>

      {/* Subscription Status */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="h-5 w-5" />
            Push Notifications
          </CardTitle>
          <CardDescription>
            Receive real-time alerts for trading, payments, and demand response events
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Enable/Disable Toggle */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="push-enabled" className="text-base">
                Enable Push Notifications
              </Label>
              <p className="text-sm text-muted-foreground">
                {permission === 'granted'
                  ? 'Notifications are allowed'
                  : permission === 'denied'
                  ? 'Notifications are blocked. Please enable in browser settings.'
                  : 'Click to request notification permission'}
              </p>
            </div>
            <Switch
              id="push-enabled"
              checked={isSubscribed}
              onCheckedChange={handleToggleSubscription}
              disabled={isLoading || permission === 'denied'}
            />
          </div>

          {/* Status Indicators */}
          {isSubscribed && (
            <div className="space-y-3 pt-4 border-t">
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                <span>Notifications enabled on this device</span>
              </div>
              {statusQuery.data && statusQuery.data.deviceCount > 1 && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Smartphone className="h-4 w-4" />
                  <span>Active on {statusQuery.data.deviceCount} devices</span>
                </div>
              )}
            </div>
          )}

          {!isSubscribed && permission !== 'denied' && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground pt-4 border-t">
              <XCircle className="h-4 w-4" />
              <span>Notifications are currently disabled</span>
            </div>
          )}

          {/* Test Notification Button */}
          {isSubscribed && (
            <div className="pt-4 border-t">
              <Button
                onClick={handleTestNotification}
                disabled={isTesting || !isSubscribed}
                variant="outline"
                className="w-full sm:w-auto"
              >
                {isTesting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Sending...
                  </>
                ) : (
                  <>
                    <TestTube className="mr-2 h-4 w-4" />
                    Send Test Notification
                  </>
                )}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Notification Preferences */}
      <Card>
        <CardHeader>
          <CardTitle>Notification Preferences</CardTitle>
          <CardDescription>
            Choose which types of notifications you want to receive
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="trade-executed" className="text-base">
                Trade Executed
              </Label>
              <p className="text-sm text-muted-foreground">
                Get notified when your trades are completed
              </p>
            </div>
            <Switch 
              id="trade-executed" 
              checked={preferences.pushTradeExecuted}
              onCheckedChange={() => handlePreferenceChange('pushTradeExecuted')}
              disabled={!isSubscribed} 
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="trade-failed" className="text-base">
                Trade Failed
              </Label>
              <p className="text-sm text-muted-foreground">
                Get notified when trades fail
              </p>
            </div>
            <Switch 
              id="trade-failed" 
              checked={preferences.pushTradeFailed}
              onCheckedChange={() => handlePreferenceChange('pushTradeFailed')}
              disabled={!isSubscribed} 
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="payment-alerts" className="text-base">
                Payment Notifications
              </Label>
              <p className="text-sm text-muted-foreground">
                Payment confirmations, billing updates, and transaction alerts
              </p>
            </div>
            <Switch 
              id="payment-alerts" 
              checked={preferences.pushPaymentReceived}
              onCheckedChange={() => handlePreferenceChange('pushPaymentReceived')}
              disabled={!isSubscribed} 
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="dr-events" className="text-base">
                Demand Response Events
              </Label>
              <p className="text-sm text-muted-foreground">
                DR event invitations, participation confirmations, and rewards
              </p>
            </div>
            <Switch 
              id="dr-events" 
              checked={preferences.pushDREventCreated}
              onCheckedChange={() => handlePreferenceChange('pushDREventCreated')}
              disabled={!isSubscribed} 
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="dr-reminders" className="text-base">
                DR Event Reminders
              </Label>
              <p className="text-sm text-muted-foreground">
                Get reminders before DR events start
              </p>
            </div>
            <Switch 
              id="dr-reminders" 
              checked={preferences.pushDREventReminder}
              onCheckedChange={() => handlePreferenceChange('pushDREventReminder')}
              disabled={!isSubscribed} 
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="achievements" className="text-base">
                Achievement Unlocked
              </Label>
              <p className="text-sm text-muted-foreground">
                Get notified when you unlock new achievements
              </p>
            </div>
            <Switch 
              id="achievements" 
              checked={preferences.pushAchievementUnlocked}
              onCheckedChange={() => handlePreferenceChange('pushAchievementUnlocked')}
              disabled={!isSubscribed} 
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="system-alerts" className="text-base">
                System Alerts
              </Label>
              <p className="text-sm text-muted-foreground">
                Device status, maintenance notifications, and important updates
              </p>
            </div>
            <Switch 
              id="system-alerts" 
              checked={preferences.pushSystemAlert}
              onCheckedChange={() => handlePreferenceChange('pushSystemAlert')}
              disabled={!isSubscribed} 
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="billing-alerts" className="text-base">
                Billing Alerts
              </Label>
              <p className="text-sm text-muted-foreground">
                Billing and payment issue notifications
              </p>
            </div>
            <Switch 
              id="billing-alerts" 
              checked={preferences.pushBillingAlert}
              onCheckedChange={() => handlePreferenceChange('pushBillingAlert')}
              disabled={!isSubscribed} 
            />
          </div>
        </CardContent>
      </Card>

      {/* Email Notifications */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            Email Notifications
          </CardTitle>
          <CardDescription>
            Receive important updates via email
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="email-trade-executed" className="text-base">
                Trade Confirmations
              </Label>
              <p className="text-sm text-muted-foreground">
                Receive email when trades are executed or fail
              </p>
            </div>
            <Switch 
              id="email-trade-executed" 
              checked={preferences.emailTradeExecuted}
              onCheckedChange={() => handlePreferenceChange('emailTradeExecuted')}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="email-payment" className="text-base">
                Payment Receipts
              </Label>
              <p className="text-sm text-muted-foreground">
                Receive email receipts for payments and transactions
              </p>
            </div>
            <Switch 
              id="email-payment" 
              checked={preferences.emailPaymentReceived}
              onCheckedChange={() => handlePreferenceChange('emailPaymentReceived')}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="email-dr-events" className="text-base">
                DR Event Alerts
              </Label>
              <p className="text-sm text-muted-foreground">
                Receive email alerts for new demand response events
              </p>
            </div>
            <Switch 
              id="email-dr-events" 
              checked={preferences.emailDREventCreated}
              onCheckedChange={() => handlePreferenceChange('emailDREventCreated')}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="email-system" className="text-base">
                System Alerts
              </Label>
              <p className="text-sm text-muted-foreground">
                Important system notifications and maintenance updates
              </p>
            </div>
            <Switch 
              id="email-system" 
              checked={preferences.emailSystemAlert}
              onCheckedChange={() => handlePreferenceChange('emailSystemAlert')}
            />
          </div>

          <div className="border-t pt-4 mt-4">
            <h4 className="font-medium mb-4">Analytics Summaries (Admin Only)</h4>
            
            <div className="flex items-center justify-between mb-4">
              <div className="space-y-0.5">
                <Label htmlFor="email-weekly" className="text-base">
                  Weekly Summary
                </Label>
                <p className="text-sm text-muted-foreground">
                  Receive weekly analytics report every Monday
                </p>
              </div>
              <Switch 
                id="email-weekly" 
                checked={preferences.emailWeeklySummary}
                onCheckedChange={() => handlePreferenceChange('emailWeeklySummary')}
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="email-monthly" className="text-base">
                  Monthly Report
                </Label>
                <p className="text-sm text-muted-foreground">
                  Receive comprehensive monthly analytics on the 1st
                </p>
              </div>
              <Switch 
                id="email-monthly" 
                checked={preferences.emailMonthlySummary}
                onCheckedChange={() => handlePreferenceChange('emailMonthlySummary')}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Help Text */}
      <Card className="bg-muted/50">
        <CardHeader>
          <CardTitle className="text-base">About Push Notifications</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>
            Push notifications allow you to receive real-time updates even when the app is closed.
            You can manage notification permissions in your browser settings at any time.
          </p>
          <p>
            <strong>Privacy:</strong> Your notification subscription is stored securely and only used
            to send you relevant updates. You can unsubscribe at any time.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
