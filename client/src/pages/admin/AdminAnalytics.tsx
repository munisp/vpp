import { useState, useMemo } from 'react';
import { trpc } from '@/lib/trpc';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CalendarIcon, Download, TrendingUp, Users, Zap, DollarSign, Activity, Target } from 'lucide-react';
import { format, subDays, subMonths } from 'date-fns';
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

const COLORS = ['#10b981', '#8b5cf6', '#f59e0b', '#ef4444', '#3b82f6', '#ec4899'];

export default function AdminAnalytics() {
  const [dateRange, setDateRange] = useState({
    start: subMonths(new Date(), 1),
    end: new Date(),
  });

  const metricsQuery = trpc.adminAnalytics.getAllMetrics.useQuery({
    startDate: dateRange.start,
    endDate: dateRange.end,
  });
  const { data: metrics, isLoading } = metricsQuery;

  const kpisQuery = trpc.adminAnalytics.getSystemKPIs.useQuery();
  const { data: kpis } = kpisQuery;

  const metricsFailed = metricsQuery.isError;
  const kpisFailed = kpisQuery.isError;

  // Quick date range presets
  const setPreset = (days: number) => {
    setDateRange({
      start: subDays(new Date(), days),
      end: new Date(),
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading analytics...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="container py-8 space-y-8">
      {(metricsFailed || kpisFailed) && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="flex items-center justify-between gap-3 py-4">
            <p className="text-sm text-red-800">
              {[
                metricsFailed && `metrics: ${(metricsQuery.error as any)?.message || 'failed'}`,
                kpisFailed && `KPIs: ${(kpisQuery.error as any)?.message || 'failed'}`,
              ].filter(Boolean).join(' · ')}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                metricsQuery.refetch();
                kpisQuery.refetch();
              }}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      )}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold">Admin Analytics</h1>
          <p className="text-muted-foreground">
            Comprehensive platform performance metrics
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setPreset(7)}>
            Last 7 Days
          </Button>
          <Button variant="outline" onClick={() => setPreset(30)}>
            Last 30 Days
          </Button>
          <Button variant="outline" onClick={() => setPreset(90)}>
            Last 90 Days
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline">
                <CalendarIcon className="mr-2 h-4 w-4" />
                {format(dateRange.start, 'MMM dd')} - {format(dateRange.end, 'MMM dd')}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="end">
              <div className="p-4 space-y-4">
                <div>
                  <p className="text-sm font-medium mb-2">Start Date</p>
                  <Calendar
                    mode="single"
                    selected={dateRange.start}
                    onSelect={(date) => date && setDateRange({ ...dateRange, start: date })}
                  />
                </div>
                <div>
                  <p className="text-sm font-medium mb-2">End Date</p>
                  <Calendar
                    mode="single"
                    selected={dateRange.end}
                    onSelect={(date) => date && setDateRange({ ...dateRange, end: date })}
                  />
                </div>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* System KPIs */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Users</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{kpisFailed ? "—" : kpis?.totalUsers || 0}</div>
            <p className="text-xs text-muted-foreground">
              {kpisFailed ? "—" : kpis?.activeUsers || 0} active (30 days)
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Platform Revenue</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {kpisFailed ? "—" : `${((kpis?.platformRevenue || 0) / 100).toFixed(0)} TZS`}
            </div>
            <p className="text-xs text-muted-foreground">All-time total</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Energy Traded</CardTitle>
            <Zap className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {kpisFailed ? "—" : `${((kpis?.totalEnergyTraded || 0) / 1000).toFixed(1)} kWh`}
            </div>
            <p className="text-xs text-muted-foreground">Total volume</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">DR Participation</CardTitle>
            <Target className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {kpisFailed ? "—" : `${(kpis?.drParticipationRate || 0).toFixed(1)}%`}
            </div>
            <p className="text-xs text-muted-foreground">Enrolled users</p>
          </CardContent>
        </Card>
      </div>

      {/* Detailed Analytics Tabs — hidden entirely when the metrics query
          failed, so a failed backend never renders as empty/zero charts. */}
      {!metricsFailed && (
      <Tabs defaultValue="payments" className="space-y-4">
        <TabsList>
          <TabsTrigger value="payments">Payments</TabsTrigger>
          <TabsTrigger value="dr">Demand Response</TabsTrigger>
          <TabsTrigger value="forecasting">Forecasting</TabsTrigger>
        </TabsList>

        {/* Payments Tab */}
        <TabsContent value="payments" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle>Total Revenue</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">
                  {metricsFailed ? "—" : `${((metrics?.paymentMetrics.totalRevenue || 0) / 100).toFixed(0)} TZS`}
                </div>
                <p className="text-sm text-muted-foreground mt-2">
                  {metricsFailed ? "—" : metrics?.paymentMetrics.totalTransactions || 0} transactions
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Success Rate</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">
                  {metricsFailed ? "—" : `${(metrics?.paymentMetrics.successRate || 0).toFixed(1)}%`}
                </div>
                <p className="text-sm text-muted-foreground mt-2">Payment completion</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Avg Transaction</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">
                  {metricsFailed ? "—" : `${((metrics?.paymentMetrics.averageTransactionValue || 0) / 100).toFixed(0)} TZS`}
                </div>
                <p className="text-sm text-muted-foreground mt-2">Per transaction</p>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Daily Revenue</CardTitle>
                <CardDescription>Revenue trend over time</CardDescription>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={metrics?.paymentMetrics.dailyRevenue || []}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis />
                    <Tooltip
                      formatter={(value: number) => `${(value / 100).toFixed(0)} TZS`}
                    />
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="revenue"
                      stroke="#10b981"
                      strokeWidth={2}
                      name="Revenue"
                    />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Gateway Breakdown</CardTitle>
                <CardDescription>Revenue by payment method</CardDescription>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie
                      data={metrics?.paymentMetrics.gatewayBreakdown || []}
                      dataKey="revenue"
                      nameKey="gateway"
                      cx="50%"
                      cy="50%"
                      outerRadius={100}
                      label
                    >
                      {(metrics?.paymentMetrics.gatewayBreakdown || []).map((_, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(value: number) => `${(value / 100).toFixed(0)} TZS`} />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* DR Tab */}
        <TabsContent value="dr" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-4">
            <Card>
              <CardHeader>
                <CardTitle>Total Events</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">
                  {metricsFailed ? "—" : metrics?.drMetrics.totalEvents || 0}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Participants</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">
                  {metricsFailed ? "—" : metrics?.drMetrics.totalParticipants || 0}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Total Reduction</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">
                  {metricsFailed ? "—" : `${((metrics?.drMetrics.totalReduction || 0) / 1000).toFixed(1)} kW`}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Compensation</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">
                  {metricsFailed ? "—" : `${((metrics?.drMetrics.totalCompensation || 0) / 100).toFixed(0)} TZS`}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Performance Over Time</CardTitle>
                <CardDescription>Daily DR event metrics</CardDescription>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={metrics?.drMetrics.performanceOverTime || []}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="events" fill="#8b5cf6" name="Events" />
                    <Bar dataKey="participants" fill="#10b981" name="Participants" />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Event Type Breakdown</CardTitle>
                <CardDescription>Events by type</CardDescription>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={metrics?.drMetrics.eventTypeBreakdown || []}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="eventType" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="count" fill="#f59e0b" name="Count" />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Forecasting Tab */}
        <TabsContent value="forecasting" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle>Total Forecasts</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">
                  {metricsFailed ? "—" : metrics?.forecastingMetrics.totalForecasts || 0}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Average Accuracy</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">
                  {metricsFailed ? "—" : `${(metrics?.forecastingMetrics.averageAccuracy || 0).toFixed(1)}%`}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Grid Status</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {(metrics?.forecastingMetrics.forecastsByStatus || []).map((stat) => (
                    <div key={stat.status} className="flex justify-between">
                      <span className="capitalize">{stat.status}</span>
                      <span className="font-bold">{stat.count}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Accuracy Over Time</CardTitle>
              <CardDescription>Forecasting accuracy trend</CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={metrics?.forecastingMetrics.accuracyOverTime || []}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="accuracy"
                    stroke="#3b82f6"
                    strokeWidth={2}
                    name="Accuracy (%)"
                  />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      )}
    </div>
  );
}
