import { z } from 'zod';
import { protectedProcedure, router } from '../_core/trpc';
import { pricePredictionService } from '../ml/price-prediction';
import { getDb } from '../db';
import { assets, marketPrices } from '../../drizzle/schema';
import { and, desc, eq, gte, sql } from 'drizzle-orm';

export const mlPredictionsRouter = router({
  /**
   * Get price predictions for next N hours
   */
  getPricePredictions: protectedProcedure
    .input(z.object({
      hoursAhead: z.number().min(1).max(168).default(24),
    }).optional())
    .query(async ({ input }) => {
      // Empty array = model untrained (insufficient data); never fabricated
      // intercept-based predictions. Callers can check getModelMetrics.trained.
      const predictions = await pricePredictionService.predictPrices(input?.hoursAhead || 24);
      return predictions;
    }),

  /**
   * Get trading recommendation for specific asset
   */
  getTradingRecommendation: protectedProcedure
    .input(z.object({
      assetId: z.number(),
      currentPrice: z.number(),
      energyAvailable: z.number(),
    }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) {
        throw new Error('Database not available');
      }

      // Get asset details
      const asset = await db
        .select()
        .from(assets)
        .where(eq(assets.id, input.assetId))
        .limit(1);

      if (asset.length === 0) {
        throw new Error('Asset not found');
      }

      // Verify ownership
      if (asset[0].userId !== ctx.user.id) {
        throw new Error('Unauthorized');
      }

      const recommendation = await pricePredictionService.getTradingRecommendation(
        input.currentPrice,
        asset[0].capacity,
        input.energyAvailable
      );

      return recommendation;
    }),

  /**
   * Get model performance metrics
   */
  getModelMetrics: protectedProcedure
    .query(async () => {
      const metrics = await pricePredictionService.getModelMetrics();
      return metrics;
    }),

  /**
   * Analyze price patterns
   */
  analyzePricePatterns: protectedProcedure
    .input(z.object({
      days: z.number().min(1).max(365).default(30),
    }).optional())
    .query(async ({ input }) => {
      const analysis = await pricePredictionService.analyzePricePatterns(input?.days || 30);
      return analysis;
    }),

  /**
   * Get optimal trading times for today
   */
  getOptimalTradingTimes: protectedProcedure
    .query(async () => {
      const predictions = await pricePredictionService.predictPrices(24);

      // Find best times to buy (lowest prices)
      const sortedByPrice = [...predictions].sort((a, b) => a.predictedPrice - b.predictedPrice);
      const bestBuyTimes = sortedByPrice.slice(0, 3).map(p => ({
        time: p.timestamp,
        price: p.predictedPrice,
        confidence: p.confidence,
        action: 'buy' as const,
      }));

      // Find best times to sell (highest prices)
      const bestSellTimes = sortedByPrice.slice(-3).reverse().map(p => ({
        time: p.timestamp,
        price: p.predictedPrice,
        confidence: p.confidence,
        action: 'sell' as const,
      }));

      return {
        bestBuyTimes,
        bestSellTimes,
        recommendations: [
          ...bestBuyTimes.map(t => ({
            ...t,
            reasoning: `Low price period - good time to charge batteries at ${t.price}¢/kWh`,
          })),
          ...bestSellTimes.map(t => ({
            ...t,
            reasoning: `Peak price period - optimal time to sell energy at ${t.price}¢/kWh`,
          })),
        ],
      };
    }),

  /**
   * Get price forecast with confidence intervals
   */
  getPriceForecast: protectedProcedure
    .input(z.object({
      hoursAhead: z.number().min(1).max(168).default(48),
    }).optional())
    .query(async ({ input }) => {
      const predictions = await pricePredictionService.predictPrices(input?.hoursAhead || 48);

      // Calculate confidence intervals
      // A prediction without a measured confidence has no interval; the bounds
      // are reported as null rather than computed from a missing value.
      const forecast = predictions.map(pred => ({
        timestamp: pred.timestamp,
        predictedPrice: pred.predictedPrice,
        confidence: pred.confidence,
        lowerBound:
          pred.confidence === null
            ? null
            : Math.round(pred.predictedPrice * (1 - (100 - pred.confidence) / 200)),
        upperBound:
          pred.confidence === null
            ? null
            : Math.round(pred.predictedPrice * (1 + (100 - pred.confidence) / 200)),
        trend: pred.trend,
      }));

      return forecast;
    }),

  /**
   * Get personalized trading insights
   */
  getPersonalizedInsights: protectedProcedure
    .query(async ({ ctx }) => {
      const db = await getDb();
      if (!db) {
        throw new Error('Database not available');
      }

      // Get user's assets
      const userAssets = await db
        .select()
        .from(assets)
        .where(eq(assets.userId, ctx.user.id));

      if (userAssets.length === 0) {
        return {
          insights: [],
          totalPotentialRevenue: 0,
          recommendedActions: [],
        };
      }

      const predictions = await pricePredictionService.predictPrices(24);
      const analysis = await pricePredictionService.analyzePricePatterns(30);

      // Calculate total capacity
      const totalCapacity = userAssets.reduce((sum, asset) => sum + asset.capacity, 0);

      // Find peak price — null when the model returned no predictions
      // (untrained / insufficient data), never -Infinity from Math.max(...[]).
      const peakPrice = predictions.length > 0
        ? Math.max(...predictions.map(p => p.predictedPrice))
        : null;

      // Latest real market price from the marketPrices table. If no market
      // price has been recorded yet, omit the revenue opportunity insight
      // rather than fabricating a price.
      const latestPriceRows = await db
        .select()
        .from(marketPrices)
        .where(eq(marketPrices.country, ctx.user.country))
        .orderBy(desc(marketPrices.timestamp))
        .limit(1);
      const currentPrice = latestPriceRows.length > 0 ? latestPriceRows[0].price : null;

      // Real off-peak vs peak price averages from recorded market prices for
      // the user's own country (never a hardcoded region) over the last 30
      // days. Either average missing = insufficient real data, and the
      // off-peak charging action is omitted entirely rather than dressed up
      // with a fabricated capacity×0.15 "TZS/day" figure.
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const bandAverages = await db
        .select({
          priceType: marketPrices.priceType,
          avgPrice: sql<number>`AVG(${marketPrices.price})`,
        })
        .from(marketPrices)
        .where(and(
          eq(marketPrices.country, ctx.user.country),
          gte(marketPrices.timestamp, thirtyDaysAgo),
        ))
        .groupBy(marketPrices.priceType);
      const avgOffPeakPrice = bandAverages.find(r => r.priceType === 'off_peak')?.avgPrice ?? null;
      const avgPeakPrice = bandAverages.find(r => r.priceType === 'peak')?.avgPrice ?? null;

      // Calculate potential revenue (only when a real current price AND a
      // real model peak price exist)
      const totalPotentialRevenue = currentPrice !== null && peakPrice !== null
        ? totalCapacity * (peakPrice - currentPrice) / 100
        : 0;

      const insights = [
        ...(currentPrice !== null && peakPrice !== null
          ? [{
              type: 'opportunity',
              message: `Peak price expected at ${peakPrice}¢/kWh today. Potential revenue: ${totalPotentialRevenue.toFixed(2)} TZS`,
              priority: 'high',
            }]
          : []),
        // Only surface trading-day patterns when they come from a trained
        // model — an untrained model's day coefficients are placeholders and
        // must never reach the user as "Best trading days: ...".
        ...(analysis.trained && analysis.bestTradingDays.length > 0
          ? [{
              type: 'pattern',
              message: `Best trading days: ${analysis.bestTradingDays.join(', ')}`,
              priority: 'medium',
            }]
          : []),
        // Only report volatility when it was computed from real history.
        ...(analysis.priceVolatility !== null
          ? [{
              type: 'optimization',
              message: `Average price volatility: ${analysis.priceVolatility}%. Consider automated trading.`,
              priority: 'low',
            }]
          : []),
      ];

      const recommendedActions = [
        ...(currentPrice !== null && peakPrice !== null
          ? [{
              action: 'Enable automated trading during peak hours',
              expectedBenefit: `+${(totalPotentialRevenue * 0.8).toFixed(2)} TZS/day`,
            }]
          : []),
        // Only recommend off-peak charging when real recorded market prices
        // quantify the off-peak/peak spread; otherwise omit the action.
        ...(avgOffPeakPrice !== null && avgPeakPrice !== null
          ? [{
              action: 'Charge batteries during off-peak hours',
              expectedBenefit: `Off-peak prices average ${(Number(avgOffPeakPrice)).toFixed(2)}¢/kWh vs ${(Number(avgPeakPrice)).toFixed(2)}¢/kWh peak over the last 30 days`,
            }]
          : []),
      ];

      return {
        insights,
        totalPotentialRevenue: Math.round(totalPotentialRevenue * 100) / 100,
        recommendedActions,
      };
    }),
});
