import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { AlertCircle, Battery, Cloud, DollarSign, Loader2, Sun, TrendingUp, Zap } from "lucide-react";
import { useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";

export default function EnergyInsights() {
  const { user } = useAuth();
  const [timeRange, setTimeRange] = useState<'24h' | '7d' | '30d'>('24h');

  // Fetch ML predictions
  const { data: predictions, isLoading: loadingPredictions, refetch: refetchPredictions } = trpc.mlPredictions.getPricePredictions.useQuery(
    { hoursAhead: timeRange === '24h' ? 24 : timeRange === '7d' ? 168 : 720 },
    { enabled: !!user }
  );

  // Fetch optimal trading times
  const { data: tradingTimes, isLoading: loadingRecommendations } = trpc.mlPredictions.getOptimalTradingTimes.useQuery(
    undefined,
    { enabled: !!user }
  );

  // Fetch user assets for solar capacity
  const { data: assets } = trpc.assets.list.useQuery(undefined, { enabled: !!user });

  const solarCapacity = assets?.assets?.filter((a: any) => a.assetType === 'solar_panel')
    .reduce((sum: number, a: any) => sum + (a.capacity || 0), 0) || 0;

  // Calculate solar generation forecast
  const solarForecast = predictions?.map((p: any) => {
    // Estimate generation based on time of day and price (inverse correlation)
    const hour = new Date(p.timestamp).getHours();
    const isDaytime = hour >= 6 && hour <= 18;
    const hoursFromNoon = Math.abs(12 - hour);
    const generationFactor = isDaytime ? Math.cos((hoursFromNoon / 6) * (Math.PI / 2)) : 0;
    const generationKWh = solarCapacity * generationFactor * 0.8; // 80% efficiency
    
    return {
      time: new Date(p.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      generation: Math.round(generationKWh * 100) / 100,
      price: p.predictedPrice,
      confidence: p.confidence,
    };
  }) || [];

  // Calculate revenue optimization from trading times
  const revenueOpportunities = tradingTimes ? [
    ...(tradingTimes.bestBuyTimes || []).map((t: any) => ({
      time: new Date(t.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      action: 'BUY',
      expectedRevenue: 0,
      confidence: t.confidence,
    })),
    ...(tradingTimes.bestSellTimes || []).map((t: any) => ({
      time: new Date(t.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      action: 'SELL',
      expectedRevenue: t.price * solarCapacity * 0.5, // Estimate
      confidence: t.confidence,
    }))
  ] : [];

  // Calculate total potential revenue
  const totalPotentialRevenue = revenueOpportunities
    .reduce((sum: number, r: any) => sum + r.expectedRevenue, 0);

  // Weather impact analysis
  const weatherImpact = solarForecast.slice(0, 24).map((f: any, i: number) => ({
    hour: f.time,
    generation: f.generation,
    price: f.price,
    revenue: f.generation * f.price,
  }));

  const handleRefresh = async () => {
    try {
      await refetchPredictions();
      toast.success('Insights refreshed');
    } catch (error) {
      toast.error('Failed to refresh insights');
    }
  };

  if (!user) {
    return (
      <div className="container py-8">
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <p className="text-muted-foreground">Please log in to view energy insights</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loadingPredictions || loadingRecommendations) {
    return (
      <div className="container py-8">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </div>
    );
  }

  return (
    <div className="container py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Energy Insights</h1>
          <p className="text-muted-foreground">
            AI-powered forecasts and revenue optimization recommendations
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-2">
            <Button
              variant={timeRange === '24h' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setTimeRange('24h')}
            >
              24 Hours
            </Button>
            <Button
              variant={timeRange === '7d' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setTimeRange('7d')}
            >
              7 Days
            </Button>
            <Button
              variant={timeRange === '30d' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setTimeRange('30d')}
            >
              30 Days
            </Button>
          </div>
          <Button onClick={handleRefresh} variant="outline" size="sm">
            Refresh
          </Button>
        </div>
      </div>

      {/* Key Metrics */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Solar Capacity</CardTitle>
            <Sun className="h-4 w-4 text-yellow-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{solarCapacity.toFixed(1)} kW</div>
            <p className="text-xs text-muted-foreground">Installed capacity</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Potential Revenue</CardTitle>
            <DollarSign className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {totalPotentialRevenue.toFixed(2)} TZS
            </div>
            <p className="text-xs text-muted-foreground">Next 24 hours</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Best Trading Time</CardTitle>
            <TrendingUp className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {tradingTimes?.bestSellTimes?.[0]?.time 
                ? new Date(tradingTimes.bestSellTimes[0].time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
                : 'N/A'}
            </div>
            <p className="text-xs text-muted-foreground">Peak price period</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Avg. Confidence</CardTitle>
            <Zap className="h-4 w-4 text-purple-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {predictions && predictions.length > 0 ? Math.round((predictions.reduce((sum: number, p: any) => sum + p.confidence, 0) / predictions.length)) : 0}%
            </div>
            <p className="text-xs text-muted-foreground">Prediction accuracy</p>
          </CardContent>
        </Card>
      </div>

      {/* Solar Generation Forecast */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sun className="h-5 w-5 text-yellow-500" />
            Solar Generation Forecast
          </CardTitle>
          <CardDescription>
            Predicted solar energy generation based on weather forecasts
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={solarForecast.slice(0, 24)}>
              <defs>
                <linearGradient id="colorGeneration" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#eab308" stopOpacity={0.8}/>
                  <stop offset="95%" stopColor="#eab308" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="time" />
              <YAxis />
              <Tooltip />
              <Legend />
              <Area 
                type="monotone" 
                dataKey="generation" 
                stroke="#eab308" 
                fillOpacity={1} 
                fill="url(#colorGeneration)"
                name="Generation (kWh)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Price Forecast & Revenue Optimization */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-blue-500" />
              Price Forecast
            </CardTitle>
            <CardDescription>
              Predicted electricity prices for optimal trading
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={solarForecast.slice(0, 24)}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="time" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Line 
                  type="monotone" 
                  dataKey="price" 
                  stroke="#3b82f6" 
                  strokeWidth={2}
                  name="Price (TZS/kWh)"
                  dot={{ r: 3 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <DollarSign className="h-5 w-5 text-green-500" />
              Revenue Optimization
            </CardTitle>
            <CardDescription>
              Expected revenue from weather-optimized trading
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={weatherImpact}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="hour" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Bar dataKey="revenue" fill="#10b981" name="Revenue (TZS)" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Trading Recommendations */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-purple-500" />
            AI Trading Recommendations
          </CardTitle>
          <CardDescription>
            Optimal buy/sell actions based on price predictions and your solar capacity
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {revenueOpportunities.slice(0, 10).map((opp: any, i: number) => (
              <div 
                key={i}
                className="flex items-center justify-between p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className={`p-2 rounded-full ${
                    opp.action === 'SELL' ? 'bg-green-100 text-green-700' :
                    opp.action === 'BUY' ? 'bg-blue-100 text-blue-700' :
                    'bg-gray-100 text-gray-700'
                  }`}>
                    {opp.action === 'SELL' ? <TrendingUp className="h-4 w-4" /> :
                     opp.action === 'BUY' ? <Battery className="h-4 w-4" /> :
                     <AlertCircle className="h-4 w-4" />}
                  </div>
                  <div>
                    <p className="font-medium">{opp.action} at {opp.time}</p>
                    <p className="text-sm text-muted-foreground">
                      Expected revenue: {opp.expectedRevenue.toFixed(2)} TZS
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm font-medium">{opp.confidence}% confidence</p>
                  <div className="w-24 h-2 bg-gray-200 rounded-full mt-1">
                    <div 
                      className="h-full bg-green-500 rounded-full"
                      style={{ width: `${opp.confidence}%` }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Weather Impact Analysis */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Cloud className="h-5 w-5 text-gray-500" />
            Weather Impact Analysis
          </CardTitle>
          <CardDescription>
            How weather conditions affect your solar generation and revenue
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="p-4 rounded-lg border bg-card">
                <p className="text-sm text-muted-foreground">Peak Generation Hour</p>
                <p className="text-2xl font-bold mt-1">
                  {weatherImpact.reduce((max: any, curr: any) => 
                    curr.generation > max.generation ? curr : max, weatherImpact[0]
                  )?.hour || 'N/A'}
                </p>
              </div>
              <div className="p-4 rounded-lg border bg-card">
                <p className="text-sm text-muted-foreground">Total Generation (24h)</p>
                <p className="text-2xl font-bold mt-1">
                  {weatherImpact.reduce((sum: number, w: any) => sum + w.generation, 0).toFixed(1)} kWh
                </p>
              </div>
              <div className="p-4 rounded-lg border bg-card">
                <p className="text-sm text-muted-foreground">Total Revenue (24h)</p>
                <p className="text-2xl font-bold mt-1">
                  {weatherImpact.reduce((sum: number, w: any) => sum + w.revenue, 0).toFixed(2)} TZS
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
