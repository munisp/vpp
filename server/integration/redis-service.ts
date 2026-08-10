import { redisCache } from './redis-cache';
import { getDb } from '../db';
import { users, assets } from '../../drizzle/schema';
import { eq } from 'drizzle-orm';

/**
 * Redis Cache Service
 * High-level caching service with automatic invalidation
 */

// Cache TTLs (in seconds)
const CACHE_TTL = {
  USER_PROFILE: 300, // 5 minutes
  ASSET_DETAILS: 600, // 10 minutes
  MARKET_PRICE: 60, // 1 minute
  DR_EVENTS: 180, // 3 minutes
};

export class RedisCacheService {
  // User Profile Caching
  async getUserProfile(userId: number) {
    const cacheKey = `user:profile:${userId}`;
    
    // Try cache first
    const cached = await redisCache.get(cacheKey);
    if (cached) {
      return cached; // Already parsed by RedisCache.get
    }

    // Fetch from database
    const db = await getDb();
    if (!db) return null;

    const result = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (result.length === 0) return null;

    const user = result[0];
    
    // Cache the result
    await redisCache.set(cacheKey, user, CACHE_TTL.USER_PROFILE);
    
    return user;
  }

  async invalidateUserProfile(userId: number) {
    const cacheKey = `user:profile:${userId}`;
    await redisCache.del(cacheKey);
  }

  // Asset Details Caching
  async getAssetDetails(assetId: number) {
    const cacheKey = `asset:details:${assetId}`;
    
    const cached = await redisCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const db = await getDb();
    if (!db) return null;

    const result = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
    if (result.length === 0) return null;

    const asset = result[0];
    await redisCache.set(cacheKey, asset, CACHE_TTL.ASSET_DETAILS);
    
    return asset;
  }

  async invalidateAssetDetails(assetId: number) {
    const cacheKey = `asset:details:${assetId}`;
    await redisCache.del(cacheKey);
  }

  async invalidateUserAssets(userId: number) {
    // Invalidate all assets for a user
    // Note: Pattern-based deletion requires SCAN command, simplified for now
    const cacheKey = `asset:user:${userId}`;
    await redisCache.del(cacheKey);
  }

  // Market Price Caching
  async getMarketPrice(priceType: 'buy' | 'sell' = 'buy') {
    const cacheKey = `market:price:${priceType}`;
    
    const cached = await redisCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // If not in cache, return null (caller should fetch and set)
    return null;
  }

  async setMarketPrice(priceType: 'buy' | 'sell', price: number) {
    const cacheKey = `market:price:${priceType}`;
    const data = {
      price,
      timestamp: new Date().toISOString(),
    };
    await redisCache.set(cacheKey, data, CACHE_TTL.MARKET_PRICE);
  }

  // DR Events Caching
  async getDREvents(status: string) {
    const cacheKey = `dr:events:${status}`;
    
    const cached = await redisCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    return null;
  }

  async setDREvents(status: string, events: any[]) {
    const cacheKey = `dr:events:${status}`;
    await redisCache.set(cacheKey, events, CACHE_TTL.DR_EVENTS);
  }

  async invalidateDREvents() {
    // Invalidate common DR event cache keys
    await redisCache.del('dr:events:scheduled');
    await redisCache.del('dr:events:active');
    await redisCache.del('dr:events:completed');
  }

  // Batch operations
  async warmUserCache(userIds: number[]) {
    const promises = userIds.map(id => this.getUserProfile(id));
    await Promise.all(promises);
  }

  async warmAssetCache(assetIds: number[]) {
    const promises = assetIds.map(id => this.getAssetDetails(id));
    await Promise.all(promises);
  }

  // Health check
  async healthCheck() {
    try {
      await redisCache.set('health:check', 'ok', 10);
      const result = await redisCache.get('health:check');
      return result === 'ok';
    } catch {
      return false;
    }
  }
}

export const redisCacheService = new RedisCacheService();
