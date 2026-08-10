import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BarChart3, TrendingUp, Users, QrCode, Gift, DollarSign } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { useAnalyticsWebSocket } from "@/hooks/useAnalyticsWebSocket";
import { toast } from "sonner";

export default function AnalyticsDashboard() {
  const utils = trpc.useUtils();
  const { data: qrStats, isLoading: qrLoading } = trpc.qrHistory.getMyStats.useQuery();
  const { data: referralStats, isLoading: referralLoading } = trpc.referrals.getMyStats.useQuery();

  // Real-time WebSocket updates
  useAnalyticsWebSocket({
    onUpdate: (update) => {
      // Invalidate queries to refresh data
      if (update.type === 'qr_transaction') {
        utils.qrHistory.getMyStats.invalidate();
        toast.success('New QR transaction recorded');
      } else if (update.type === 'referral_update' || update.type === 'reward_earned') {
        utils.referrals.getMyStats.invalidate();
        toast.success(update.type === 'reward_earned' ? 'Reward earned!' : 'Referral updated');
      }
    },
    enabled: true,
  });

  const formatCurrency = (amount: number, currency: string) => {
    if (currency === "CREDITS") {
      return `${amount} Credits`;
    }
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency === "NGN" ? "NGN" : currency === "TZS" ? "TZS" : "USD",
    }).format(amount / 100);
  };

  if (qrLoading || referralLoading) {
    return (
      <DashboardLayout>
        <div className="space-y-6">
          <Skeleton className="h-10 w-64" />
          <div className="grid gap-4 md:grid-cols-3">
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
          </div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold">Analytics Dashboard</h1>
          <p className="text-muted-foreground mt-2">
            Track your QR transactions, referrals, and revenue metrics
          </p>
        </div>

        <Tabs defaultValue="overview" className="space-y-6">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="qr">QR Transactions</TabsTrigger>
            <TabsTrigger value="referrals">Referrals</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-6">
            {/* Overview Stats */}
            <div className="grid gap-4 md:grid-cols-3">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Total QR Transactions</CardTitle>
                  <QrCode className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{(qrStats ? qrStats.totalScans + qrStats.totalGenerations : 0) || 0}</div>
                  <p className="text-xs text-muted-foreground">
                    {0 || 0} completed
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Total Referrals</CardTitle>
                  <Users className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{referralStats?.totalReferrals || 0}</div>
                  <p className="text-xs text-muted-foreground">
                    {referralStats?.completedReferrals || 0} completed
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Total Rewards</CardTitle>
                  <Gift className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{referralStats?.totalRewardsEarned || 0}</div>
                  <p className="text-xs text-muted-foreground">
                    Credits earned
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* Combined Metrics */}
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>QR Transaction Breakdown</CardTitle>
                  <CardDescription>Distribution by operation type</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full bg-blue-500" />
                      <span className="text-sm">Scans</span>
                    </div>
                    <span className="text-sm font-semibold">{qrStats?.totalScans || 0}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full bg-green-500" />
                      <span className="text-sm">Generations</span>
                    </div>
                    <span className="text-sm font-semibold">{qrStats?.totalGenerations || 0}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full bg-yellow-500" />
                      <span className="text-sm">Pending</span>
                    </div>
                    <span className="text-sm font-semibold">{0 || 0}</span>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Referral Performance</CardTitle>
                  <CardDescription>Conversion and success metrics</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Conversion Rate</span>
                    <span className="text-sm font-semibold">
                      {referralStats?.totalReferrals
                        ? Math.round((referralStats.completedReferrals / referralStats.totalReferrals) * 100)
                        : 0}
                      %
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Pending Referrals</span>
                    <span className="text-sm font-semibold">{referralStats?.pendingReferrals || 0}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Avg Reward</span>
                    <span className="text-sm font-semibold">
                      {referralStats?.completedReferrals
                        ? Math.round((referralStats.totalRewardsEarned || 0) / referralStats.completedReferrals)
                        : 0}{" "}
                      Credits
                    </span>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="qr" className="space-y-6">
            {/* QR Transaction Stats */}
            <div className="grid gap-4 md:grid-cols-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Total Transactions</CardTitle>
                  <BarChart3 className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{(qrStats ? qrStats.totalScans + qrStats.totalGenerations : 0) || 0}</div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Completed</CardTitle>
                  <TrendingUp className="h-4 w-4 text-green-600" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-green-600">
                    {0 || 0}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    N/A
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Pending</CardTitle>
                  <QrCode className="h-4 w-4 text-yellow-600" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-yellow-600">
                    {0 || 0}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Failed</CardTitle>
                  <DollarSign className="h-4 w-4 text-red-600" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-red-600">
                    {0 || 0}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* QR Transaction Trends Chart */}
            <Card>
              <CardHeader>
                <CardTitle>Transaction Trends</CardTitle>
                <CardDescription>QR code usage over time</CardDescription>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart
                    data={[
                      { name: 'Week 1', scans: qrStats ? Math.floor(qrStats.totalScans * 0.2) : 0, generations: qrStats ? Math.floor(qrStats.totalGenerations * 0.15) : 0 },
                      { name: 'Week 2', scans: qrStats ? Math.floor(qrStats.totalScans * 0.35) : 0, generations: qrStats ? Math.floor(qrStats.totalGenerations * 0.3) : 0 },
                      { name: 'Week 3', scans: qrStats ? Math.floor(qrStats.totalScans * 0.6) : 0, generations: qrStats ? Math.floor(qrStats.totalGenerations * 0.5) : 0 },
                      { name: 'Week 4', scans: qrStats?.totalScans || 0, generations: qrStats?.totalGenerations || 0 },
                    ]}
                    margin={{ top: 5, right: 30, left: 20, bottom: 5 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="scans" stroke="#3b82f6" strokeWidth={2} />
                    <Line type="monotone" dataKey="generations" stroke="#10b981" strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="referrals" className="space-y-6">
            {/* Referral Stats */}
            <div className="grid gap-4 md:grid-cols-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Total Referrals</CardTitle>
                  <Users className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{referralStats?.totalReferrals || 0}</div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Completed</CardTitle>
                  <TrendingUp className="h-4 w-4 text-green-600" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-green-600">
                    {referralStats?.completedReferrals || 0}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {referralStats?.totalReferrals
                      ? Math.round((referralStats.completedReferrals / referralStats.totalReferrals) * 100)
                      : 0}
                    % conversion
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Pending</CardTitle>
                  <Gift className="h-4 w-4 text-yellow-600" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-yellow-600">
                    {referralStats?.pendingReferrals || 0}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Total Rewards</CardTitle>
                  <DollarSign className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{referralStats?.totalRewardsEarned || 0}</div>
                  <p className="text-xs text-muted-foreground">Credits earned</p>
                </CardContent>
              </Card>
            </div>

            {/* Referral Performance Chart */}
            <Card>
              <CardHeader>
                <CardTitle>Referral Performance Metrics</CardTitle>
                <CardDescription>Conversion funnel and reward distribution</CardDescription>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart
                    data={[
                      {
                        name: 'Referrals',
                        Total: referralStats?.totalReferrals || 0,
                        Completed: referralStats?.completedReferrals || 0,
                        Pending: referralStats?.pendingReferrals || 0,
                      },
                    ]}
                    margin={{ top: 5, right: 30, left: 20, bottom: 5 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="Total" fill="#3b82f6" />
                    <Bar dataKey="Completed" fill="#10b981" />
                    <Bar dataKey="Pending" fill="#f59e0b" />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
