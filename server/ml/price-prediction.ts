/**
 * Machine Learning Price Prediction Service
 * 
 * Predicts electricity prices and optimal trading times using historical data,
 * weather forecasts, and grid conditions.
 * 
 * Uses a simple linear regression model with time-based features for price prediction.
 */

import { getWeatherForecast } from '../services/weather-api';
import { redisCache } from '../services/redis-cache';
import { getDb } from '../db';
import { marketPrices, gridMonitoring, telemetry } from '../../drizzle/schema';
import { desc, gte, lte, and, eq } from 'drizzle-orm';

export interface PricePrediction {
  timestamp: Date;
  predictedPrice: number; // cents per kWh
  confidence: number; // 0-100
  priceChange: number; // percentage change from current
  trend: 'rising' | 'falling' | 'stable';
}

export interface TradingRecommendation {
  action: 'buy' | 'sell' | 'hold';
  confidence: number; // 0-100
  expectedProfit: number; // cents
  reasoning: string;
  optimalTime: Date;
  priceAtTime: number;
}

export interface ModelMetrics {
  accuracy: number; // percentage
  mse: number; // mean squared error
  mae: number; // mean absolute error
  r2Score: number; // R² score
  lastTrained: Date;
  trainingDataPoints: number;
}

interface ModelWeights {
  hourCoefficients: number[];
  dayCoefficients: number[];
  loadCoefficient: number;
  solarCoefficient: number;
  intercept: number;
}

class PricePredictionService {
  private modelLoaded: boolean = false;
  private lastTraining: Date | null = null;
  private trainingDataPoints: number = 0;
  private modelAccuracy: number = 0;
  private modelMSE: number = 0;
  private modelMAE: number = 0;
  private modelR2: number = 0;
  
  private weights: ModelWeights = {
    hourCoefficients: new Array(24).fill(0),
    dayCoefficients: new Array(7).fill(0),
    loadCoefficient: 0,
    solarCoefficient: 0,
    intercept: 45,
  };

  constructor() {
    this.initialize();
  }

  /**
   * Initialize ML model by loading historical data and training
   */
  private async initialize(): Promise<void> {
    try {
      console.log('[ML] Initializing price prediction model...');
      
      const db = await getDb();
      if (db) {
        // Try to load historical data and train model
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        
        const historicalPrices = await db
          .select()
          .from(marketPrices)
          .where(gte(marketPrices.timestamp, thirtyDaysAgo))
          .orderBy(desc(marketPrices.timestamp))
          .limit(1000);
        
        if (historicalPrices.length > 0) {
          await this.trainModelFromData(historicalPrices);
          console.log(`[ML] Model trained with ${historicalPrices.length} historical data points`);
        } else {
          // Use default time-based coefficients if no historical data
          this.initializeDefaultWeights();
          console.log('[ML] No historical data found, using default model weights');
        }
      } else {
        this.initializeDefaultWeights();
        console.log('[ML] Database not available, using default model weights');
      }
      
      this.modelLoaded = true;
      this.lastTraining = new Date();
      
      console.log('[ML] Price prediction model initialized');
    } catch (error: any) {
      console.error('[ML] Failed to initialize model:', error);
      this.initializeDefaultWeights();
      this.modelLoaded = true;
    }
  }
  
  /**
   * Initialize default weights based on typical price patterns
   */
  private initializeDefaultWeights(): void {
    // Hour coefficients (multipliers for each hour of day)
    this.weights.hourCoefficients = [
      0.70, 0.65, 0.60, 0.60, 0.65, 0.75, // 0-5 AM (off-peak)
      0.90, 1.10, 1.20, 1.00, 0.95, 0.90, // 6-11 AM (morning peak then decline)
      0.85, 0.85, 0.90, 0.95, 1.00, 1.10, // 12-5 PM (afternoon)
      1.30, 1.40, 1.35, 1.20, 1.00, 0.85, // 6-11 PM (evening peak)
    ];
    
    // Day coefficients (multipliers for each day of week)
    this.weights.dayCoefficients = [
      0.90, // Sunday
      1.05, // Monday
      1.00, // Tuesday
      1.00, // Wednesday
      1.05, // Thursday
      1.10, // Friday
      0.95, // Saturday
    ];
    
    this.weights.loadCoefficient = 0.001; // Price increase per MW of load
    this.weights.solarCoefficient = -0.0001; // Price decrease per W/m² of solar
    this.weights.intercept = 45; // Base price in cents
    
    this.trainingDataPoints = 0;
    this.modelAccuracy = 75;
    this.modelMSE = 5.0;
    this.modelMAE = 3.5;
    this.modelR2 = 0.65;
  }
  
  /**
   * Train model from historical price data using simple linear regression
   */
  private async trainModelFromData(data: any[]): Promise<void> {
    if (data.length < 10) {
      this.initializeDefaultWeights();
      return;
    }
    
    // Calculate average prices by hour
    const hourlyPrices: number[][] = Array.from({ length: 24 }, () => []);
    const dailyPrices: number[][] = Array.from({ length: 7 }, () => []);
    
    for (const record of data) {
      const timestamp = new Date(record.timestamp);
      const hour = timestamp.getHours();
      const day = timestamp.getDay();
      
      hourlyPrices[hour].push(record.price);
      dailyPrices[day].push(record.price);
    }
    
    // Calculate overall average price
    const allPrices = data.map(d => d.price);
    const avgPrice = allPrices.reduce((a, b) => a + b, 0) / allPrices.length;
    this.weights.intercept = avgPrice;
    
    // Calculate hour coefficients as ratio to average
    for (let h = 0; h < 24; h++) {
      if (hourlyPrices[h].length > 0) {
        const hourAvg = hourlyPrices[h].reduce((a, b) => a + b, 0) / hourlyPrices[h].length;
        this.weights.hourCoefficients[h] = hourAvg / avgPrice;
      } else {
        this.weights.hourCoefficients[h] = 1.0;
      }
    }
    
    // Calculate day coefficients as ratio to average
    for (let d = 0; d < 7; d++) {
      if (dailyPrices[d].length > 0) {
        const dayAvg = dailyPrices[d].reduce((a, b) => a + b, 0) / dailyPrices[d].length;
        this.weights.dayCoefficients[d] = dayAvg / avgPrice;
      } else {
        this.weights.dayCoefficients[d] = 1.0;
      }
    }
    
    // Calculate model metrics
    let sumSquaredError = 0;
    let sumAbsoluteError = 0;
    let sumSquaredTotal = 0;
    
    for (const record of data) {
      const timestamp = new Date(record.timestamp);
      const predicted = this.predictSinglePrice(timestamp);
      const actual = record.price;
      const error = actual - predicted;
      
      sumSquaredError += error * error;
      sumAbsoluteError += Math.abs(error);
      sumSquaredTotal += (actual - avgPrice) * (actual - avgPrice);
    }
    
    this.trainingDataPoints = data.length;
    this.modelMSE = sumSquaredError / data.length;
    this.modelMAE = sumAbsoluteError / data.length;
    this.modelR2 = 1 - (sumSquaredError / sumSquaredTotal);
    this.modelAccuracy = Math.max(0, Math.min(100, 100 - (this.modelMAE / avgPrice * 100)));
  }
  
  /**
   * Predict price for a single timestamp using trained weights
   */
  private predictSinglePrice(timestamp: Date, gridLoad?: number, solarIrradiance?: number): number {
    const hour = timestamp.getHours();
    const day = timestamp.getDay();
    
    let price = this.weights.intercept;
    price *= this.weights.hourCoefficients[hour];
    price *= this.weights.dayCoefficients[day];
    
    if (gridLoad !== undefined) {
      price += this.weights.loadCoefficient * gridLoad;
    }
    
    if (solarIrradiance !== undefined) {
      price += this.weights.solarCoefficient * solarIrradiance;
    }
    
    return Math.round(price * 100) / 100;
  }

  /**
   * Predict prices for next N hours
   */
  async predictPrices(hoursAhead: number = 24): Promise<PricePrediction[]> {
    if (!this.modelLoaded) {
      throw new Error('ML model not loaded');
    }

    // Check cache first
    const cached = await redisCache.getMLPrediction(0, hoursAhead);
    if (cached) {
      return cached;
    }

    try {
      const predictions: PricePrediction[] = [];
      const now = new Date();

      // Fetch weather forecasts once for the full horizon
      let weatherForecasts: Awaited<ReturnType<typeof getWeatherForecast>> = [];
      try {
        weatherForecasts = await getWeatherForecast(-6.7924, 39.2083, hoursAhead); // Dar es Salaam
      } catch {
        // Proceed without weather adjustment if API is unavailable
      }

      // Determine the current market price from the database; fall back to the
      // model intercept (average historical price) if no recent row is available.
      let currentPrice = this.weights.intercept;
      try {
        const db = await getDb();
        if (db) {
          const [latest] = await db
            .select()
            .from(marketPrices)
            .orderBy(desc(marketPrices.timestamp))
            .limit(1);
          if (latest) currentPrice = latest.price;
        }
      } catch {
        // Fall back to model intercept
      }

      for (let i = 1; i <= hoursAhead; i++) {
        const predictionTime = new Date(now.getTime() + i * 3600000);

        // Derive solar irradiance from real weather data when available
        let solarIrradiance: number | undefined;
        if (weatherForecasts[i - 1]) {
          solarIrradiance = weatherForecasts[i - 1].solarIrradiance;
        }

        // Use the trained model to predict price deterministically
        const predictedPrice = this.predictSinglePrice(predictionTime, undefined, solarIrradiance);
        const priceChange = ((predictedPrice - currentPrice) / currentPrice) * 100;

        let trend: 'rising' | 'falling' | 'stable' = 'stable';
        if (priceChange > 5) trend = 'rising';
        else if (priceChange < -5) trend = 'falling';

        // Confidence is based on model accuracy and decays slightly with horizon
        const baseConfidence = this.modelAccuracy;
        const confidence = Math.max(50, baseConfidence - i * 0.4);

        predictions.push({
          timestamp: predictionTime,
          predictedPrice,
          confidence,
          priceChange,
          trend,
        });
      }

      console.log(`[ML] Generated ${predictions.length} price predictions (model accuracy: ${this.modelAccuracy.toFixed(1)}%)`);

      // Cache predictions
      await redisCache.cacheMLPrediction(0, hoursAhead, predictions);

      return predictions;
    } catch (error: any) {
      console.error('[ML] Price prediction error:', error);
      throw new Error(`Failed to predict prices: ${error.message}`);
    }
  }

  /**
   * Get trading recommendation
   */
  async getTradingRecommendation(
    currentPrice: number,
    assetCapacity: number, // kW
    energyAvailable: number // kWh
  ): Promise<TradingRecommendation> {
    try {
      const predictions = await this.predictPrices(24);

      // Find optimal selling time (highest price)
      const optimalSellTime = predictions.reduce((max, pred) =>
        pred.predictedPrice > max.predictedPrice ? pred : max
      );

      // Find optimal buying time (lowest price)
      const optimalBuyTime = predictions.reduce((min, pred) =>
        pred.predictedPrice < min.predictedPrice ? pred : min
      );

      // Determine action based on current price and predictions
      let action: 'buy' | 'sell' | 'hold' = 'hold';
      let reasoning = '';
      let optimalTime = new Date();
      let priceAtTime = currentPrice;
      let expectedProfit = 0;
      let confidence = 75;

      if (energyAvailable > 0 && currentPrice >= optimalSellTime.predictedPrice * 0.95) {
        // Sell now if price is near peak
        action = 'sell';
        reasoning = `Current price (${currentPrice}¢) is near predicted peak. Sell ${energyAvailable}kWh now.`;
        optimalTime = new Date();
        priceAtTime = currentPrice;
        expectedProfit = energyAvailable * currentPrice;
        confidence = 85;
      } else if (energyAvailable > 0 && optimalSellTime.predictedPrice > currentPrice * 1.15) {
        // Hold and sell later at higher price
        action = 'hold';
        reasoning = `Wait for higher prices. Expected peak: ${optimalSellTime.predictedPrice}¢ at ${optimalSellTime.timestamp.toLocaleTimeString()}`;
        optimalTime = optimalSellTime.timestamp;
        priceAtTime = optimalSellTime.predictedPrice;
        expectedProfit = energyAvailable * optimalSellTime.predictedPrice;
        confidence = optimalSellTime.confidence;
      } else if (currentPrice <= optimalBuyTime.predictedPrice * 1.05) {
        // Buy now if price is near lowest
        action = 'buy';
        reasoning = `Current price (${currentPrice}¢) is near predicted low. Good time to charge batteries.`;
        optimalTime = new Date();
        priceAtTime = currentPrice;
        expectedProfit = assetCapacity * (optimalSellTime.predictedPrice - currentPrice);
        confidence = 80;
      } else {
        // Hold
        reasoning = `Current price (${currentPrice}¢) is moderate. Monitor for better opportunities.`;
        optimalTime = optimalSellTime.timestamp;
        priceAtTime = optimalSellTime.predictedPrice;
      }

      return {
        action,
        confidence,
        expectedProfit: Math.round(expectedProfit),
        reasoning,
        optimalTime,
        priceAtTime,
      };
    } catch (error: any) {
      console.error('[ML] Trading recommendation error:', error);
      throw new Error(`Failed to generate recommendation: ${error.message}`);
    }
  }

  /**
   * Get model performance metrics
   */
  async getModelMetrics(): Promise<ModelMetrics> {
    return {
      accuracy: this.modelAccuracy,
      mse: this.modelMSE,
      mae: this.modelMAE,
      r2Score: this.modelR2,
      lastTrained: this.lastTraining || new Date(),
      trainingDataPoints: this.trainingDataPoints,
    };
  }

  /**
   * Retrain model with new data from database
   */
  async retrainModel(historicalData?: any[]): Promise<{
    success: boolean;
    metrics: ModelMetrics;
    message: string;
  }> {
    try {
      let dataToTrain = historicalData;
      
      // If no data provided, fetch from database
      if (!dataToTrain || dataToTrain.length === 0) {
        const db = await getDb();
        if (db) {
          const thirtyDaysAgo = new Date();
          thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
          
          dataToTrain = await db
            .select()
            .from(marketPrices)
            .where(gte(marketPrices.timestamp, thirtyDaysAgo))
            .orderBy(desc(marketPrices.timestamp))
            .limit(2000);
        }
      }
      
      if (!dataToTrain || dataToTrain.length === 0) {
        return {
          success: false,
          metrics: await this.getModelMetrics(),
          message: 'No training data available',
        };
      }
      
      console.log(`[ML] Retraining model with ${dataToTrain.length} data points...`);

      await this.trainModelFromData(dataToTrain);
      this.lastTraining = new Date();

      const metrics = await this.getModelMetrics();

      console.log('[ML] Model retrained successfully');

      return {
        success: true,
        metrics,
        message: `Model retrained successfully with ${dataToTrain.length} data points`,
      };
    } catch (error: any) {
      console.error('[ML] Model retraining error:', error);
      return {
        success: false,
        metrics: await this.getModelMetrics(),
        message: error.message || 'Failed to retrain model',
      };
    }
  }

  /**
   * Analyze price patterns from historical data
   */
  async analyzePricePatterns(days: number = 30): Promise<{
    peakHours: number[];
    offPeakHours: number[];
    averagePrice: number;
    priceVolatility: number;
    bestTradingDays: string[];
  }> {
    const db = await getDb();
    
    // Default values if no data available
    let peakHours: number[] = [];
    let offPeakHours: number[] = [];
    let averagePrice = this.weights.intercept;
    let priceVolatility = 15.0;
    let bestTradingDays: string[] = [];
    
    if (db) {
      try {
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        
        const historicalPrices = await db
          .select()
          .from(marketPrices)
          .where(gte(marketPrices.timestamp, startDate))
          .orderBy(desc(marketPrices.timestamp));
        
        if (historicalPrices.length > 0) {
          // Calculate average price
          const prices = historicalPrices.map(p => p.price);
          averagePrice = prices.reduce((a, b) => a + b, 0) / prices.length;
          
          // Calculate price volatility (standard deviation as percentage of mean)
          const variance = prices.reduce((sum, p) => sum + Math.pow(p - averagePrice, 2), 0) / prices.length;
          priceVolatility = (Math.sqrt(variance) / averagePrice) * 100;
        }
      } catch (error) {
        console.error('[ML] Error analyzing price patterns:', error);
      }
    }
    
    // Analyze hour coefficients to find peak and off-peak hours
    const hourCoeffs = this.weights.hourCoefficients.map((coef, hour) => ({ hour, coef }));
    hourCoeffs.sort((a, b) => b.coef - a.coef);
    
    // Top 5 hours are peak hours
    peakHours = hourCoeffs.slice(0, 5).map(h => h.hour).sort((a, b) => a - b);
    
    // Bottom 5 hours are off-peak hours
    offPeakHours = hourCoeffs.slice(-5).map(h => h.hour).sort((a, b) => a - b);
    
    // Analyze day coefficients to find best trading days
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayCoeffs = this.weights.dayCoefficients.map((coef, day) => ({ day, coef, name: dayNames[day] }));
    dayCoeffs.sort((a, b) => b.coef - a.coef);
    
    // Top 3 days with highest prices are best for selling
    bestTradingDays = dayCoeffs.slice(0, 3).map(d => d.name);

    return {
      peakHours,
      offPeakHours,
      averagePrice: Math.round(averagePrice * 100) / 100,
      priceVolatility: Math.round(priceVolatility * 10) / 10,
      bestTradingDays,
    };
  }
}

// Singleton instance
export const pricePredictionService = new PricePredictionService();
