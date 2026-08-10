import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { Activity, Battery, DollarSign, TrendingUp, Zap, AlertCircle, Wifi } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useWebSocket } from "@/hooks/useWebSocket";
import { Badge } from "@/components/ui/badge";
import PowerFlowWidget from "@/components/PowerFlowWidget";
import BatteryStatusWidget from "@/components/BatteryStatusWidget";
import OnboardingWizard from "@/components/OnboardingWizard";
import { useState } from "react";

export default function Home() {
  const [onboardingCompleted, setOnboardingCompleted] = useState(false);
  const { telemetry: realtimeTelemetry, connected } = useWebSocket();
  const { data: onboardingStatus, isLoading: onboardingLoading } = trpc.onboarding.getStatus.useQuery();
  const { data: assetsData, isLoading: assetsLoading } = trpc.assets.list.useQuery();
  const assets = assetsData?.assets || [];
  
  // Always call all hooks before any conditional returns
  const { data: latestTelemetry, isLoading: telemetryLoading } = trpc.telemetry.getLatest.useQuery(
    { assetId: assets[0]?.id || 0 },
    { enabled: assets.length > 0 }
  );
  
  // Show onboarding wizard for new users (after all hooks are called)
  const shouldShowOnboarding = !onboardingLoading && onboardingStatus && !onboardingStatus.completed && !onboardingCompleted;
  
  if (shouldShowOnboarding) {
    return <OnboardingWizard onComplete={() => setOnboardingCompleted(true)} />;
  }
  
  // Use real-time data if available
  const displayTelemetry = (connected && realtimeTelemetry) ? realtimeTelemetry : latestTelemetry;

  const isLoading = assetsLoading || telemetryLoading;

  // Calculate summary metrics from real-time or latest data
  const totalGeneration = displayTelemetry?.power || 0;
  const totalConsumption = displayTelemetry?.energy || 0;
  const batteryLevel = displayTelemetry?.stateOfCharge ? displayTelemetry.stateOfCharge / 100 : 0;
  const gridExport = displayTelemetry?.power && displayTelemetry.power > 0 ? displayTelemetry.power : 0;
  const gridImport = displayTelemetry?.power && displayTelemetry.power < 0 ? Math.abs(displayTelemetry.power) : 0;
  const netFlow = gridExport - gridImport;

  const stats = [
    {
      title: "Total Generation",
      value: `${totalGeneration.toFixed(2)} kWh`,
      description: "Current power generation",
      icon: Zap,
      color: "text-green-600",
      bgColor: "bg-green-50",
    },
    {
      title: "Total Consumption",
      value: `${totalConsumption.toFixed(2)} kWh`,
      description: "Current power usage",
      icon: Activity,
      color: "text-blue-600",
      bgColor: "bg-blue-50",
    },
    {
      title: "Battery Status",
      value: `${batteryLevel.toFixed(0)}%`,
      description: "Current battery level",
      icon: Battery,
      color: "text-amber-600",
      bgColor: "bg-amber-50",
    },
    {
      title: "Grid Flow",
      value: `${netFlow.toFixed(2)} kWh`,
      description: netFlow >= 0 ? "Exporting to grid" : "Importing from grid",
      icon: TrendingUp,
      color: netFlow >= 0 ? "text-green-600" : "text-red-600",
      bgColor: netFlow >= 0 ? "bg-green-50" : "bg-red-50",
    },
  ];

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
            {connected && (
              <Badge variant="default" className="bg-green-600 flex items-center gap-1 animate-pulse">
                <Wifi className="h-3 w-3" />
                Live
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground mt-2">
            Welcome to your Virtual Power Plant dashboard. Monitor your energy generation, consumption, and trading activities.
          </p>
        </div>

        {/* Stats Grid */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {stats.map((stat, index) => (
            <Card key={index}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">
                  {stat.title}
                </CardTitle>
                <div className={`p-2 rounded-lg ${stat.bgColor}`}>
                  <stat.icon className={`h-4 w-4 ${stat.color}`} />
                </div>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <div className="space-y-2">
                    <Skeleton className="h-8 w-24" />
                    <Skeleton className="h-4 w-32" />
                  </div>
                ) : (
                  <>
                    <div className="text-2xl font-bold">{stat.value}</div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {stat.description}
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Real-time Widgets */}
        {!isLoading && displayTelemetry && (
          <div className="grid gap-4 md:grid-cols-2">
            <PowerFlowWidget
              data={{
                generation: displayTelemetry.power || 0,
                consumption: displayTelemetry.energy || 0,
                batteryPower: (displayTelemetry.stateOfCharge || 50) > 50 ? 500 : -500,
                batteryLevel: displayTelemetry.stateOfCharge || 0,
                gridPower: (displayTelemetry.power || 0) - (displayTelemetry.energy || 0),
              }}
            />
            <BatteryStatusWidget
              level={displayTelemetry.stateOfCharge || 0}
              power={(displayTelemetry.stateOfCharge || 50) > 50 ? 500 : -500}
              voltage={displayTelemetry.voltage || 0}
              current={displayTelemetry.current || 0}
              temperature={25}
            />
          </div>
        )}

        {/* Quick Actions */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Zap className="h-5 w-5 text-primary" />
                My Assets
              </CardTitle>
              <CardDescription>
                {assetsLoading ? (
                  <Skeleton className="h-4 w-32" />
                ) : (
                  `${assets.length} registered assets`
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                View and manage your solar panels, batteries, and other energy assets.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-primary" />
                Trading
              </CardTitle>
              <CardDescription>Active trading enabled</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Trade your excess power automatically or manually in the marketplace.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <DollarSign className="h-5 w-5 text-primary" />
                Billing
              </CardTitle>
              <CardDescription>View invoices and payments</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Track your earnings from power trading and manage payment methods.
              </p>
            </CardContent>
          </Card>
        </div>

        {/* System Status */}
        {!assetsLoading && assets.length === 0 && (
          <Card className="border-amber-200 bg-amber-50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-amber-900">
                <AlertCircle className="h-5 w-5" />
                No Assets Registered
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-amber-800">
                You haven't registered any energy assets yet. Get started by adding your solar panels, batteries, or other equipment in the Assets section.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
