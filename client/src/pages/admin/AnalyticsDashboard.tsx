import { useState } from 'react';
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

  // Calculate date range
  const getDateRange = () => {
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
  };

  const dateRangeParams = getDateRange();

  // Fetch all analytics data
  const { data: overview, isLoading: overviewLoading } = trpc.adminAnalytics.getOverview.useQuery(dateRangeParams);
  const { data: userGrowth, isLoading: userGrowthLoading } = trpc.adminAnalytics.getUserGrowth.useQuery(dateRangeParams);
  const { data: tradingMetrics, isLoading: tradingLoading } = trpc.adminAnalytics.getTradingMetrics.useQuery(dateRangeParams);
  const { data: revenueMetrics, isLoading: revenueLoading } = trpc.adminAnalytics.getRevenueMetrics.useQuery(dateRangeParams);
  const { data: topPerformers, isLoading: performersLoading } = trpc.adminAnalytics.getTopPerformers.useQuery({ ...dateRangeParams, limit: 10 });
  const { data: systemHealth, isLoading: healthLoading } = trpc.adminAnalytics.getSystemHealth.useQuery();

  const isLoading = overviewLoading || userGrowthLoading || tradingLoading || revenueLoading || performersLoading || healthLoading;

  const handleExport = (format: 'csv' | 'pdf') => {
    if (format === 'pdf') {
      toast.info('PDF export coming soon!');
      return;
    }

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
            <Button variant="outline" size="sm" onClick={() => handleExport('csv')}>
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
              <div className="text-2xl font-bold">{overview?.totalUsers || 0}</div>
              <p className="text-xs text-muted-foreground">
                {userGrowth?.activeUsers || 0} active users
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Trades</CardTitle>
              <Zap className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{overview?.totalTrades || 0}</div>
              <p className="text-xs text-muted-foreground">
                {tradingMetrics?.totalEnergy || 0} kWh traded
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Revenue</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">₦{overview?.totalRevenue || '0'}</div>
              <p className="text-xs text-muted-foreground">
                {revenueMetrics?.totalPayments || 0} payments
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">DR Events</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{overview?.totalDREvents || 0}</div>
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
            </CardContent>
          </Card>

          {/* Trading Volume Chart */}
          <Card>
            <CardHeader>
              <CardTitle>Energy Trading Volume</CardTitle>
              <CardDescription>Daily energy traded (kWh)</CardDescription>
            </CardHeader>
            <CardContent>
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
            </CardContent>
          </Card>

          {/* Trade Types Distribution */}
          <Card>
            <CardHeader>
              <CardTitle>Trade Types Distribution</CardTitle>
              <CardDescription>Breakdown by trade type</CardDescription>
            </CardHeader>
            <CardContent>
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
              {topPerformers?.topTraders && topPerformers.topTraders.length > 0 ? (
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
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
