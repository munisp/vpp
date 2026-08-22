import { trpc } from '@/lib/trpc';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, TrendingDown, Minus, Brain, Zap, Clock } from 'lucide-react';
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid, Area, AreaChart } from 'recharts';

export default function MLPredictions() {
  const { data: predictions } = trpc.mlPredictions.getPricePredictions.useQuery({ hoursAhead: 24 });
  const { data: forecast } = trpc.mlPredictions.getPriceForecast.useQuery({ hoursAhead: 48 });
  const { data: optimalTimes } = trpc.mlPredictions.getOptimalTradingTimes.useQuery();
  const { data: patterns } = trpc.mlPredictions.analyzePricePatterns.useQuery({ days: 30 });
  const { data: metrics } = trpc.mlPredictions.getModelMetrics.useQuery();
  const { data: insights } = trpc.mlPredictions.getPersonalizedInsights.useQuery();

  const getTrendIcon = (trend: string) => {
    switch (trend) {
      case 'rising':
        return <TrendingUp className="h-4 w-4 text-red-500" />;
      case 'falling':
        return <TrendingDown className="h-4 w-4 text-green-500" />;
      default:
        return <Minus className="h-4 w-4 text-gray-500" />;
    }
  };

  const getTrendColor = (trend: string) => {
    switch (trend) {
      case 'rising':
        return 'text-red-600';
      case 'falling':
        return 'text-green-600';
      default:
        return 'text-gray-600';
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">ML Price Predictions</h1>
        <p className="text-muted-foreground">AI-powered electricity price forecasting and trading recommendations</p>
      </div>

      {/* Model Performance */}
      {metrics && (
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Brain className="h-4 w-4" />
                Model Accuracy
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {metrics.accuracy !== null ? `${metrics.accuracy.toFixed(1)}%` : "not measured"}
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                R² Score: {metrics.r2Score !== null ? metrics.r2Score.toFixed(2) : "—"}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Mean Absolute Error</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {metrics.mae !== null ? `${metrics.mae.toFixed(2)}¢` : "not measured"}
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                MSE: {metrics.mse !== null ? metrics.mse.toFixed(2) : "—"}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Training Data</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{(metrics.trainingDataPoints / 1000).toFixed(1)}K</div>
              <p className="text-xs text-muted-foreground mt-2">
                Data points
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Last Trained</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {metrics.lastTrained ? new Date(metrics.lastTrained).toLocaleDateString() : "never"}
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                {metrics.lastTrained
                  ? new Date(metrics.lastTrained).toLocaleTimeString()
                  : "model has not been trained"}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Personalized Insights */}
      {insights && (
        <Card>
          <CardHeader>
            <CardTitle>Personalized Trading Insights</CardTitle>
            <CardDescription>AI-powered recommendations based on your assets</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="text-sm font-medium text-muted-foreground">Potential Revenue Today</div>
              <div className="text-3xl font-bold text-green-600">{insights.totalPotentialRevenue.toFixed(2)} TZS</div>
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium">Key Insights</div>
              {insights.insights.map((insight, idx) => (
                <div key={idx} className="flex items-start gap-2 p-3 bg-muted rounded-lg">
                  <Zap className="h-4 w-4 mt-0.5 text-primary" />
                  <div className="flex-1">
                    <div className="text-sm">{insight.message}</div>
                    <Badge variant={insight.priority === 'high' ? 'default' : 'outline'} className="mt-1">
                      {insight.priority} priority
                    </Badge>
                  </div>
                </div>
              ))}
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium">Recommended Actions</div>
              {insights.recommendedActions.map((action, idx) => (
                <div key={idx} className="flex items-center justify-between p-3 border rounded-lg">
                  <div className="text-sm">{action.action}</div>
                  <div className="text-sm font-medium text-green-600">{action.expectedBenefit}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Price Forecast Chart */}
      {forecast && forecast.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>48-Hour Price Forecast</CardTitle>
            <CardDescription>Predicted electricity prices with confidence intervals</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={350}>
              <AreaChart data={forecast}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="timestamp"
                  tickFormatter={(value) => {
                    const date = new Date(value);
                    return `${date.getHours()}:00`;
                  }}
                />
                <YAxis label={{ value: 'Price (¢/kWh)', angle: -90, position: 'insideLeft' }} />
                <Tooltip
                  labelFormatter={(value) => new Date(value).toLocaleString()}
                  formatter={(value: number, name: string) => [
                    `${value}¢`,
                    name === 'predictedPrice' ? 'Predicted' : name === 'upperBound' ? 'Upper Bound' : 'Lower Bound'
                  ]}
                />
                <Area type="monotone" dataKey="upperBound" stroke="#93c5fd" fill="#dbeafe" fillOpacity={0.3} />
                <Area type="monotone" dataKey="predictedPrice" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.1} strokeWidth={2} />
                <Area type="monotone" dataKey="lowerBound" stroke="#93c5fd" fill="#dbeafe" fillOpacity={0.3} />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Optimal Trading Times */}
      {optimalTimes && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <TrendingDown className="h-5 w-5 text-green-500" />
                Best Times to Buy
              </CardTitle>
              <CardDescription>Lowest predicted prices - charge batteries</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {optimalTimes.bestBuyTimes.map((time, idx) => (
                  <div key={idx} className="flex items-center justify-between p-3 border rounded-lg">
                    <div>
                      <div className="font-medium">{new Date(time.time).toLocaleTimeString()}</div>
                      <div className="text-sm text-muted-foreground">Confidence: {time.confidence}%</div>
                    </div>
                    <div className="text-xl font-bold text-green-600">{time.price}¢</div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-red-500" />
                Best Times to Sell
              </CardTitle>
              <CardDescription>Highest predicted prices - sell energy</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {optimalTimes.bestSellTimes.map((time, idx) => (
                  <div key={idx} className="flex items-center justify-between p-3 border rounded-lg">
                    <div>
                      <div className="font-medium">{new Date(time.time).toLocaleTimeString()}</div>
                      <div className="text-sm text-muted-foreground">Confidence: {time.confidence}%</div>
                    </div>
                    <div className="text-xl font-bold text-red-600">{time.price}¢</div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Price Patterns Analysis */}
      {patterns && (
        <Card>
          <CardHeader>
            <CardTitle>Price Pattern Analysis (30 Days)</CardTitle>
            <CardDescription>Historical trends and optimal trading patterns</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-6 md:grid-cols-3">
              <div>
                <div className="text-sm font-medium text-muted-foreground mb-2">Peak Hours</div>
                <div className="flex flex-wrap gap-2">
                  {patterns.peakHours.map((hour) => (
                    <Badge key={hour} variant="destructive">
                      {hour}:00
                    </Badge>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-2">Highest prices - sell energy</p>
              </div>

              <div>
                <div className="text-sm font-medium text-muted-foreground mb-2">Off-Peak Hours</div>
                <div className="flex flex-wrap gap-2">
                  {patterns.offPeakHours.map((hour) => (
                    <Badge key={hour} variant="secondary">
                      {hour}:00
                    </Badge>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-2">Lowest prices - charge batteries</p>
              </div>

              <div>
                <div className="text-sm font-medium text-muted-foreground mb-2">Best Trading Days</div>
                <div className="flex flex-wrap gap-2">
                  {patterns.bestTradingDays.map((day) => (
                    <Badge key={day} variant="outline">
                      {day}
                    </Badge>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-2">Highest volatility - more opportunities</p>
              </div>
            </div>

            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <div className="p-4 bg-muted rounded-lg">
                <div className="text-sm font-medium text-muted-foreground">Average Price</div>
                <div className="text-2xl font-bold mt-1">{patterns.averagePrice}¢/kWh</div>
              </div>

              <div className="p-4 bg-muted rounded-lg">
                <div className="text-sm font-medium text-muted-foreground">Price Volatility</div>
                <div className="text-2xl font-bold mt-1">{patterns.priceVolatility}%</div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent Predictions */}
      {predictions && predictions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Next 24 Hours Predictions</CardTitle>
            <CardDescription>Hourly price predictions with confidence levels</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {predictions.slice(0, 12).map((pred, idx) => (
                <div key={idx} className="flex items-center justify-between p-3 border rounded-lg">
                  <div className="flex items-center gap-3">
                    <Clock className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <div className="font-medium">{new Date(pred.timestamp).toLocaleTimeString()}</div>
                      <div className="text-sm text-muted-foreground">
                        Confidence: {pred.confidence}%
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <div className="text-lg font-bold">{pred.predictedPrice}¢</div>
                      <div className={`text-sm flex items-center gap-1 ${getTrendColor(pred.trend)}`}>
                        {getTrendIcon(pred.trend)}
                        {pred.priceChange > 0 ? '+' : ''}{pred.priceChange.toFixed(1)}%
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
