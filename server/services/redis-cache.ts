/**
 * Redis Caching Service
 * 
 * Provides distributed caching layer for weather forecasts, ML predictions,
 * market prices, and user data with automatic TTL management
 */

import Redis from 'ioredis';
import { ENV } from '../_core/env';

interface CacheConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
  keyPrefix?: string;
}

interface CacheOptions {
  ttl?: number; // Time to live in seconds
  compress?: boolean;
}

class RedisCacheService {
  private client: Redis | null = null;
  private isConnected = false;

  // Default TTLs for different data types
  private readonly DEFAULT_TTLS = {
    weatherForecast: 3600, // 1 hour
    mlPrediction: 1800, // 30 minutes
    marketPrice: 300, // 5 minutes
    userProfile: 600, // 10 minutes
    gridStatus: 60, // 1 minute
    drEvent: 1800, // 30 minutes
  };

  constructor(config?: CacheConfig) {
    const redisConfig: CacheConfig = config || {
      host: ENV.redisHost,
      port: ENV.redisPort,
      password: ENV.redisPassword,
      db: ENV.redisDb,
      keyPrefix: 'vpp:',
    };

    try {
      this.client = new Redis({
        host: redisConfig.host,
        port: redisConfig.port,
        password: redisConfig.password,
        db: redisConfig.db,
        keyPrefix: redisConfig.keyPrefix,
        retryStrategy: (times) => {
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
        maxRetriesPerRequest: 3,
      });

      this.client.on('connect', () => {
        console.log('[Redis] Connected successfully');
        this.isConnected = true;
      });

      this.client.on('error', (err) => {
        console.error('[Redis] Connection error:', err.message);
        this.isConnected = false;
      });

      this.client.on('close', () => {
        console.log('[Redis] Connection closed');
        this.isConnected = false;
      });
    } catch (error) {
      console.error('[Redis] Failed to initialize:', error);
      this.client = null;
    }
  }

  /**
   * Get value from cache
   */
  async get<T>(key: string): Promise<T | null> {
    if (!this.client || !this.isConnected) {
      return null;
    }

    try {
      const value = await this.client.get(key);
      if (!value) {
        return null;
      }

      return JSON.parse(value) as T;
    } catch (error) {
      console.error(`[Redis] Get error for key ${key}:`, error);
      return null;
    }
  }

  /**
   * Set value in cache with optional TTL
   */
  async set<T>(key: string, value: T, options?: CacheOptions): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      return false;
    }

    try {
      const serialized = JSON.stringify(value);
      const ttl = options?.ttl;

      if (ttl) {
        await this.client.setex(key, ttl, serialized);
      } else {
        await this.client.set(key, serialized);
      }

      return true;
    } catch (error) {
      console.error(`[Redis] Set error for key ${key}:`, error);
      return false;
    }
  }

  /**
   * Delete value from cache
   */
  async del(key: string): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      return false;
    }

    try {
      await this.client.del(key);
      return true;
    } catch (error) {
      console.error(`[Redis] Delete error for key ${key}:`, error);
      return false;
    }
  }

  /**
   * Delete multiple keys matching pattern
   */
  async delPattern(pattern: string): Promise<number> {
    if (!this.client || !this.isConnected) {
      return 0;
    }

    try {
      const keys = await this.client.keys(pattern);
      if (keys.length === 0) {
        return 0;
      }

      await this.client.del(...keys);
      return keys.length;
    } catch (error) {
      console.error(`[Redis] Delete pattern error for ${pattern}:`, error);
      return 0;
    }
  }

  /**
   * Check if key exists
   */
  async exists(key: string): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      return false;
    }

    try {
      const result = await this.client.exists(key);
      return result === 1;
    } catch (error) {
      console.error(`[Redis] Exists error for key ${key}:`, error);
      return false;
    }
  }

  /**
   * Get TTL for key
   */
  async ttl(key: string): Promise<number> {
    if (!this.client || !this.isConnected) {
      return -2;
    }

    try {
      return await this.client.ttl(key);
    } catch (error) {
      console.error(`[Redis] TTL error for key ${key}:`, error);
      return -2;
    }
  }

  /**
   * Cache weather forecast
   */
  async cacheWeatherForecast(lat: number, lon: number, data: any): Promise<boolean> {
    const key = `weather:${lat}:${lon}`;
    return this.set(key, data, { ttl: this.DEFAULT_TTLS.weatherForecast });
  }

  /**
   * Get cached weather forecast
   */
  async getWeatherForecast(lat: number, lon: number): Promise<any | null> {
    const key = `weather:${lat}:${lon}`;
    return this.get(key);
  }

  /**
   * Cache ML prediction
   */
  async cacheMLPrediction(userId: number, hoursAhead: number, data: any): Promise<boolean> {
    const key = `ml:prediction:${userId}:${hoursAhead}`;
    return this.set(key, data, { ttl: this.DEFAULT_TTLS.mlPrediction });
  }

  /**
   * Get cached ML prediction
   */
  async getMLPrediction(userId: number, hoursAhead: number): Promise<any | null> {
    const key = `ml:prediction:${userId}:${hoursAhead}`;
    return this.get(key);
  }

  /**
   * Cache market price
   */
  async cacheMarketPrice(data: any): Promise<boolean> {
    const key = 'market:price:current';
    return this.set(key, data, { ttl: this.DEFAULT_TTLS.marketPrice });
  }

  /**
   * Get cached market price
   */
  async getMarketPrice(): Promise<any | null> {
    const key = 'market:price:current';
    return this.get(key);
  }

  /**
   * Drop the cached price list. Writers must call this: otherwise a price an
   * operator has just set is not the price the platform reports as current.
   */
  async invalidateMarketPrice(): Promise<boolean> {
    return this.del('market:price:current');
  }

  /**
   * Cache user profile
   */
  async cacheUserProfile(userId: number, data: any): Promise<boolean> {
    const key = `user:profile:${userId}`;
    return this.set(key, data, { ttl: this.DEFAULT_TTLS.userProfile });
  }

  /**
   * Get cached user profile
   */
  async getUserProfile(userId: number): Promise<any | null> {
    const key = `user:profile:${userId}`;
    return this.get(key);
  }

  /**
   * Invalidate user profile cache
   */
  async invalidateUserProfile(userId: number): Promise<boolean> {
    const key = `user:profile:${userId}`;
    return this.del(key);
  }

  /**
   * Cache grid status
   */
  async cacheGridStatus(data: any): Promise<boolean> {
    const key = 'grid:status:current';
    return this.set(key, data, { ttl: this.DEFAULT_TTLS.gridStatus });
  }

  /**
   * Get cached grid status
   */
  async getGridStatus(): Promise<any | null> {
    const key = 'grid:status:current';
    return this.get(key);
  }

  /**
   * Cache DR event
   */
  async cacheDREvent(eventId: number, data: any): Promise<boolean> {
    const key = `dr:event:${eventId}`;
    return this.set(key, data, { ttl: this.DEFAULT_TTLS.drEvent });
  }

  /**
   * Get cached DR event
   */
  async getDREvent(eventId: number): Promise<any | null> {
    const key = `dr:event:${eventId}`;
    return this.get(key);
  }

  /**
   * Invalidate DR event cache
   */
  async invalidateDREvent(eventId: number): Promise<boolean> {
    const key = `dr:event:${eventId}`;
    return this.del(key);
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{
    connected: boolean;
    dbSize: number;
    usedMemory: string;
    hitRate: number;
  }> {
    if (!this.client || !this.isConnected) {
      return {
        connected: false,
        dbSize: 0,
        usedMemory: '0',
        hitRate: 0,
      };
    }

    try {
      const info = await this.client.info('stats');
      const memory = await this.client.info('memory');
      const dbSize = await this.client.dbsize();

      // Parse hit rate from stats
      const hitsMatch = info.match(/keyspace_hits:(\d+)/);
      const missesMatch = info.match(/keyspace_misses:(\d+)/);
      const hits = hitsMatch ? parseInt(hitsMatch[1]) : 0;
      const misses = missesMatch ? parseInt(missesMatch[1]) : 0;
      const hitRate = hits + misses > 0 ? (hits / (hits + misses)) * 100 : 0;

      // Parse used memory
      const memoryMatch = memory.match(/used_memory_human:(.+)/);
      const usedMemory = memoryMatch ? memoryMatch[1].trim() : '0';

      return {
        connected: true,
        dbSize,
        usedMemory,
        hitRate: Math.round(hitRate * 100) / 100,
      };
    } catch (error) {
      console.error('[Redis] Stats error:', error);
      return {
        connected: false,
        dbSize: 0,
        usedMemory: '0',
        hitRate: 0,
      };
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      return false;
    }

    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch (error) {
      console.error('[Redis] Health check failed:', error);
      return false;
    }
  }

  /**
   * Close connection
   */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      this.isConnected = false;
    }
  }
}

// Export singleton instance
export const redisCache = new RedisCacheService();
