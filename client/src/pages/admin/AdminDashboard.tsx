import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { Users, Zap, DollarSign, TrendingUp, Activity, AlertCircle, Gauge, CreditCard, BarChart3, CheckCircle, Brain, Workflow, Grid3x3, Monitor, Cpu, Bell, RefreshCw } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/_core/hooks/useAuth";
import { Redirect, useLocation } from "wouter";

export default function AdminDashboard() {
  const { user, loading } = useAuth();
  const [, setLocation] = useLocation();
  const statsQuery = trpc.admin.getSystemStats.useQuery();
  const { data: stats, isLoading, isError: statsError, error: statsErrorMsg } = statsQuery;
  // Real health signal from the performance monitor (5-minute window).
  const healthQuery = trpc.performance.getHealth.useQuery();
  const health = healthQuery.data;

  // Check if user is admin
  if (!loading && user?.role !== 'admin') {
    return <Redirect to="/" />;
  }

  const metrics = [
    {
      title: "Total Users",
      value: stats?.users.total || 0,
      subtitle: `${stats?.users.active || 0} active`,
      icon: Users,
      color: "text-blue-600",
      bgColor: "bg-blue-50",
    },
    {
      title: "Total Assets",
      value: stats?.assets.total || 0,
      subtitle: `${((stats?.assets.totalCapacity || 0) / 1000).toFixed(1)} kW capacity`,
      icon: Zap,
      color: "text-green-600",
      bgColor: "bg-green-50",
    },
    {
      title: "Total Revenue",
      value: `TZS ${((stats?.revenue.total || 0) / 100).toLocaleString()}`,
      subtitle: `${stats?.revenue.pendingPayments || 0} pending`,
      icon: DollarSign,
      color: "text-yellow-600",
      bgColor: "bg-yellow-50",
    },
    {
      title: "Energy Traded",
      value: `${((stats?.trading.totalEnergyTraded || 0) / 1000).toFixed(1)} MWh`,
      subtitle: `${stats?.trading.totalTrades || 0} trades`,
      icon: TrendingUp,
      color: "text-purple-600",
      bgColor: "bg-purple-50",
    },
  ];

  // Only signals with a real source are listed. There is no health probe for
  // the WebSocket server or payment gateways, so those rows do not exist here.
  const healthRows: Array<{ label: string; ok: boolean }> = health
    ? [
        { label: "API Server", ok: health.checks.api },
        { label: "Database", ok: health.checks.database },
        { label: "External APIs", ok: health.checks.externalApi },
      ]
    : [];

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Admin Dashboard</h1>
          <p className="text-muted-foreground mt-2">
            System overview and management for VPP operators.
          </p>
        </div>

        {/* Metrics Grid */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {metrics.map((metric, index) => (
            <Card key={index}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{metric.title}</CardTitle>
                <div className={`p-2 rounded-lg ${metric.bgColor}`}>
                  <metric.icon className={`h-4 w-4 ${metric.color}`} />
                </div>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <div className="space-y-2">
                    <Skeleton className="h-8 w-24" />
                    <Skeleton className="h-4 w-32" />
                  </div>
                ) : statsError ? (
                  <p className="text-sm text-red-600">Unavailable</p>
                ) : (
                  <>
                    <div className="text-2xl font-bold">{metric.value}</div>
                    <p className="text-xs text-muted-foreground mt-1">{metric.subtitle}</p>
                  </>
                )}
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Quick Actions */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Card className="hover:shadow-lg transition-shadow cursor-pointer" onClick={() => setLocation('/admin/users')}>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-lg bg-blue-50">
                  <Users className="h-6 w-6 text-blue-600" />
                </div>
                <div>
                  <CardTitle>User Management</CardTitle>
                  <CardDescription>Manage user accounts and roles</CardDescription>
                </div>
              </div>
            </CardHeader>
          </Card>

          <Card className="hover:shadow-lg transition-shadow cursor-pointer" onClick={() => setLocation('/admin/assets')}>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-lg bg-green-50">
                  <Zap className="h-6 w-6 text-green-600" />
                </div>
                <div>
                  <CardTitle>Asset Approvals</CardTitle>
                  <CardDescription>Review and approve asset registrations</CardDescription>
                </div>
              </div>
            </CardHeader>
          </Card>

          <Card className="hover:shadow-lg transition-shadow cursor-pointer" onClick={() => setLocation('/admin/pricing')}>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-lg bg-yellow-50">
                  <DollarSign className="h-6 w-6 text-yellow-600" />
                </div>
                <div>
                  <CardTitle>Market Pricing</CardTitle>
                  <CardDescription>Set energy trading prices</CardDescription>
                </div>
              </div>
            </CardHeader>
          </Card>

          <Card className="hover:shadow-lg transition-shadow cursor-pointer" onClick={() => setLocation('/admin/devices')}>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-lg bg-purple-50">
                  <Activity className="h-6 w-6 text-purple-600" />
                </div>
                <div>
                  <CardTitle>Device Management</CardTitle>
                  <CardDescription>Manage IoT devices and sensors</CardDescription>
                </div>
              </div>
            </CardHeader>
          </Card>

          <Card className="hover:shadow-lg transition-shadow cursor-pointer" onClick={() => setLocation('/admin/demand-response')}>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-lg bg-emerald-50">
                  <Gauge className="h-6 w-6 text-emerald-600" />
                </div>
                <div>
                  <CardTitle>Demand Response</CardTitle>
                  <CardDescription>Manage DR events and participants</CardDescription>
                </div>
              </div>
            </CardHeader>
          </Card>

          <Card className="hover:shadow-lg transition-shadow cursor-pointer" onClick={() => setLocation('/admin/dr-automation')}>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-lg bg-indigo-50">
                  <Workflow className="h-6 w-6 text-indigo-600" />
                </div>
                <div>
                  <CardTitle>DR Automation</CardTitle>
                  <CardDescription>Configure automated event triggering</CardDescription>
                </div>
              </div>
            </CardHeader>
          </Card>

          <Card className="hover:shadow-lg transition-shadow cursor-pointer" onClick={() => setLocation('/admin/webhook-config')}>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-lg bg-pink-50">
                  <Bell className="h-6 w-6 text-pink-600" />
                </div>
                <div>
                  <CardTitle>Webhook Alerts</CardTitle>
                  <CardDescription>Configure notification webhooks</CardDescription>
                </div>
              </div>
            </CardHeader>
          </Card>

          <Card className="hover:shadow-lg transition-shadow cursor-pointer" onClick={() => setLocation('/admin/payment-credentials')}>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-lg bg-orange-50">
                  <CreditCard className="h-6 w-6 text-orange-600" />
                </div>
                <div>
                  <CardTitle>Payment Gateways</CardTitle>
                  <CardDescription>Configure mobile money credentials</CardDescription>
                </div>
              </div>
            </CardHeader>
          </Card>

          <Card className="hover:shadow-lg transition-shadow cursor-pointer" onClick={() => setLocation('/admin/reconciliation')}>            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-lg bg-teal-50">
                  <CheckCircle className="h-6 w-6 text-teal-600" />
                </div>
                <div>
                  <CardTitle>Payment Reconciliation</CardTitle>
                  <CardDescription>Manage payment discrepancies</CardDescription>
                </div>
              </div>
            </CardHeader>
          </Card>

          <Card className="hover:shadow-lg transition-shadow cursor-pointer" onClick={() => setLocation('/admin/analytics-dashboard')}>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-lg bg-indigo-50">
                  <BarChart3 className="h-6 w-6 text-indigo-600" />
                </div>
                <div>
                  <CardTitle>Analytics Dashboard</CardTitle>
                  <CardDescription>View comprehensive platform metrics and charts</CardDescription>
                </div>
              </div>
            </CardHeader>
          </Card>

          <Card className="hover:shadow-lg transition-shadow cursor-pointer" onClick={() => setLocation('/admin/audit-logs')}>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-lg bg-red-50">
                  <AlertCircle className="h-6 w-6 text-red-600" />
                </div>
                <div>
                  <CardTitle>Audit Logs</CardTitle>
                  <CardDescription>Track all admin and critical user actions</CardDescription>
                </div>
              </div>
            </CardHeader>
          </Card>

          <Card className="hover:shadow-lg transition-shadow cursor-pointer" onClick={() => setLocation('/admin/ml-predictions')}>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-lg bg-violet-50">
                  <Brain className="h-6 w-6 text-violet-600" />
                </div>
                <div>
                  <CardTitle>ML Predictions</CardTitle>
                  <CardDescription>Price forecasting and trading insights</CardDescription>
                </div>
              </div>
            </CardHeader>
          </Card>

          <Card className="hover:shadow-lg transition-shadow cursor-pointer" onClick={() => setLocation('/admin/workflows')}>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-lg bg-pink-50">
                  <Workflow className="h-6 w-6 text-pink-600" />
                </div>
                <div>
                  <CardTitle>Workflow Monitoring</CardTitle>
                  <CardDescription>Track Temporal workflows and tasks</CardDescription>
                </div>
              </div>
            </CardHeader>
          </Card>

          <Card className="hover:shadow-lg transition-shadow cursor-pointer" onClick={() => setLocation('/admin/grid-operator')}>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-lg bg-cyan-50">
                  <Grid3x3 className="h-6 w-6 text-cyan-600" />
                </div>
                <div>
                  <CardTitle>Grid Operator</CardTitle>
                  <CardDescription>Grid status and pricing signals</CardDescription>
                </div>
              </div>
            </CardHeader>
          </Card>

          <Card className="hover:shadow-lg transition-shadow cursor-pointer" onClick={() => setLocation('/admin/performance')}>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-lg bg-amber-50">
                  <Monitor className="h-6 w-6 text-amber-600" />
                </div>
                <div>
                  <CardTitle>Performance Dashboard</CardTitle>
                  <CardDescription>System metrics and alerts</CardDescription>
                </div>
              </div>
            </CardHeader>
          </Card>

          <Card className="hover:shadow-lg transition-shadow cursor-pointer" onClick={() => setLocation('/admin/iot-devices')}>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-lg bg-lime-50">
                  <Cpu className="h-6 w-6 text-lime-600" />
                </div>
                <div>
                  <CardTitle>IoT Device Monitoring</CardTitle>
                  <CardDescription>Real-time device health and telemetry</CardDescription>
                </div>
              </div>
            </CardHeader>
          </Card>
        </div>

        {/* Error banner for system stats */}
        {statsError && (
          <Card className="border-red-200 bg-red-50">
            <CardContent className="flex items-center justify-between gap-3 py-4">
              <div className="flex items-center gap-3">
                <AlertCircle className="h-5 w-5 text-red-600" />
                <p className="text-sm text-red-800">
                  System statistics unavailable: {statsErrorMsg?.message || "Unknown error"}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => statsQuery.refetch()}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Retry
              </Button>
            </CardContent>
          </Card>
        )}

        {/* System Status — backed by trpc.performance.getHealth, which derives
            each check from measured 5-minute p95/success-rate windows. */}
        <Card>
          <CardHeader>
            <CardTitle>System Status</CardTitle>
            <CardDescription>
              Measured health over the last 5 minutes — a check is shown only when it is really measured
            </CardDescription>
          </CardHeader>
          <CardContent>
            {healthQuery.isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-full" />
              </div>
            ) : healthQuery.isError ? (
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-red-600">
                  Health check unavailable: {(healthQuery.error as any)?.message || "Unknown error"}
                </p>
                <Button variant="outline" size="sm" onClick={() => healthQuery.refetch()}>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Retry
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                {healthRows.map((row) => (
                  <div key={row.label} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className={`h-2 w-2 rounded-full ${row.ok ? "bg-green-500" : "bg-red-500"}`} />
                      <span className="text-sm font-medium">{row.label}</span>
                    </div>
                    <span className="text-sm text-muted-foreground">
                      {row.ok ? "Healthy" : "Failing checks"}
                    </span>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground pt-2 border-t">
                  Overall: <span className="capitalize font-medium">{health?.status}</span>
                  {health?.message ? ` — ${health.message}` : ""}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
