import { useMemo, useState } from 'react';
import DashboardLayout from '@/components/DashboardLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { trpc } from '@/lib/trpc';
import { Skeleton } from '@/components/ui/skeleton';
import { 
  LineChart, Line, BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer 
} from 'recharts';
import { 
  Users, TrendingUp, DollarSign, Zap, Activity, Download, 
  Calendar, AlertCircle, CheckCircle2 
} from 'lucide-react';
import { toast } from 'sonner';
import { exportComprehensiveReport, exportOverviewCSV, exportUserGrowthCSV, exportTradingMetricsCSV, exportRevenueMetricsCSV, exportTopPerformersCSV } from '@/lib/exportUtils';

const COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

type DateRange = 'today' | 'week' | 'month' | 'year';

export default function AnalyticsDashboard() {
  const [dateRange, setDateRange] = useState<DateRange>('month');

  // Memoised: the range ends at "now", so recomputing it per render would give
  // every query a new key and refetch forever.
  const dateRangeParams = useMemo(() => {
    const end = new Date();
    const start = new Date();
    
    switch (dateRange) {
      case 'today':
        start.setHours(0, 0, 0, 0);
        break;
      case 'week':
        start.setDate(start.getDate() - 7);
        break;
      case 'month':
        start.setMonth(start.getMonth() - 1);
        break;
      case 'year':
        start.setFullYear(start.getFullYear() - 1);
        break;
    }
    
    return {
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    };
  }, [dateRange]);

  // Fetch all analytics data
  const overviewQuery = trpc.adminAnalytics.getOverview.useQuery(dateRangeParams);
  const userGrowthQuery = trpc.adminAnalytics.getUserGrowth.useQuery(dateRangeParams);
  const tradingQuery = trpc.adminAnalytics.getTradingMetrics.useQuery(dateRangeParams);
  const revenueQuery = trpc.adminAnalytics.getRevenueMetrics.useQuery(dateRangeParams);
  const performersQuery = trpc.adminAnalytics.getTopPerformers.useQuery({ ...dateRangeParams, limit: 10 });
  const healthQuery = trpc.adminAnalytics.getSystemHealth.useQuery();

  const { data: overview, isLoading: overviewLoading } = overviewQuery;
  const { data: userGrowth, isLoading: userGrowthLoading } = userGrowthQuery;
  const { data: tradingMetrics, isLoading: tradingLoading } = tradingQuery;
  const { data: revenueMetrics, isLoading: revenueLoading } = revenueQuery;
  const { data: topPerformers, isLoading: performersLoading } = performersQuery;
  const { data: systemHealth, isLoading: healthLoading } = healthQuery;

  const isLoading = overviewLoading || userGrowthLoading || tradingLoading || revenueLoading || performersLoading || healthLoading;

  const failedQueries = [
    { label: 'overview', q: overviewQuery },
    { label: 'user growth', q: userGrowthQuery },
    { label: 'trading metrics', q: tradingQuery },
    { label: 'revenue metrics', q: revenueQuery },
    { label: 'top performers', q: performersQuery },
    { label: 'system health', q: healthQuery },
  ].filter((f) => f.q.isError);

  const retryAll = () => {
    overviewQuery.refetch();
    userGrowthQuery.refetch();
    tradingQuery.refetch();
    revenueQuery.refetch();
    performersQuery.refetch();
    healthQuery.refetch();
  };

  // CSV export only: there is no server-side PDF export for platform-wide
  // admin analytics, so no PDF option is offered.
  const handleExport = () => {
    if (!overview || !userGrowth || !tradingMetrics || !revenueMetrics || !topPerformers || !systemHealth) {
      toast.error('Analytics data not loaded yet');
      return;
    }

    try {
      exportComprehensiveReport(
        overview,
        userGrowth,
        tradingMetrics,
        revenueMetrics,
        topPerformers,
        systemHealth
      );
      toast.success('Analytics report exported successfully!');
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Failed to export analytics report');
    }
  };

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <h1 className="text-3xl font-bold tracking-tight">Analytics Dashboard</h1>
          </div>
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-32" />)}
          </div>
          <div className="grid gap-6 md:grid-cols-2">
            {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-80" />)}
          </div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {failedQueries.length > 0 && (
          <Card className="border-red-200 bg-red-50">
            <CardContent className="flex items-center justify-between gap-3 py-4">
              <div className="flex items-center gap-3">
                <AlertCircle className="h-5 w-5 text-red-600" />
                <div>
                  <p className="text-sm font-medium text-red-800">
                    Failed to load: {failedQueries.map((f) => f.label).join(', ')}
                  </p>
                  <p className="text-sm text-red-700">
                    {(failedQueries[0].q.error as any)?.message || 'Unknown error'}
                  </p>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={retryAll}>
                Retry
              </Button>
            </CardContent>
          </Card>
        )}
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Analytics Dashboard</h1>
            <p className="text-muted-foreground mt-2">
              Comprehensive insights into platform performance and user activity
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Select value={dateRange} onValueChange={(value: DateRange) => setDateRange(value)}>
              <SelectTrigger className="w-[180px]">
                <Calendar className="h-4 w-4 mr-2" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="today">Today</SelectItem>
                <SelectItem value="week">Last 7 Days</SelectItem>
                <SelectItem value="month">Last 30 Days</SelectItem>
                <SelectItem value="year">Last Year</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={handleExport}>
              <Download className="h-4 w-4 mr-2" />
              Export CSV
            </Button>
          </div>
        </div>

        {/* Overview Cards */}
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Users</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{overviewQuery.isError ? '—' : (overview?.totalUsers || 0)}</div>
              <p className="text-xs text-muted-foreground">
                {userGrowthQuery.isError ? '—' : (userGrowth?.activeUsers || 0)} active users
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Trades</CardTitle>
              <Zap className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{overviewQuery.isError ? '—' : (overview?.totalTrades || 0)}</div>
              <p className="text-xs text-muted-foreground">
                {tradingQuery.isError ? '—' : (tradingMetrics?.totalEnergy || 0)} kWh traded
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Revenue</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{overviewQuery.isError ? '—' : `₦${overview?.totalRevenue || '0'}`}</div>
              <p className="text-xs text-muted-foreground">
                {revenueQuery.isError ? '—' : (revenueMetrics?.totalPayments || 0)} payments
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">DR Events</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{overviewQuery.isError ? '—' : (overview?.totalDREvents || 0)}</div>
              <p className="text-xs text-muted-foreground">
                Demand response events
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Charts Row 1 */}
        <div className="grid gap-6 md:grid-cols-2">
          {/* User Growth Chart */}
          <Card>
            <CardHeader>
              <CardTitle>User Growth</CardTitle>
              <CardDescription>New user registrations over time</CardDescription>
            </CardHeader>
            <CardContent>
              {userGrowthQuery.isError ? (
                <p className="text-sm text-red-600 py-8 text-center">
                  Chart unavailable: {(userGrowthQuery.error as any)?.message || 'failed to load'}
                </p>
              ) : (
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={userGrowth?.usersByDate || []}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="count" stroke="#10b981" strokeWidth={2} name="New Users" />
                </LineChart>
              </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* Trading Volume Chart */}
          <Card>
            <CardHeader>
              <CardTitle>Energy Trading Volume</CardTitle>
              <CardDescription>Daily energy traded (kWh)</CardDescription>
            </CardHeader>
            <CardContent>
              {tradingQuery.isError ? (
                <p className="text-sm text-red-600 py-8 text-center">
                  Chart unavailable: {(tradingQuery.error as any)?.message || 'failed to load'}
                </p>
              ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={tradingMetrics?.tradesByDate || []}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="energy" fill="#3b82f6" name="Energy (kWh)" />
                </BarChart>
              </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Charts Row 2 */}
        <div className="grid gap-6 md:grid-cols-2">
          {/* Revenue Chart */}
          <Card>
            <CardHeader>
              <CardTitle>Revenue Trends</CardTitle>
              <CardDescription>Daily revenue over time</CardDescription>
            </CardHeader>
            <CardContent>
              {revenueQuery.isError ? (
                <p className="text-sm text-red-600 py-8 text-center">
                  Chart unavailable: {(revenueQuery.error as any)?.message || 'failed to load'}
                </p>
              ) : (
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={revenueMetrics?.revenueByDate || []}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Area type="monotone" dataKey="revenue" stroke="#10b981" fill="#10b981" fillOpacity={0.3} name="Revenue (₦)" />
                </AreaChart>
              </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* Trade Types Distribution */}
          <Card>
            <CardHeader>
              <CardTitle>Trade Types Distribution</CardTitle>
              <CardDescription>Breakdown by trade type</CardDescription>
            </CardHeader>
            <CardContent>
              {tradingQuery.isError ? (
                <p className="text-sm text-red-600 py-8 text-center">
                  Chart unavailable: {(tradingQuery.error as any)?.message || 'failed to load'}
                </p>
              ) : (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={tradingMetrics?.tradesByType || []}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={({ type, percent }) => `${type}: ${(percent * 100).toFixed(0)}%`}
                    outerRadius={80}
                    fill="#8884d8"
                    dataKey="count"
                  >
                    {(tradingMetrics?.tradesByType || []).map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Top Performers */}
        <Card>
          <CardHeader>
            <CardTitle>Top Performers</CardTitle>
            <CardDescription>Leading traders by energy volume</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {performersQuery.isError ? (
                <p className="text-sm text-red-600 py-8 text-center">
                  Unavailable: {(performersQuery.error as any)?.message || 'failed to load'}
                </p>
              ) : topPerformers?.topTraders && topPerformers.topTraders.length > 0 ? (
                topPerformers.topTraders.map((trader, index) => (
                  <div key={trader.userId} className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/10 text-primary font-bold">
                        {index + 1}
                      </div>
                      <div>
                        <p className="font-medium">{trader.userName}</p>
                        <p className="text-sm text-muted-foreground">
                          {trader.totalTrades} trades
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="font-bold">{trader.totalEnergy} kWh</p>
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-center text-muted-foreground py-8">No trading data available</p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* System Health */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              System Health
            </CardTitle>
            <CardDescription>Real-time platform health metrics</CardDescription>
          </CardHeader>
          <CardContent>
            {healthQuery.isError ? (
              <p className="text-sm text-red-600">
                System health unavailable: {(healthQuery.error as any)?.message || 'failed to load'}
              </p>
            ) : (
            <div className="grid gap-4 md:grid-cols-3">
              <div className="flex items-center gap-3">
                <div className={`flex items-center justify-center w-10 h-10 rounded-full ${
                  systemHealth?.systemStatus === 'healthy' ? 'bg-green-100 text-green-600' : 'bg-yellow-100 text-yellow-600'
                }`}>
                  {systemHealth?.systemStatus === 'healthy' ? (
                    <CheckCircle2 className="h-5 w-5" />
                  ) : (
                    <AlertCircle className="h-5 w-5" />
                  )}
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">System Status</p>
                  <p className="font-bold capitalize">{systemHealth?.systemStatus || 'Unknown'}</p>
                </div>
              </div>

              <div>
                <p className="text-sm text-muted-foreground">Active Assets</p>
                <p className="text-2xl font-bold">
                  {systemHealth?.activeAssets || 0} / {systemHealth?.totalAssets || 0}
                </p>
                <p className="text-xs text-muted-foreground">
                  {systemHealth?.assetHealthRate || 0}% health rate
                </p>
              </div>

              <div>
                <p className="text-sm text-muted-foreground">Recent Telemetry</p>
                <p className="text-2xl font-bold">{systemHealth?.recentTelemetry || 0}</p>
                <p className="text-xs text-muted-foreground">Last 24 hours</p>
              </div>

              <div>
                <p className="text-sm text-muted-foreground">Pending Trades</p>
                <p className="text-2xl font-bold">{systemHealth?.pendingTrades || 0}</p>
                <p className="text-xs text-muted-foreground">Awaiting execution</p>
              </div>
            </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
