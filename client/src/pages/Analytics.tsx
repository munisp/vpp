import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { useState, useMemo } from "react";
import { toast } from "sonner";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { Calendar, TrendingUp, Zap, DollarSign, Download } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default function Analytics() {
  const [dateRange, setDateRange] = useState<"7d" | "30d" | "90d">("30d");

  const { startDate, endDate } = useMemo(() => {
    const end = new Date();
    const start = new Date();
    
    switch (dateRange) {
      case "7d":
        start.setDate(end.getDate() - 7);
        break;
      case "30d":
        start.setDate(end.getDate() - 30);
        break;
      case "90d":
        start.setDate(end.getDate() - 90);
        break;
    }
    
    return { startDate: start, endDate: end };
  }, [dateRange]);

  // The analytics getters throw on failure; each query's error state is
  // rendered explicitly ('—' / message + retry) instead of zeros.
  const revenueQuery = trpc.analytics.getRevenue.useQuery({
    startDate,
    endDate,
  });
  const { data: revenueData, isLoading: revenueLoading } = revenueQuery;

  const energyFlowQuery = trpc.analytics.getEnergyFlow.useQuery({
    startDate,
    endDate,
    interval: "day",
  });
  const { data: energyFlowData, isLoading: energyLoading } = energyFlowQuery;

  const tradingQuery = trpc.analytics.getTradingVolume.useQuery({
    startDate,
    endDate,
  });
  const { data: tradingData, isLoading: tradingLoading } = tradingQuery;

  const revenueFailed = revenueQuery.isError;
  const energyFailed = energyFlowQuery.isError;
  const tradingFailed = tradingQuery.isError;
  const anyFailed = revenueFailed || energyFailed || tradingFailed;

  // Calculate summary statistics — null when the underlying query failed, so
  // a failed backend renders as '—', not 0.00.
  const summaryStats = useMemo(() => {
    const totalRevenue = revenueFailed
      ? null
      : revenueData?.data.reduce((sum, d) => sum + d.revenue, 0) ?? null;
    const totalTransactions = revenueFailed
      ? null
      : revenueData?.data.reduce((sum, d) => sum + d.transactions, 0) ?? null;
    const totalEnergyTraded = tradingFailed
      ? null
      : tradingData
        ? tradingData.data.reduce((sum, d) => sum + d.volume, 0) / 1000 // Wh to kWh
        : null;
    const avgEnergyPerDay = energyFailed
      ? null
      : energyFlowData?.data.length
        ? energyFlowData.data.reduce((sum, d) => sum + d.generation, 0) / energyFlowData.data.length / 1000 // W to kW
        : null;

    return {
      totalRevenue,
      totalTransactions,
      totalEnergyTraded,
      avgEnergyPerDay,
    };
  }, [revenueData, tradingData, energyFlowData, revenueFailed, tradingFailed, energyFailed]);

  const exportRevenueMutation = trpc.export.revenuePDF.useMutation({
    onSuccess: (data) => {
      const blob = new Blob([Uint8Array.from(atob(data.content), c => c.charCodeAt(0))], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = data.filename;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Revenue report downloaded');
    },
    onError: () => toast.error('Failed to generate report'),
  });

  const exportEnergyMutation = trpc.export.energyPDF.useMutation({
    onSuccess: (data) => {
      const blob = new Blob([Uint8Array.from(atob(data.content), c => c.charCodeAt(0))], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = data.filename;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Energy report downloaded');
    },
    onError: () => toast.error('Failed to generate report'),
  });

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Analytics</h1>
            <p className="text-muted-foreground mt-2">
              Track your energy generation, trading, and revenue performance
            </p>
          </div>
          <div className="flex gap-2">
            <Select value={dateRange} onValueChange={(value: "7d" | "30d" | "90d") => setDateRange(value)}>
              <SelectTrigger className="w-[180px]">
                <Calendar className="h-4 w-4 mr-2" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7d">Last 7 days</SelectItem>
                <SelectItem value="30d">Last 30 days</SelectItem>
                <SelectItem value="90d">Last 90 days</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={() => exportRevenueMutation.mutate({ startDate: startDate.toISOString(), endDate: endDate.toISOString() })}
              disabled={exportRevenueMutation.isPending}
            >
              <Download className="h-4 w-4 mr-2" />
              Revenue PDF
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => exportEnergyMutation.mutate({ startDate: startDate.toISOString(), endDate: endDate.toISOString() })}
              disabled={exportEnergyMutation.isPending}
            >
              <Download className="h-4 w-4 mr-2" />
              Energy PDF
            </Button>
          </div>
        </div>

        {anyFailed && (
          <Card className="border-red-200 bg-red-50">
            <CardContent className="flex items-center justify-between gap-3 py-4">
              <p className="text-sm text-red-800">
                {[
                  revenueFailed && `revenue: ${(revenueQuery.error as any)?.message || 'failed'}`,
                  energyFailed && `energy flow: ${(energyFlowQuery.error as any)?.message || 'failed'}`,
                  tradingFailed && `trading volume: ${(tradingQuery.error as any)?.message || 'failed'}`,
                ].filter(Boolean).join(' · ')}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  revenueQuery.refetch();
                  energyFlowQuery.refetch();
                  tradingQuery.refetch();
                }}
              >
                Retry
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Summary Cards */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Revenue</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {summaryStats.totalRevenue !== null ? `TZS ${summaryStats.totalRevenue.toFixed(2)}` : "—"}
              </div>
              <p className="text-xs text-muted-foreground">
                {summaryStats.totalTransactions !== null
                  ? `From ${summaryStats.totalTransactions} transactions`
                  : "Revenue data unavailable"}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Energy Traded</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {summaryStats.totalEnergyTraded !== null ? `${summaryStats.totalEnergyTraded.toFixed(2)} kWh` : "—"}
              </div>
              <p className="text-xs text-muted-foreground">
                {summaryStats.totalEnergyTraded !== null ? "Total energy traded in period" : "Trading data unavailable"}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Avg Generation</CardTitle>
              <Zap className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {summaryStats.avgEnergyPerDay !== null ? `${summaryStats.avgEnergyPerDay.toFixed(2)} kW` : "—"}
              </div>
              <p className="text-xs text-muted-foreground">
                {summaryStats.avgEnergyPerDay !== null ? "Average daily generation" : "Energy data unavailable"}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Transactions</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {summaryStats.totalTransactions !== null ? summaryStats.totalTransactions : "—"}
              </div>
              <p className="text-xs text-muted-foreground">
                {summaryStats.totalTransactions !== null ? "Total payment transactions" : "Revenue data unavailable"}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Revenue Chart */}
        <Card>
          <CardHeader>
            <CardTitle>Revenue Trends</CardTitle>
            <CardDescription>Daily revenue and transaction volume</CardDescription>
          </CardHeader>
          <CardContent>
            {revenueLoading ? (
              <div className="h-[300px] flex items-center justify-center">
                <p className="text-muted-foreground">Loading chart...</p>
              </div>
            ) : revenueFailed ? (
              <div className="h-[300px] flex items-center justify-center">
                <p className="text-red-600">
                  Chart unavailable: {(revenueQuery.error as any)?.message || "failed to load revenue data"}
                </p>
              </div>
            ) : !revenueData?.data.length ? (
              <div className="h-[300px] flex items-center justify-center">
                <p className="text-muted-foreground">No revenue data available for this period</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={revenueData.data}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Area
                    type="monotone"
                    dataKey="revenue"
                    stroke="#16a34a"
                    fill="#16a34a"
                    fillOpacity={0.2}
                    name="Revenue (TZS)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Energy Flow Chart */}
        <Card>
          <CardHeader>
            <CardTitle>Energy Flow</CardTitle>
            <CardDescription>Generation and consumption patterns</CardDescription>
          </CardHeader>
          <CardContent>
            {energyLoading ? (
              <div className="h-[300px] flex items-center justify-center">
                <p className="text-muted-foreground">Loading chart...</p>
              </div>
            ) : energyFailed ? (
              <div className="h-[300px] flex items-center justify-center">
                <p className="text-red-600">
                  Chart unavailable: {(energyFlowQuery.error as any)?.message || "failed to load energy data"}
                </p>
              </div>
            ) : !energyFlowData?.data.length ? (
              <div className="h-[300px] flex items-center justify-center">
                <p className="text-muted-foreground">No energy data available for this period</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={energyFlowData.data.map(d => ({
                  ...d,
                  generation: d.generation / 1000,
                  consumption: d.consumption / 1000,
                }))}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="timestamp" />
                  <YAxis label={{ value: 'kW', angle: -90, position: 'insideLeft' }} />
                  <Tooltip />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="generation"
                    stroke="#16a34a"
                    strokeWidth={2}
                    name="Generation (kW)"
                  />
                  <Line
                    type="monotone"
                    dataKey="consumption"
                    stroke="#dc2626"
                    strokeWidth={2}
                    name="Consumption (kW)"
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Trading Volume Chart */}
        <Card>
          <CardHeader>
            <CardTitle>Trading Volume</CardTitle>
            <CardDescription>Daily energy trading activity</CardDescription>
          </CardHeader>
          <CardContent>
            {tradingLoading ? (
              <div className="h-[300px] flex items-center justify-center">
                <p className="text-muted-foreground">Loading chart...</p>
              </div>
            ) : tradingFailed ? (
              <div className="h-[300px] flex items-center justify-center">
                <p className="text-red-600">
                  Chart unavailable: {(tradingQuery.error as any)?.message || "failed to load trading data"}
                </p>
              </div>
            ) : !tradingData?.data.length ? (
              <div className="h-[300px] flex items-center justify-center">
                <p className="text-muted-foreground">No trading data available for this period</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={tradingData.data.map(d => ({
                  ...d,
                  volume: d.volume / 1000,
                }))}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis label={{ value: 'kWh', angle: -90, position: 'insideLeft' }} />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="volume" fill="#16a34a" name="Energy Traded (kWh)" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
