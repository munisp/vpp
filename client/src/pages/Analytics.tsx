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

  const { data: revenueData, isLoading: revenueLoading } = trpc.analytics.getRevenue.useQuery({
    startDate,
    endDate,
  });

  const { data: energyFlowData, isLoading: energyLoading } = trpc.analytics.getEnergyFlow.useQuery({
    startDate,
    endDate,
    interval: "day",
  });

  const { data: tradingData, isLoading: tradingLoading } = trpc.analytics.getTradingVolume.useQuery({
    startDate,
    endDate,
  });

  // Calculate summary statistics
  const summaryStats = useMemo(() => {
    const totalRevenue = revenueData?.data.reduce((sum, d) => sum + d.revenue, 0) || 0;
    const totalTransactions = revenueData?.data.reduce((sum, d) => sum + d.transactions, 0) || 0;
    const totalEnergyTraded = tradingData?.data.reduce((sum, d) => sum + d.volume, 0) || 0;
    const avgEnergyPerDay = energyFlowData?.data.length 
      ? energyFlowData.data.reduce((sum, d) => sum + d.generation, 0) / energyFlowData.data.length
      : 0;

    return {
      totalRevenue,
      totalTransactions,
      totalEnergyTraded: totalEnergyTraded / 1000, // Convert Wh to kWh
      avgEnergyPerDay: avgEnergyPerDay / 1000, // Convert W to kW
    };
  }, [revenueData, tradingData, energyFlowData]);

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

        {/* Summary Cards */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Revenue</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">TZS {summaryStats.totalRevenue.toFixed(2)}</div>
              <p className="text-xs text-muted-foreground">
                From {summaryStats.totalTransactions} transactions
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Energy Traded</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{summaryStats.totalEnergyTraded.toFixed(2)} kWh</div>
              <p className="text-xs text-muted-foreground">
                Total energy traded in period
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Avg Generation</CardTitle>
              <Zap className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{summaryStats.avgEnergyPerDay.toFixed(2)} kW</div>
              <p className="text-xs text-muted-foreground">
                Average daily generation
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Transactions</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{summaryStats.totalTransactions}</div>
              <p className="text-xs text-muted-foreground">
                Total payment transactions
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
