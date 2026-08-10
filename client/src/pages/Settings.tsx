import DashboardLayout from "@/components/DashboardLayout";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertTriangle, Bell, Mail, Shield, User, Fingerprint, ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

type NotificationPrefs = {
  emailPaymentReceived: boolean;
  emailTradeExecuted: boolean;
  emailTradeFailed: boolean;
  emailSystemAlert: boolean;
  emailWeeklySummary: boolean;
  emailMonthlySummary: boolean;
  pushPaymentReceived: boolean;
  pushTradeExecuted: boolean;
  pushTradeFailed: boolean;
  pushBillingAlert: boolean;
  pushSystemAlert: boolean;
  pushDREventReminder: boolean;
};

export default function Settings() {
  const { user } = useAuth();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  // Real notification preferences from the server
  const prefsQuery = trpc.notificationPreferences.get.useQuery();
  const updatePrefsMutation = trpc.notificationPreferences.update.useMutation({
    onSuccess: () => {
      toast.success("Preference updated");
    },
    onError: () => {
      toast.error("Failed to update preference");
    },
  });

  const [preferences, setPreferences] = useState<NotificationPrefs | null>(null);

  useEffect(() => {
    if (prefsQuery.data) {
      const d = prefsQuery.data;
      setPreferences({
        emailPaymentReceived: d.emailPaymentReceived,
        emailTradeExecuted: d.emailTradeExecuted,
        emailTradeFailed: d.emailTradeFailed,
        emailSystemAlert: d.emailSystemAlert,
        emailWeeklySummary: d.emailWeeklySummary,
        emailMonthlySummary: d.emailMonthlySummary,
        pushPaymentReceived: d.pushPaymentReceived,
        pushTradeExecuted: d.pushTradeExecuted,
        pushTradeFailed: d.pushTradeFailed,
        pushBillingAlert: d.pushBillingAlert,
        pushSystemAlert: d.pushSystemAlert,
        pushDREventReminder: d.pushDREventReminder,
      });
    }
  }, [prefsQuery.data]);

  const handlePreferenceChange = async (key: keyof NotificationPrefs, value: boolean) => {
    if (!preferences) return;
    setPreferences({ ...preferences, [key]: value });
    try {
      await updatePrefsMutation.mutateAsync({ [key]: value });
    } catch {
      // Revert on failure
      setPreferences({ ...preferences, [key]: !value });
    }
  };

  const handleDeleteAccount = () => {
    setIsDeleteDialogOpen(false);
    toast.info("Account deletion is handled by our support team", {
      description: "Please contact support to permanently delete your account and data.",
    });
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
          <p className="text-muted-foreground mt-2">
            Manage your account settings and preferences.
          </p>
        </div>

        <Tabs defaultValue="profile" className="space-y-4">
          <TabsList>
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="notifications">Notifications</TabsTrigger>
            <TabsTrigger value="preferences">Preferences</TabsTrigger>
            <TabsTrigger value="security">Security</TabsTrigger>
          </TabsList>

          <TabsContent value="profile" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Profile Information</CardTitle>
                <CardDescription>
                  Your account details from the VPP authentication system
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-4">
                  <div className="h-20 w-20 rounded-full bg-primary/10 flex items-center justify-center">
                    <User className="h-10 w-10 text-primary" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold">{user?.name || "User"}</h3>
                    <p className="text-sm text-muted-foreground">{user?.email || "No email"}</p>
                  </div>
                </div>

                <div className="grid gap-4 pt-4">
                  <div className="grid gap-2">
                    <Label>Full Name</Label>
                    <Input value={user?.name || ""} disabled />
                    <p className="text-xs text-muted-foreground">
                      Managed by VPP authentication system
                    </p>
                  </div>

                  <div className="grid gap-2">
                    <Label>Email Address</Label>
                    <Input value={user?.email || ""} disabled />
                    <p className="text-xs text-muted-foreground">
                      Managed by VPP authentication system
                    </p>
                  </div>

                  <div className="grid gap-2">
                    <Label>Login Method</Label>
                    <Input value={user?.loginMethod || "OAuth"} disabled />
                  </div>

                  <div className="grid gap-2">
                    <Label>Account Role</Label>
                    <Input value={user?.role || "user"} disabled className="capitalize" />
                  </div>
                </div>
              </CardContent>
            </Card>

          </TabsContent>

          <TabsContent value="notifications" className="space-y-4">
            {prefsQuery.isLoading ? (
              <Card>
                <CardContent className="space-y-4 pt-6">
                  {[1, 2, 3, 4].map((i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </CardContent>
              </Card>
            ) : prefsQuery.isError || !preferences ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <Bell className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
                  <p className="text-sm text-muted-foreground">
                    Notification preferences are unavailable right now. Please try again later.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <>
                <Card>
                  <CardHeader>
                    <CardTitle>Email Notifications</CardTitle>
                    <CardDescription>
                      Choose which emails you want to receive
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    {([
                      ["emailPaymentReceived", "Payment Received", "Email when a payment is received or confirmed"],
                      ["emailTradeExecuted", "Trade Executed", "Email when one of your trades is executed"],
                      ["emailTradeFailed", "Trade Failed", "Email when one of your trades fails"],
                      ["emailSystemAlert", "System Alerts", "Emails about system status and maintenance"],
                      ["emailWeeklySummary", "Weekly Summary", "A weekly summary of your activity"],
                      ["emailMonthlySummary", "Monthly Summary", "A monthly summary of your activity"],
                    ] as const).map(([key, label, description]) => (
                      <div key={key} className="flex items-center justify-between">
                        <div className="space-y-0.5">
                          <Label className="flex items-center gap-2">
                            <Mail className="h-4 w-4" />
                            {label}
                          </Label>
                          <p className="text-sm text-muted-foreground">{description}</p>
                        </div>
                        <Switch
                          checked={preferences[key]}
                          onCheckedChange={(checked) => handlePreferenceChange(key, checked)}
                          disabled={updatePrefsMutation.isPending}
                        />
                      </div>
                    ))}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Push Notifications</CardTitle>
                    <CardDescription>
                      Choose which push notifications you want to receive
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    {([
                      ["pushPaymentReceived", "Payment Received", "Push notification when a payment is received"],
                      ["pushTradeExecuted", "Trade Executed", "Push notification when a trade is executed"],
                      ["pushTradeFailed", "Trade Failed", "Push notification when a trade fails"],
                      ["pushBillingAlert", "Billing Alerts", "Push notifications about invoices and payments"],
                      ["pushSystemAlert", "System Alerts", "Push notifications about system status"],
                      ["pushDREventReminder", "DR Event Reminders", "Reminders about upcoming demand-response events"],
                    ] as const).map(([key, label, description]) => (
                      <div key={key} className="flex items-center justify-between">
                        <div className="space-y-0.5">
                          <Label className="flex items-center gap-2">
                            <Bell className="h-4 w-4" />
                            {label}
                          </Label>
                          <p className="text-sm text-muted-foreground">{description}</p>
                        </div>
                        <Switch
                          checked={preferences[key]}
                          onCheckedChange={(checked) => handlePreferenceChange(key, checked)}
                          disabled={updatePrefsMutation.isPending}
                        />
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </>
            )}
          </TabsContent>

          <TabsContent value="preferences" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Regional & Display Settings</CardTitle>
                <CardDescription>
                  Language, timezone, currency, and unit preferences
                </CardDescription>
              </CardHeader>
              <CardContent className="py-8 text-center">
                <p className="text-sm text-muted-foreground">
                  These preferences are not yet connected to your account. Language,
                  timezone, currency, and unit settings cannot be changed here at
                  this time.
                </p>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="security" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Account Security</CardTitle>
                <CardDescription>
                  Manage your account security settings
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-4 p-4 border rounded-lg">
                  <Shield className="h-8 w-8 text-green-600" />
                  <div className="flex-1">
                    <h4 className="font-semibold">Authentication</h4>
                    <p className="text-sm text-muted-foreground">
                      Your account is secured with VPP OAuth authentication
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Last Sign In</Label>
                  <Input
                    value={user?.lastSignedIn ? new Date(user.lastSignedIn).toLocaleString() : "N/A"}
                    disabled
                  />
                </div>

                <div className="space-y-2">
                  <Label>Account Created</Label>
                  <Input
                    value={user?.createdAt ? new Date(user.createdAt).toLocaleString() : "N/A"}
                    disabled
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Fingerprint className="h-5 w-5" />
                  Biometric Authentication
                </CardTitle>
                <CardDescription>
                  Use fingerprint or Face ID for quick and secure login
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  onClick={() => window.location.href = "/biometric-settings"}
                  className="gap-2"
                >
                  Manage Biometric Settings
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </CardContent>
            </Card>

            <Card className="border-red-200">
              <CardHeader>
                <CardTitle className="text-red-600">Danger Zone</CardTitle>
                <CardDescription>
                  Irreversible actions that affect your account
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-start gap-4 p-4 border border-red-200 rounded-lg bg-red-50/50">
                  <AlertTriangle className="h-6 w-6 text-red-600 mt-0.5" />
                  <div className="flex-1">
                    <h4 className="font-semibold text-red-900">Delete Account</h4>
                    <p className="text-sm text-red-700 mt-1">
                      Once you delete your account, there is no going back. This will permanently delete
                      your profile, assets, and all associated data.
                    </p>
                    <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
                      <DialogTrigger asChild>
                        <Button variant="destructive" className="mt-4">
                          Delete Account
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Delete your account?</DialogTitle>
                          <DialogDescription>
                            Account deletion is permanent and removes your profile, assets,
                            and all associated data.
                          </DialogDescription>
                        </DialogHeader>
                        <div className="py-4">
                          <p className="text-sm text-muted-foreground">
                            Self-service account deletion is not available. Our support team
                            handles verified deletion requests to protect your data.
                          </p>
                        </div>
                        <DialogFooter>
                          <Button variant="outline" onClick={() => setIsDeleteDialogOpen(false)}>
                            Cancel
                          </Button>
                          <Button variant="destructive" onClick={handleDeleteAccount}>
                            Contact Support
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
