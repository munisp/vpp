import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { tradingStrategies } from "../../drizzle/schema";
import { inArray } from "drizzle-orm";

export const strategyComparisonRouter = router({
  /**
   * Compare multiple strategies by their IDs
   */
  compare: protectedProcedure
    .input(z.object({ strategyIds: z.array(z.number()).min(2).max(5) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Fetch strategies
      const strategies = await db
        .select()
        .from(tradingStrategies)
        .where(inArray(tradingStrategies.id, input.strategyIds));

      // Filter to only user's strategies
      const userStrategies = strategies.filter((s) => s.userId === ctx.user.id);

      if (userStrategies.length === 0) {
        throw new Error("No strategies found");
      }

      // Calculate comparison metrics
      const comparison = userStrategies.map((strategy) => {
        const metrics = strategy.performanceMetrics as any || {};
        const backtest = strategy.backtestResults as any || {};

        return {
          id: strategy.id,
          name: strategy.name,
          description: strategy.description,
          isActive: strategy.isActive,
          tradingMode: strategy.tradingMode,
          priority: strategy.priority,
          
          // Performance metrics
          totalTrades: metrics.totalTrades || 0,
          successfulTrades: metrics.successfulTrades || 0,
          failedTrades: metrics.failedTrades || 0,
          successRate: metrics.totalTrades > 0 
            ? ((metrics.successfulTrades || 0) / metrics.totalTrades * 100).toFixed(1)
            : "0.0",
          totalProfit: metrics.totalProfit || 0,
          totalEnergyTraded: metrics.totalEnergyTraded || 0,
          averagePrice: metrics.averagePrice || 0,
          lastExecutedAt: metrics.lastExecutedAt,
          
          // Backtest results
          backtestPeriod: backtest.period,
          backtestTrades: backtest.simulatedTrades || 0,
          backtestProfit: backtest.projectedProfit || 0,
          backtestEnergy: backtest.projectedEnergyTraded || 0,
          backtestSuccessRate: backtest.successRate || 0,
          
          // Calculated metrics
          profitPerTrade: metrics.totalTrades > 0
            ? ((metrics.totalProfit || 0) / metrics.totalTrades).toFixed(2)
            : "0.00",
          energyPerTrade: metrics.totalTrades > 0
            ? ((metrics.totalEnergyTraded || 0) / metrics.totalTrades).toFixed(2)
            : "0.00",
        };
      });

      // Calculate rankings
      const rankings = {
        byProfit: [...comparison].sort((a, b) => b.totalProfit - a.totalProfit).map(s => s.id),
        bySuccessRate: [...comparison].sort((a, b) => parseFloat(b.successRate) - parseFloat(a.successRate)).map(s => s.id),
        byTrades: [...comparison].sort((a, b) => b.totalTrades - a.totalTrades).map(s => s.id),
        byEnergy: [...comparison].sort((a, b) => b.totalEnergyTraded - a.totalEnergyTraded).map(s => s.id),
      };

      return {
        strategies: comparison,
        rankings,
        summary: {
          totalStrategies: comparison.length,
          activeStrategies: comparison.filter(s => s.isActive).length,
          totalProfit: comparison.reduce((sum, s) => sum + s.totalProfit, 0),
          totalTrades: comparison.reduce((sum, s) => sum + s.totalTrades, 0),
          totalEnergy: comparison.reduce((sum, s) => sum + s.totalEnergyTraded, 0),
          avgSuccessRate: (comparison.reduce((sum, s) => sum + parseFloat(s.successRate), 0) / comparison.length).toFixed(1),
        },
      };
    }),

  /**
   * Get recommended strategy based on user goals
   */
  recommend: protectedProcedure
    .input(z.object({ 
      goal: z.enum(["max_profit", "max_trades", "max_success_rate", "balanced"]),
      strategyIds: z.array(z.number()).optional(),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Fetch user's strategies
      let query = db.select().from(tradingStrategies).where(
        inArray(tradingStrategies.userId, [ctx.user.id])
      );

      // Filter by specific strategies if provided
      if (input.strategyIds && input.strategyIds.length > 0) {
        const strategies = await db
          .select()
          .from(tradingStrategies)
          .where(inArray(tradingStrategies.id, input.strategyIds));
        
        const userStrategies = strategies.filter(s => s.userId === ctx.user.id);
        
        if (userStrategies.length === 0) {
          return { recommended: null, reason: "No strategies found" };
        }

        // Score strategies based on goal
        const scored = userStrategies.map((strategy) => {
          const metrics = strategy.performanceMetrics as any || {};
          let score = 0;

          switch (input.goal) {
            case "max_profit":
              score = metrics.totalProfit || 0;
              break;
            case "max_trades":
              score = metrics.totalTrades || 0;
              break;
            case "max_success_rate":
              score = metrics.totalTrades > 0 
                ? ((metrics.successfulTrades || 0) / metrics.totalTrades * 100)
                : 0;
              break;
            case "balanced":
              // Balanced score: profit * success_rate * trades
              const profit = metrics.totalProfit || 0;
              const successRate = metrics.totalTrades > 0 
                ? ((metrics.successfulTrades || 0) / metrics.totalTrades)
                : 0;
              const trades = metrics.totalTrades || 0;
              score = profit * successRate * Math.log(trades + 1);
              break;
          }

          return { strategy, score };
        });

        const best = scored.sort((a, b) => b.score - a.score)[0];

        return {
          recommended: {
            id: best.strategy.id,
            name: best.strategy.name,
            description: best.strategy.description,
            score: best.score.toFixed(2),
          },
          reason: getRecommendationReason(input.goal, best.strategy.performanceMetrics as any),
        };
      }

      return { recommended: null, reason: "No strategies to compare" };
    }),
});

function getRecommendationReason(goal: string, metrics: any): string {
  const profit = metrics?.totalProfit || 0;
  const trades = metrics?.totalTrades || 0;
  const successRate = trades > 0 
    ? ((metrics?.successfulTrades || 0) / trades * 100).toFixed(1)
    : "0.0";

  switch (goal) {
    case "max_profit":
      return `Highest total profit of ${profit} TZS with ${trades} trades`;
    case "max_trades":
      return `Most active strategy with ${trades} total trades`;
    case "max_success_rate":
      return `Best success rate of ${successRate}% across ${trades} trades`;
    case "balanced":
      return `Best balance of profit (${profit} TZS), success rate (${successRate}%), and activity (${trades} trades)`;
    default:
      return "Recommended based on overall performance";
  }
}
