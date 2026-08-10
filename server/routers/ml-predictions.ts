import { z } from 'zod';
import { protectedProcedure, router } from '../_core/trpc';
import { pricePredictionService } from '../ml/price-prediction';
import { getDb } from '../db';
import { assets, marketPrices } from '../../drizzle/schema';
import { desc, eq } from 'drizzle-orm';

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
      const forecast = predictions.map(pred => ({
        timestamp: pred.timestamp,
        predictedPrice: pred.predictedPrice,
        confidence: pred.confidence,
        lowerBound: Math.round(pred.predictedPrice * (1 - (100 - pred.confidence) / 200)),
        upperBound: Math.round(pred.predictedPrice * (1 + (100 - pred.confidence) / 200)),
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
        .orderBy(desc(marketPrices.timestamp))
        .limit(1);
      const currentPrice = latestPriceRows.length > 0 ? latestPriceRows[0].price : null;

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
        {
          type: 'pattern',
          message: `Best trading days: ${analysis.bestTradingDays.join(', ')}`,
          priority: 'medium',
        },
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
        {
          action: 'Charge batteries during off-peak hours (midnight-5 AM)',
          expectedBenefit: `Save ${(totalCapacity * 0.15).toFixed(2)} TZS/day`,
        },
      ];

      return {
        insights,
        totalPotentialRevenue: Math.round(totalPotentialRevenue * 100) / 100,
        recommendedActions,
      };
    }),
});
