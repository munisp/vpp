import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Activity, Zap, TrendingUp, AlertCircle, CheckCircle2 } from 'lucide-react';
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from 'recharts';

export default function GridOperator() {
  const [region] = useState<string | undefined>(undefined);

  const { data: gridStatus, isLoading: statusLoading } = trpc.gridOperator.adminGetStatus.useQuery({ region });
  const { data: pricing } = trpc.gridOperator.adminGetPricing.useQuery({ region });
  const { data: forecast } = trpc.gridOperator.adminGetForecast.useQuery({ hoursAhead: 24, region });
  const { data: vppCapacity } = trpc.gridOperator.getVPPCapacity.useQuery({ region });
  const { data: vppPerformance } = trpc.gridOperator.getVPPPerformance.useQuery({ timeWindow: 24 });

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'normal':
        return 'text-green-500';
      case 'warning':
        return 'text-yellow-500';
      case 'critical':
        return 'text-red-500';
      default:
        return 'text-gray-500';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'normal':
        return <CheckCircle2 className="h-5 w-5 text-green-500" />;
      case 'warning':
        return <AlertCircle className="h-5 w-5 text-yellow-500" />;
      case 'critical':
        return <AlertCircle className="h-5 w-5 text-red-500" />;
      default:
        return <Activity className="h-5 w-5 text-gray-500" />;
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Grid Operator Integration</h1>
        <p className="text-muted-foreground">Monitor grid status and VPP performance</p>
      </div>

      {/* Grid Status */}
      {gridStatus && (
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                {getStatusIcon(gridStatus.status)}
                Grid Status
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold capitalize">
                <Badge variant={gridStatus.status === 'normal' ? 'secondary' : gridStatus.status === 'warning' ? 'outline' : 'destructive'}>
                  {gridStatus.status}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Region: {gridStatus.region}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Activity className="h-4 w-4" />
                Load
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{gridStatus.load.toFixed(1)} MW</div>
              <p className="text-xs text-muted-foreground mt-2">
                Capacity: {gridStatus.capacity} MW
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <TrendingUp className="h-4 w-4" />
                Utilization
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-bold ${getStatusColor(gridStatus.status)}`}>
                {gridStatus.utilization.toFixed(1)}%
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                {gridStatus.utilization > 80 ? 'High load' : 'Normal operation'}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Zap className="h-4 w-4" />
                Frequency
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{gridStatus.frequency.toFixed(2)} Hz</div>
              <p className="text-xs text-muted-foreground mt-2">
                Voltage: {gridStatus.voltage.toFixed(1)} V
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Pricing Signal */}
      {pricing && (
        <Card>
          <CardHeader>
            <CardTitle>Current Pricing Signal</CardTitle>
            <CardDescription>Real-time electricity pricing</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-3">
              <div>
                <div className="text-sm font-medium text-muted-foreground">Current Price</div>
                <div className="text-3xl font-bold mt-1">{pricing.price} ¢/kWh</div>
              </div>
              <div>
                <div className="text-sm font-medium text-muted-foreground">Price Type</div>
                <div className="text-lg font-medium mt-1 capitalize">{pricing.priceType.replace('_', ' ')}</div>
              </div>
              <div>
                <div className="text-sm font-medium text-muted-foreground">Valid Until</div>
                <div className="text-lg font-medium mt-1">{new Date(pricing.validUntil).toLocaleTimeString()}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Load Forecast */}
      {forecast && forecast.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>24-Hour Load Forecast</CardTitle>
            <CardDescription>Predicted grid load and utilization</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={forecast}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="forecastTime"
                  tickFormatter={(value) => new Date(value).getHours() + ':00'}
                />
                <YAxis yAxisId="left" label={{ value: 'Load (MW)', angle: -90, position: 'insideLeft' }} />
                <YAxis yAxisId="right" orientation="right" label={{ value: 'Utilization (%)', angle: 90, position: 'insideRight' }} />
                <Tooltip
                  labelFormatter={(value) => new Date(value).toLocaleString()}
                  formatter={(value: number, name: string) => [
                    name === 'predictedLoad' ? `${value.toFixed(1)} MW` : `${value.toFixed(1)}%`,
                    name === 'predictedLoad' ? 'Load' : 'Utilization'
                  ]}
                />
                <Line yAxisId="left" type="monotone" dataKey="predictedLoad" stroke="#3b82f6" strokeWidth={2} dot={false} />
                <Line yAxisId="right" type="monotone" dataKey="predictedUtilization" stroke="#10b981" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* VPP Capacity */}
      {vppCapacity && (
        <Card>
          <CardHeader>
            <CardTitle>VPP Aggregate Capacity</CardTitle>
            <CardDescription>Total capacity available for demand response</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-4">
              <div>
                <div className="text-sm font-medium text-muted-foreground">Total Capacity</div>
                <div className="text-2xl font-bold mt-1">{(vppCapacity.totalCapacity / 1000).toFixed(1)} MW</div>
              </div>
              <div>
                <div className="text-sm font-medium text-muted-foreground">Available Now</div>
                <div className="text-2xl font-bold mt-1 text-green-600">{(vppCapacity.availableCapacity / 1000).toFixed(1)} MW</div>
              </div>
              <div>
                <div className="text-sm font-medium text-muted-foreground">Active Assets</div>
                <div className="text-2xl font-bold mt-1">{vppCapacity.activeAssets}</div>
              </div>
              <div>
                <div className="text-sm font-medium text-muted-foreground">Total Assets</div>
                <div className="text-2xl font-bold mt-1">{vppCapacity.totalAssets}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* VPP Performance */}
      {vppPerformance && (
        <Card>
          <CardHeader>
            <CardTitle>VPP Performance (Last 24 Hours)</CardTitle>
            <CardDescription>Demand response participation and results</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-5">
              <div>
                <div className="text-sm font-medium text-muted-foreground">Energy Delivered</div>
                <div className="text-2xl font-bold mt-1">{(vppPerformance.energyDelivered / 1000).toFixed(1)} MWh</div>
              </div>
              <div>
                <div className="text-sm font-medium text-muted-foreground">Reduction Achieved</div>
                <div className="text-2xl font-bold mt-1">{(vppPerformance.reductionAchieved / 1000).toFixed(1)} MW</div>
              </div>
              <div>
                <div className="text-sm font-medium text-muted-foreground">Events Participated</div>
                <div className="text-2xl font-bold mt-1">{vppPerformance.eventsParticipated}</div>
              </div>
              <div>
                <div className="text-sm font-medium text-muted-foreground">Compliance Rate</div>
                <div className="text-2xl font-bold mt-1 text-green-600">{vppPerformance.complianceRate.toFixed(1)}%</div>
              </div>
              <div>
                <div className="text-sm font-medium text-muted-foreground">Revenue Generated</div>
                <div className="text-2xl font-bold mt-1">{(vppPerformance.revenue / 100).toFixed(2)} TZS</div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
