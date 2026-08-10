import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { WorkflowStatusMonitor } from "@/components/WorkflowStatusMonitor";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { Activity, Battery, TrendingDown, TrendingUp, Zap, Wifi, WifiOff } from "lucide-react";
import { useState, useEffect } from "react";
import { useWebSocket } from "@/hooks/useWebSocket";
import { Badge } from "@/components/ui/badge";
import { Area, AreaChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Skeleton } from "@/components/ui/skeleton";

export default function Monitoring() {
  const [selectedAsset, setSelectedAsset] = useState<number | null>(null);
  const [timeRange, setTimeRange] = useState<"1h" | "6h" | "24h" | "7d">("24h");
  const { telemetry: realtimeTelemetry, connected } = useWebSocket();

  const { data: assetsData, isLoading: assetsLoading } = trpc.assets.list.useQuery();
  const assets = assetsData?.assets || [];

  // Set default selected asset
  const assetId = selectedAsset || assets[0]?.id || 0;

  // Calculate time range
  const getTimeRange = () => {
    const now = new Date();
    const start = new Date();
    switch (timeRange) {
      case "1h":
        start.setHours(now.getHours() - 1);
        break;
      case "6h":
        start.setHours(now.getHours() - 6);
        break;
      case "24h":
        start.setHours(now.getHours() - 24);
        break;
      case "7d":
        start.setDate(now.getDate() - 7);
        break;
    }
    return { start, end: now };
  };

  const { start, end } = getTimeRange();

  const { data: historicalData, isLoading: dataLoading } = trpc.telemetry.getHistorical.useQuery(
    {
      assetId,
      startTime: start,
      endTime: end,
    },
    { enabled: assetId > 0 }
  );

  const { data: latestTelemetry } = trpc.telemetry.getLatest.useQuery(
    { assetId },
    { enabled: assetId > 0 }
  );

  // Format data for charts
  const chartData = (historicalData || []).map((item) => ({
    time: new Date(item.timestamp).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    }),
    power: item.power || 0,
    energy: item.energy || 0,
    voltage: item.voltage || 0,
    current: item.current || 0,
    soc: item.stateOfCharge ? item.stateOfCharge / 100 : 0,
    temperature: item.temperature || 0,
  }));

  // Use real-time data if available, otherwise fall back to latest telemetry
  const displayTelemetry = (connected && realtimeTelemetry) ? realtimeTelemetry : latestTelemetry;
  
  // Current metrics
  const currentPower = displayTelemetry?.power || 0;
  const currentEnergy = displayTelemetry?.energy || 0;
  const currentSoC = displayTelemetry?.stateOfCharge ? displayTelemetry.stateOfCharge / 100 : 0;
  const currentTemp = latestTelemetry?.temperature || 0;

  const metrics = [
    {
      title: "Current Power",
      value: `${currentPower.toFixed(2)} kW`,
      icon: Zap,
      color: "text-green-600",
      bgColor: "bg-green-50",
    },
    {
      title: "Energy Today",
      value: `${currentEnergy.toFixed(2)} kWh`,
      icon: Activity,
      color: "text-blue-600",
      bgColor: "bg-blue-50",
    },
    {
      title: "Battery Level",
      value: `${currentSoC.toFixed(0)}%`,
      icon: Battery,
      color: "text-amber-600",
      bgColor: "bg-amber-50",
    },
    {
      title: "Temperature",
      value: `${currentTemp.toFixed(1)}°C`,
      icon: TrendingUp,
      color: "text-red-600",
      bgColor: "bg-red-50",
    },
  ];

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-bold tracking-tight">Real-Time Monitoring</h1>
              {connected ? (
                <Badge variant="default" className="bg-green-600 flex items-center gap-1">
                  <Wifi className="h-3 w-3" />
                  Live
                </Badge>
              ) : (
                <Badge variant="secondary" className="flex items-center gap-1">
                  <WifiOff className="h-3 w-3" />
                  Offline
                </Badge>
              )}
            </div>
            <p className="text-muted-foreground mt-2">
              {connected 
                ? "Receiving real-time data updates every 5 seconds" 
                : "Monitor your energy generation, consumption, and system performance."}
            </p>
          </div>
          <div className="flex gap-3">
            <Select
              value={selectedAsset?.toString() || assets[0]?.id.toString()}
              onValueChange={(value) => setSelectedAsset(parseInt(value))}
            >
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Select asset" />
              </SelectTrigger>
              <SelectContent>
                {assets.map((asset) => (
                  <SelectItem key={asset.id} value={asset.id.toString()}>
                    {asset.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={timeRange} onValueChange={(value: any) => setTimeRange(value)}>
              <SelectTrigger className="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1h">Last Hour</SelectItem>
                <SelectItem value="6h">Last 6 Hours</SelectItem>
                <SelectItem value="24h">Last 24 Hours</SelectItem>
                <SelectItem value="7d">Last 7 Days</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {assetsLoading ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {[1, 2, 3, 4].map((i) => (
              <Card key={i}>
                <CardHeader>
                  <Skeleton className="h-6 w-32" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-8 w-24" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : assets.length === 0 ? (
          <Card className="border-amber-200 bg-amber-50">
            <CardContent className="py-12 text-center">
              <p className="text-amber-900">
                No assets registered. Please add an asset to start monitoring.
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Metrics Cards */}
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
                    <div className="text-2xl font-bold">{metric.value}</div>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* Charts */}
            {dataLoading ? (
              <div className="grid gap-4 md:grid-cols-2">
                {[1, 2, 3, 4].map((i) => (
                  <Card key={i}>
                    <CardHeader>
                      <Skeleton className="h-6 w-32" />
                    </CardHeader>
                    <CardContent>
                      <Skeleton className="h-64 w-full" />
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : chartData.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <p className="text-muted-foreground">
                    No telemetry data available for the selected time range.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                {/* Power Chart */}
                <Card>
                  <CardHeader>
                    <CardTitle>Power Output</CardTitle>
                    <CardDescription>Real-time power generation (kW)</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={300}>
                      <AreaChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="time" />
                        <YAxis />
                        <Tooltip />
                        <Area
                          type="monotone"
                          dataKey="power"
                          stroke="#16a34a"
                          fill="#16a34a"
                          fillOpacity={0.2}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>

                {/* Energy Chart */}
                <Card>
                  <CardHeader>
                    <CardTitle>Energy Production</CardTitle>
                    <CardDescription>Cumulative energy generated (kWh)</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={300}>
                      <LineChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="time" />
                        <YAxis />
                        <Tooltip />
                        <Line type="monotone" dataKey="energy" stroke="#2563eb" strokeWidth={2} />
                      </LineChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>

                {/* Battery SoC Chart */}
                <Card>
                  <CardHeader>
                    <CardTitle>Battery State of Charge</CardTitle>
                    <CardDescription>Battery level over time (%)</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={300}>
                      <AreaChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="time" />
                        <YAxis />
                        <Tooltip />
                        <Area
                          type="monotone"
                          dataKey="soc"
                          stroke="#f59e0b"
                          fill="#f59e0b"
                          fillOpacity={0.2}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>

                {/* Voltage & Current Chart */}
                <Card>
                  <CardHeader>
                    <CardTitle>Electrical Parameters</CardTitle>
                    <CardDescription>Voltage (V) and Current (A)</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={300}>
                      <LineChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="time" />
                        <YAxis />
                        <Tooltip />
                        <Legend />
                        <Line type="monotone" dataKey="voltage" stroke="#8b5cf6" strokeWidth={2} />
                        <Line type="monotone" dataKey="current" stroke="#ec4899" strokeWidth={2} />
                      </LineChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              </div>
            )}

            {/* Workflow Status Monitor */}
            <WorkflowStatusMonitor className="mt-6" />
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
