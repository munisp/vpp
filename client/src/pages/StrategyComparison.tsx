import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { ArrowLeft, TrendingUp, Target, Zap, DollarSign, Award, BarChart3 } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { useLocation } from "wouter";

export default function StrategyComparison() {
  const [, setLocation] = useLocation();
  const [selectedStrategies, setSelectedStrategies] = useState<number[]>([]);
  const [recommendGoal, setRecommendGoal] = useState<"max_profit" | "max_trades" | "max_success_rate" | "balanced">("balanced");

  const { data: allStrategies } = trpc.tradingStrategies.list.useQuery();
  const { data: comparison, isLoading } = trpc.strategyComparison.compare.useQuery(
    { strategyIds: selectedStrategies },
    { enabled: selectedStrategies.length >= 2 }
  );
  const { data: recommendation } = trpc.strategyComparison.recommend.useQuery(
    { goal: recommendGoal, strategyIds: selectedStrategies },
    { enabled: selectedStrategies.length >= 2 }
  );

  const handleToggleStrategy = (id: number) => {
    if (selectedStrategies.includes(id)) {
      setSelectedStrategies(selectedStrategies.filter((s) => s !== id));
    } else {
      if (selectedStrategies.length >= 5) {
        toast.error("You can compare up to 5 strategies at a time");
        return;
      }
      setSelectedStrategies([...selectedStrategies, id]);
    }
  };

  const getRankBadge = (strategyId: number, rankingArray: number[]) => {
    const rank = rankingArray.indexOf(strategyId) + 1;
    if (rank === 1) return <Badge className="bg-yellow-500">🥇 1st</Badge>;
    if (rank === 2) return <Badge className="bg-gray-400">🥈 2nd</Badge>;
    if (rank === 3) return <Badge className="bg-orange-600">🥉 3rd</Badge>;
    return <Badge variant="outline">#{rank}</Badge>;
  };

  return (
    <DashboardLayout>
      <div className="container mx-auto py-8">
        <div className="flex items-center gap-4 mb-8">
          <Button variant="ghost" size="icon" onClick={() => setLocation("/trading/strategies")}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-3xl font-bold flex items-center gap-2">
              <BarChart3 className="h-8 w-8 text-primary" />
              Strategy Comparison
            </h1>
            <p className="text-muted-foreground mt-2">
              Compare performance metrics across your trading strategies
            </p>
          </div>
        </div>

        {/* Strategy Selection */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Select Strategies to Compare (2-5)</CardTitle>
            <CardDescription>
              Choose at least 2 strategies to see side-by-side comparison
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {allStrategies?.map((strategy) => (
                <div
                  key={strategy.id}
                  className={`p-4 border rounded-lg cursor-pointer transition-colors ${
                    selectedStrategies.includes(strategy.id)
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50"
                  }`}
                  onClick={() => handleToggleStrategy(strategy.id)}
                >
                  <div className="flex items-start gap-3">
                    <Checkbox
                      checked={selectedStrategies.includes(strategy.id)}
                      onCheckedChange={() => handleToggleStrategy(strategy.id)}
                    />
                    <div className="flex-1">
                      <div className="font-medium">{strategy.name}</div>
                      <div className="text-sm text-muted-foreground">
                        {strategy.isActive ? (
                          <Badge variant="default" className="bg-green-500 text-xs">Active</Badge>
                        ) : (
                          <Badge variant="secondary" className="text-xs">Inactive</Badge>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Comparison Results */}
        {selectedStrategies.length < 2 && (
          <Card>
            <CardContent className="py-12 text-center">
              <BarChart3 className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">Select strategies to compare</h3>
              <p className="text-muted-foreground">
                Choose at least 2 strategies from the list above to see detailed comparison
              </p>
            </CardContent>
          </Card>
        )}

        {selectedStrategies.length >= 2 && comparison && (
          <>
            {/* Summary Stats */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
              <Card>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold text-primary">
                    {comparison.summary.totalProfit.toLocaleString()} TZS
                  </div>
                  <div className="text-sm text-muted-foreground">Combined Profit</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold text-primary">
                    {comparison.summary.totalTrades}
                  </div>
                  <div className="text-sm text-muted-foreground">Total Trades</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold text-primary">
                    {comparison.summary.avgSuccessRate}%
                  </div>
                  <div className="text-sm text-muted-foreground">Avg Success Rate</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold text-primary">
                    {comparison.summary.totalEnergy.toFixed(1)} kWh
                  </div>
                  <div className="text-sm text-muted-foreground">Total Energy</div>
                </CardContent>
              </Card>
            </div>

            {/* Recommendation */}
            {recommendation?.recommended && (
              <Card className="mb-6 border-primary">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Award className="h-5 w-5 text-primary" />
                      <CardTitle>Recommended Strategy</CardTitle>
                    </div>
                    <Select value={recommendGoal} onValueChange={(value: any) => setRecommendGoal(value)}>
                      <SelectTrigger className="w-[200px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="max_profit">Max Profit</SelectItem>
                        <SelectItem value="max_trades">Most Active</SelectItem>
                        <SelectItem value="max_success_rate">Best Success Rate</SelectItem>
                        <SelectItem value="balanced">Balanced</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xl font-bold">{recommendation.recommended.name}</div>
                      <div className="text-sm text-muted-foreground mt-1">{recommendation.reason}</div>
                    </div>
                    <Badge className="bg-green-500 text-lg px-4 py-2">
                      Score: {recommendation.recommended.score}
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Detailed Comparison Table */}
            <Card>
              <CardHeader>
                <CardTitle>Performance Comparison</CardTitle>
                <CardDescription>
                  Side-by-side metrics for selected strategies
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left p-3 font-semibold">Metric</th>
                        {comparison.strategies.map((strategy) => (
                          <th key={strategy.id} className="text-left p-3 font-semibold">
                            <div>{strategy.name}</div>
                            <div className="text-xs font-normal text-muted-foreground">
                              {strategy.isActive ? "Active" : "Inactive"}
                            </div>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b">
                        <td className="p-3 font-medium">
                          <div className="flex items-center gap-2">
                            <DollarSign className="h-4 w-4 text-muted-foreground" />
                            Total Profit
                          </div>
                        </td>
                        {comparison.strategies.map((strategy) => (
                          <td key={strategy.id} className="p-3">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{strategy.totalProfit.toLocaleString()} TZS</span>
                              {getRankBadge(strategy.id, comparison.rankings.byProfit)}
                            </div>
                          </td>
                        ))}
                      </tr>

                      <tr className="border-b">
                        <td className="p-3 font-medium">
                          <div className="flex items-center gap-2">
                            <Target className="h-4 w-4 text-muted-foreground" />
                            Success Rate
                          </div>
                        </td>
                        {comparison.strategies.map((strategy) => (
                          <td key={strategy.id} className="p-3">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{strategy.successRate}%</span>
                              {getRankBadge(strategy.id, comparison.rankings.bySuccessRate)}
                            </div>
                          </td>
                        ))}
                      </tr>

                      <tr className="border-b">
                        <td className="p-3 font-medium">
                          <div className="flex items-center gap-2">
                            <TrendingUp className="h-4 w-4 text-muted-foreground" />
                            Total Trades
                          </div>
                        </td>
                        {comparison.strategies.map((strategy) => (
                          <td key={strategy.id} className="p-3">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{strategy.totalTrades}</span>
                              {getRankBadge(strategy.id, comparison.rankings.byTrades)}
                            </div>
                          </td>
                        ))}
                      </tr>

                      <tr className="border-b">
                        <td className="p-3 font-medium">
                          <div className="flex items-center gap-2">
                            <Zap className="h-4 w-4 text-muted-foreground" />
                            Energy Traded
                          </div>
                        </td>
                        {comparison.strategies.map((strategy) => (
                          <td key={strategy.id} className="p-3">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{strategy.totalEnergyTraded.toFixed(1)} kWh</span>
                              {getRankBadge(strategy.id, comparison.rankings.byEnergy)}
                            </div>
                          </td>
                        ))}
                      </tr>

                      <tr className="border-b">
                        <td className="p-3 font-medium">Profit per Trade</td>
                        {comparison.strategies.map((strategy) => (
                          <td key={strategy.id} className="p-3 font-medium">
                            {strategy.profitPerTrade} TZS
                          </td>
                        ))}
                      </tr>

                      <tr className="border-b">
                        <td className="p-3 font-medium">Energy per Trade</td>
                        {comparison.strategies.map((strategy) => (
                          <td key={strategy.id} className="p-3 font-medium">
                            {strategy.energyPerTrade} kWh
                          </td>
                        ))}
                      </tr>

                      <tr className="border-b">
                        <td className="p-3 font-medium">Successful Trades</td>
                        {comparison.strategies.map((strategy) => (
                          <td key={strategy.id} className="p-3">
                            {strategy.successfulTrades} / {strategy.totalTrades}
                          </td>
                        ))}
                      </tr>

                      <tr>
                        <td className="p-3 font-medium">Trading Mode</td>
                        {comparison.strategies.map((strategy) => (
                          <td key={strategy.id} className="p-3">
                            <Badge variant="outline">{strategy.tradingMode}</Badge>
                          </td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
