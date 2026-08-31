import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { Activity, Battery, DollarSign, RefreshCw, TrendingUp, Zap, AlertCircle, Wifi } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useWebSocket } from "@/hooks/useWebSocket";
import { Badge } from "@/components/ui/badge";
import OnboardingWizard from "@/components/OnboardingWizard";
import { useState } from "react";

// Telemetry column units (drizzle/schema.ts): power W, energy cumulative Wh,
// voltage mV, current mA, stateOfCharge %×100, temperature °C×100.
// Every field is nullable — a missing reading is rendered as '—', never a default.
const NO_READING = "—";

function TelemetryField({ label, value, unit }: { label: string; value: number | null | undefined; unit: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-lg font-semibold">
        {value === null || value === undefined ? NO_READING : `${value} ${unit}`}
      </span>
    </div>
  );
}

export default function Home() {
  const [onboardingCompleted, setOnboardingCompleted] = useState(false);
  const { telemetry: realtimeTelemetry, connected } = useWebSocket();
  const { data: onboardingStatus, isLoading: onboardingLoading } = trpc.onboarding.getStatus.useQuery();
  const { data: assetsData, isLoading: assetsLoading, isError: assetsError, error: assetsErrorMsg, refetch: refetchAssets } = trpc.assets.list.useQuery();
  const assets = assetsData?.assets || [];

  // Always call all hooks before any conditional returns
  const { data: latestTelemetry, isLoading: telemetryLoading, isError: telemetryError, error: telemetryErrorMsg, refetch: refetchTelemetry } = trpc.telemetry.getLatest.useQuery(
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
  const hasError = assetsError || telemetryError;

  // Summary metrics from real readings only. A null field is '—', never a
  // substituted default. `energy` is cumulative watt-hours metered, not an
  // instantaneous consumption reading, and there is no grid-flow field in
  // telemetry, so no import/export direction is ever inferred.
  const powerW = displayTelemetry?.power ?? null;
  const meteredEnergyWh = displayTelemetry?.energy ?? null;
  const socPercent = displayTelemetry?.stateOfCharge != null
    ? displayTelemetry.stateOfCharge / 100
    : null;

  const stats = [
    {
      title: "Power",
      value: powerW !== null ? `${(powerW / 1000).toFixed(2)} kW` : NO_READING,
      description: powerW !== null ? "Latest power reading" : "No power reading",
      icon: Zap,
      color: "text-green-600",
      bgColor: "bg-green-50",
    },
    {
      title: "Metered Energy",
      value: meteredEnergyWh !== null ? `${(meteredEnergyWh / 1000).toFixed(2)} kWh` : NO_READING,
      description: meteredEnergyWh !== null ? "Cumulative energy metered" : "No energy reading",
      icon: Activity,
      color: "text-blue-600",
      bgColor: "bg-blue-50",
    },
    {
      title: "Battery Status",
      value: socPercent !== null ? `${socPercent.toFixed(0)}%` : NO_READING,
      description: socPercent !== null ? "Current battery level" : "No battery reading",
      icon: Battery,
      color: "text-amber-600",
      bgColor: "bg-amber-50",
    },
    {
      title: "Grid Flow",
      value: NO_READING,
      description: "No grid import/export reading available",
      icon: TrendingUp,
      color: "text-gray-400",
      bgColor: "bg-gray-50",
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

        {/* Live telemetry — every field is rendered only when a real reading
            exists. Consumption power, battery charge/discharge power and grid
            flow are not present in telemetry, so they are not shown. */}
        {hasError ? (
          <Card className="border-red-200 bg-red-50">
            <CardContent className="flex items-center justify-between gap-3 py-4">
              <div className="flex items-center gap-3">
                <AlertCircle className="h-5 w-5 text-red-600" />
                <p className="text-sm text-red-800">
                  {(assetsErrorMsg || telemetryErrorMsg)?.message || "Failed to load dashboard data."}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  refetchAssets();
                  if (assets.length > 0) refetchTelemetry();
                }}
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Retry
              </Button>
            </CardContent>
          </Card>
        ) : !isLoading && (
          displayTelemetry ? (
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Zap className="h-5 w-5 text-green-600" />
                    Live Power
                  </CardTitle>
                  <CardDescription>
                    Latest reading {displayTelemetry.timestamp ? `at ${new Date(displayTelemetry.timestamp).toLocaleString()}` : ""}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <TelemetryField
                    label="Power"
                    value={powerW !== null ? Number((powerW / 1000).toFixed(2)) : null}
                    unit="kW"
                  />
                  <TelemetryField
                    label="Metered energy (cumulative)"
                    value={meteredEnergyWh !== null ? Number((meteredEnergyWh / 1000).toFixed(2)) : null}
                    unit="kWh"
                  />
                  <TelemetryField
                    label="Frequency"
                    value={displayTelemetry.frequency != null ? Number((displayTelemetry.frequency / 1000).toFixed(2)) : null}
                    unit="Hz"
                  />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Battery className="h-5 w-5 text-amber-600" />
                    Battery & Electrical
                  </CardTitle>
                  <CardDescription>Only readings reported by the device are shown</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <TelemetryField
                    label="State of charge"
                    value={socPercent !== null ? Number(socPercent.toFixed(1)) : null}
                    unit="%"
                  />
                  <TelemetryField
                    label="Voltage"
                    value={displayTelemetry.voltage != null ? Number((displayTelemetry.voltage / 1000).toFixed(1)) : null}
                    unit="V"
                  />
                  <TelemetryField
                    label="Current"
                    value={displayTelemetry.current != null ? Number((displayTelemetry.current / 1000).toFixed(2)) : null}
                    unit="A"
                  />
                  <TelemetryField
                    label="Temperature"
                    value={displayTelemetry.temperature != null ? Number((displayTelemetry.temperature / 100).toFixed(1)) : null}
                    unit="°C"
                  />
                </CardContent>
              </Card>
            </div>
          ) : assets.length > 0 ? (
            <Card>
              <CardContent className="flex items-center gap-3 py-6 text-muted-foreground">
                <AlertCircle className="h-5 w-5" />
                <p className="text-sm">No telemetry reading available for this asset yet.</p>
              </CardContent>
            </Card>
          ) : null
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
