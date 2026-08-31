import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { AlertCircle, Battery, DollarSign, Loader2, Sun, TrendingUp, Zap } from "lucide-react";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";

export default function EnergyInsights() {
  const { user } = useAuth();
  const [timeRange, setTimeRange] = useState<'24h' | '7d' | '30d'>('24h');

  // Fetch ML predictions (server returns an empty array when the model is
  // untrained; hoursAhead is capped at the server's 168-hour maximum).
  const { data: predictions, isLoading: loadingPredictions, isError: predictionsError, error: predictionsErrorMsg, refetch: refetchPredictions } = trpc.mlPredictions.getPricePredictions.useQuery(
    { hoursAhead: timeRange === '24h' ? 24 : 168 },
    { enabled: !!user }
  );

  // Fetch optimal trading times
  const { data: tradingTimes, isLoading: loadingRecommendations, isError: tradingTimesError, error: tradingTimesErrorMsg, refetch: refetchTradingTimes } = trpc.mlPredictions.getOptimalTradingTimes.useQuery(
    undefined,
    { enabled: !!user }
  );

  // Fetch user assets for solar capacity
  const { data: assets } = trpc.assets.list.useQuery(undefined, { enabled: !!user });

  const solarAssets = (assets?.assets || []).filter((a: any) => a.assetType === 'solar');
  // Asset capacity is stored in watts.
  const solarCapacityKw = solarAssets.reduce((sum: number, a: any) => sum + (a.capacity || 0), 0) / 1000;
  const firstSolarAssetId: number | null = solarAssets[0]?.id ?? null;

  // Real weather-aware solar yield forecast for the first solar asset.
  // The service returns { forecastAvailable: false, reason } when the weather
  // service has no forecast — never synthesized numbers.
  const yieldForecast = trpc.solarYield.getYieldForecast.useQuery(
    { assetId: firstSolarAssetId! },
    { enabled: !!user && firstSolarAssetId !== null }
  );

  // Price forecast series straight from the ML service (no derived quantities).
  const priceForecast = (predictions || []).map((p: any) => ({
    time: new Date(p.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    price: p.predictedPrice,
    confidence: p.confidence,
  }));

  // Trading opportunities from the ML service. No revenue is estimated here:
  // revenue needs a metered or forecast energy quantity, which we do not
  // fabricate.
  const tradingOpportunities = tradingTimes ? [
    ...(tradingTimes.bestBuyTimes || []).map((t: any) => ({
      time: new Date(t.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      action: 'BUY' as const,
      price: t.price,
      confidence: t.confidence,
    })),
    ...(tradingTimes.bestSellTimes || []).map((t: any) => ({
      time: new Date(t.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      action: 'SELL' as const,
      price: t.price,
      confidence: t.confidence,
    }))
  ] : [];

  const forecast = yieldForecast.data;
  const forecastDays = forecast?.forecastAvailable
    ? forecast.days.map((d: any) => ({
        date: d.date,
        peakSunHours: d.peakSunHours,
        expectedYieldKwh: d.expectedYieldWh !== null ? d.expectedYieldWh / 1000 : null,
      }))
    : [];
  const totalExpectedYieldKwh = forecast?.forecastAvailable
    ? forecast.days.reduce((sum: number, d: any) => sum + (d.expectedYieldWh ?? 0), 0) / 1000
    : null;
  const anyYieldUnknown = forecast?.forecastAvailable
    && forecast.days.some((d: any) => d.expectedYieldWh === null);

  const hasError = predictionsError || tradingTimesError || yieldForecast.isError;
  const errorMessage =
    predictionsErrorMsg?.message || tradingTimesErrorMsg?.message || (yieldForecast.error as any)?.message;

  const handleRefresh = async () => {
    try {
      await Promise.all([
        refetchPredictions(),
        refetchTradingTimes(),
        firstSolarAssetId !== null ? yieldForecast.refetch() : Promise.resolve(),
      ]);
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
      {hasError && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="flex items-center gap-3 py-4">
            <AlertCircle className="h-5 w-5 text-red-600" />
            <div>
              <p className="text-sm font-medium text-red-800">Some insights failed to load</p>
              <p className="text-sm text-red-700">{errorMessage || 'Unknown error'}</p>
            </div>
          </CardContent>
        </Card>
      )}
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
            <div className="text-2xl font-bold">{solarCapacityKw.toFixed(1)} kW</div>
            <p className="text-xs text-muted-foreground">
              {solarAssets.length > 0 ? `Across ${solarAssets.length} solar asset(s)` : 'No solar asset registered'}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Expected Solar Yield</CardTitle>
            <DollarSign className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {totalExpectedYieldKwh !== null && !anyYieldUnknown
                ? `${totalExpectedYieldKwh.toFixed(1)} kWh`
                : '—'}
            </div>
            <p className="text-xs text-muted-foreground">
              {firstSolarAssetId === null
                ? 'No solar asset registered'
                : forecast?.forecastAvailable
                  ? anyYieldUnknown
                    ? 'Yield unknown — no learned performance ratio yet'
                  : 'Next 3 days (weather-adjusted)'
                  : forecast?.reason || 'Forecast unavailable'}
            </p>
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
                : '—'}
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
              {predictions && predictions.length > 0 ? `${Math.round((predictions.reduce((sum: number, p: any) => sum + p.confidence, 0) / predictions.length))}%` : '—'}
            </div>
            <p className="text-xs text-muted-foreground">
              {predictions && predictions.length > 0 ? 'Prediction confidence' : 'No predictions yet'}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Solar Yield Forecast — from the weather-aware solar-yield service */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sun className="h-5 w-5 text-yellow-500" />
            Solar Yield Forecast
          </CardTitle>
          <CardDescription>
            Weather-adjusted expected yield for your solar asset over the next 3 days
          </CardDescription>
        </CardHeader>
        <CardContent>
          {firstSolarAssetId === null ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              Register a solar asset to see a yield forecast.
            </p>
          ) : yieldForecast.isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : yieldForecast.isError ? (
            <p className="text-sm text-red-600">{(yieldForecast.error as any)?.message || 'Failed to load yield forecast'}</p>
          ) : !forecast?.forecastAvailable ? (
            <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm">
              <AlertCircle className="h-4 w-4 mt-0.5 text-amber-600" />
              <div>
                <p className="font-medium text-amber-800">Forecast unavailable</p>
                <p className="text-amber-700">{forecast?.reason || 'The weather service returned no forecast.'}</p>
              </div>
            </div>
          ) : (
            <>
              {forecast.mockData && (
                <p className="text-xs text-amber-700 mb-2">
                  Note: the weather service is returning opted-in mock data for this location.
                </p>
              )}
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={forecastDays}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="peakSunHours" fill="#eab308" name="Peak sun hours" />
                  {!anyYieldUnknown && (
                    <Bar dataKey="expectedYieldKwh" fill="#16a34a" name="Expected yield (kWh)" />
                  )}
                </BarChart>
              </ResponsiveContainer>
              {anyYieldUnknown && (
                <p className="text-xs text-muted-foreground mt-2">
                  Expected yield in kWh is not shown: no performance ratio has been learned from
                  this asset's metered history yet. Peak sun hours above are from the weather forecast.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Price Forecast */}
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
          {priceForecast.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No price predictions available — the forecasting model has not been trained on enough data yet.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={priceForecast}>
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
          )}
        </CardContent>
      </Card>

      {/* Trading Recommendations */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-purple-500" />
            AI Trading Recommendations
          </CardTitle>
          <CardDescription>
            Optimal buy/sell windows from the price-forecast model. No revenue is
            estimated — that would require a metered energy quantity.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {tradingOpportunities.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No trading recommendations available yet.
            </p>
          ) : (
            <div className="space-y-3">
              {tradingOpportunities.slice(0, 10).map((opp: any, i: number) => (
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
                        {opp.price !== null && opp.price !== undefined
                          ? `Predicted price: ${Number(opp.price).toFixed(2)} TZS/kWh`
                          : 'Predicted price: —'}
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
          )}
        </CardContent>
      </Card>
    </div>
  );
}
