import Redis, { RedisOptions } from 'ioredis';

export const redisConfig: RedisOptions = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD,
  db: parseInt(process.env.REDIS_DB || '0'),
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: true
};

export class RedisCache {
  private client: Redis;
  private connected: boolean = false;

  constructor() {
    this.client = new Redis(redisConfig);

    this.client.on('connect', () => {
      console.log('[Redis] Connected');
      this.connected = true;
    });

    this.client.on('error', (error) => {
      console.error('[Redis] Error:', error);
      this.connected = false;
    });

    this.client.on('close', () => {
      console.log('[Redis] Connection closed');
      this.connected = false;
    });
  }

  async connect(): Promise<void> {
    if (!this.connected) {
      await this.client.connect();
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.quit();
    }
  }

  // Basic operations
  async get<T = any>(key: string): Promise<T | null> {
    try {
      const value = await this.client.get(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      console.error(`[Redis] Error getting key ${key}:`, error);
      return null;
    }
  }

  async set(key: string, value: any, ttl?: number): Promise<boolean> {
    try {
      const serialized = JSON.stringify(value);
      if (ttl) {
        await this.client.setex(key, ttl, serialized);
      } else {
        await this.client.set(key, serialized);
      }
      return true;
    } catch (error) {
      console.error(`[Redis] Error setting key ${key}:`, error);
      return false;
    }
  }

  async del(key: string): Promise<boolean> {
    try {
      await this.client.del(key);
      return true;
    } catch (error) {
      console.error(`[Redis] Error deleting key ${key}:`, error);
      return false;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const result = await this.client.exists(key);
      return result === 1;
    } catch (error) {
      console.error(`[Redis] Error checking key ${key}:`, error);
      return false;
    }
  }

  async expire(key: string, ttl: number): Promise<boolean> {
    try {
      await this.client.expire(key, ttl);
      return true;
    } catch (error) {
      console.error(`[Redis] Error setting expiry for key ${key}:`, error);
      return false;
    }
  }

  // Hash operations
  async hget<T = any>(key: string, field: string): Promise<T | null> {
    try {
      const value = await this.client.hget(key, field);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      console.error(`[Redis] Error getting hash field ${key}.${field}:`, error);
      return null;
    }
  }

  async hset(key: string, field: string, value: any): Promise<boolean> {
    try {
      const serialized = JSON.stringify(value);
      await this.client.hset(key, field, serialized);
      return true;
    } catch (error) {
      console.error(`[Redis] Error setting hash field ${key}.${field}:`, error);
      return false;
    }
  }

  async hgetall<T = Record<string, any>>(key: string): Promise<T | null> {
    try {
      const value = await this.client.hgetall(key);
      if (!value || Object.keys(value).length === 0) return null;
      
      const parsed: any = {};
      for (const [field, val] of Object.entries(value)) {
        parsed[field] = JSON.parse(val);
      }
      return parsed;
    } catch (error) {
      console.error(`[Redis] Error getting all hash fields for ${key}:`, error);
      return null;
    }
  }

  // List operations
  async lpush(key: string, ...values: any[]): Promise<number> {
    try {
      const serialized = values.map(v => JSON.stringify(v));
      return await this.client.lpush(key, ...serialized);
    } catch (error) {
      console.error(`[Redis] Error lpush to ${key}:`, error);
      return 0;
    }
  }

  async rpush(key: string, ...values: any[]): Promise<number> {
    try {
      const serialized = values.map(v => JSON.stringify(v));
      return await this.client.rpush(key, ...serialized);
    } catch (error) {
      console.error(`[Redis] Error rpush to ${key}:`, error);
      return 0;
    }
  }

  async lrange<T = any>(key: string, start: number, stop: number): Promise<T[]> {
    try {
      const values = await this.client.lrange(key, start, stop);
      return values.map(v => JSON.parse(v));
    } catch (error) {
      console.error(`[Redis] Error lrange from ${key}:`, error);
      return [];
    }
  }

  // Set operations
  async sadd(key: string, ...members: string[]): Promise<number> {
    try {
      return await this.client.sadd(key, ...members);
    } catch (error) {
      console.error(`[Redis] Error sadd to ${key}:`, error);
      return 0;
    }
  }

  async smembers(key: string): Promise<string[]> {
    try {
      return await this.client.smembers(key);
    } catch (error) {
      console.error(`[Redis] Error smembers from ${key}:`, error);
      return [];
    }
  }

  async sismember(key: string, member: string): Promise<boolean> {
    try {
      const result = await this.client.sismember(key, member);
      return result === 1;
    } catch (error) {
      console.error(`[Redis] Error sismember ${key}:`, error);
      return false;
    }
  }

  // Sorted set operations
  async zadd(key: string, score: number, member: string): Promise<number> {
    try {
      return await this.client.zadd(key, score, member);
    } catch (error) {
      console.error(`[Redis] Error zadd to ${key}:`, error);
      return 0;
    }
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    try {
      return await this.client.zrange(key, start, stop);
    } catch (error) {
      console.error(`[Redis] Error zrange from ${key}:`, error);
      return [];
    }
  }

  async zrangebyscore(key: string, min: number, max: number): Promise<string[]> {
    try {
      return await this.client.zrangebyscore(key, min, max);
    } catch (error) {
      console.error(`[Redis] Error zrangebyscore from ${key}:`, error);
      return [];
    }
  }

  // Pub/Sub
  async publish(channel: string, message: any): Promise<number> {
    try {
      const serialized = JSON.stringify(message);
      return await this.client.publish(channel, serialized);
    } catch (error) {
      console.error(`[Redis] Error publishing to ${channel}:`, error);
      return 0;
    }
  }

  subscribe(channel: string, callback: (message: any) => void): void {
    const subscriber = this.client.duplicate();
    subscriber.subscribe(channel);
    subscriber.on('message', (ch, msg) => {
      if (ch === channel) {
        try {
          const parsed = JSON.parse(msg);
          callback(parsed);
        } catch (error) {
          console.error(`[Redis] Error parsing message from ${channel}:`, error);
        }
      }
    });
  }

  // Cache patterns
  async cacheOrFetch<T>(
    key: string,
    fetchFn: () => Promise<T>,
    ttl?: number
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    const fresh = await fetchFn();
    await this.set(key, fresh, ttl);
    return fresh;
  }

  async invalidatePattern(pattern: string): Promise<number> {
    try {
      const keys = await this.client.keys(pattern);
      if (keys.length === 0) return 0;
      return await this.client.del(...keys);
    } catch (error) {
      console.error(`[Redis] Error invalidating pattern ${pattern}:`, error);
      return 0;
    }
  }

  // Health check
  async isHealthy(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch (error) {
      console.error('[Redis] Health check failed:', error);
      return false;
    }
  }

  async healthCheck(): Promise<{ connected: boolean; latency?: number }> {
    try {
      const start = Date.now();
      const result = await this.client.ping();
      const latency = Date.now() - start;
      return { connected: result === 'PONG', latency };
    } catch (error) {
      console.error('[Redis] Health check failed:', error);
      return { connected: false };
    }
  }

  // Get stats
  async getStats(): Promise<Record<string, any>> {
    try {
      const info = await this.client.info('stats');
      const keyspace = await this.client.info('keyspace');
      
      // Parse INFO output
      const parseInfo = (infoStr: string) => {
        const lines = infoStr.split('\r\n');
        const result: Record<string, any> = {};
        for (const line of lines) {
          if (line && !line.startsWith('#')) {
            const [key, value] = line.split(':');
            if (key && value) {
              result[key] = isNaN(Number(value)) ? value : Number(value);
            }
          }
        }
        return result;
      };

      const statsData = parseInfo(info);
      const keyspaceData = parseInfo(keyspace);

      // Count keys by pattern
      const userKeys = await this.client.keys('user:*');
      const assetKeys = await this.client.keys('asset:*');
      const priceKeys = await this.client.keys('price:*');
      const drKeys = await this.client.keys('dr:*');

      return {
        totalKeys: statsData.db0?.split(',')[0]?.split('=')[1] || 0,
        hits: statsData.keyspace_hits || 0,
        misses: statsData.keyspace_misses || 0,
        userCacheSize: userKeys.length,
        assetCacheSize: assetKeys.length,
        priceCacheSize: priceKeys.length,
        drEventCacheSize: drKeys.length,
        userCacheHitRate: 85.5, // Mock data - would need tracking
        assetCacheHitRate: 92.3,
        priceCacheHitRate: 78.9,
        drEventCacheHitRate: 88.7,
      };
    } catch (error) {
      console.error('[Redis] Error getting stats:', error);
      return {
        totalKeys: 0,
        hits: 0,
        misses: 0,
        userCacheSize: 0,
        assetCacheSize: 0,
        priceCacheSize: 0,
        drEventCacheSize: 0,
        userCacheHitRate: 0,
        assetCacheHitRate: 0,
        priceCacheHitRate: 0,
        drEventCacheHitRate: 0,
      };
    }
  }

  async getMetrics(): Promise<Record<string, any>> {
    try {
      // Mock metrics - in production, these would be tracked over time
      const now = new Date();
      const responseTimeTrend = [];
      for (let i = 10; i >= 0; i--) {
        const time = new Date(now.getTime() - i * 60000);
        responseTimeTrend.push({
          timestamp: time.toISOString().slice(11, 16),
          avgTime: Math.random() * 5 + 2,
          maxTime: Math.random() * 15 + 5,
        });
      }

      return {
        responseTimeTrend,
        hitRateTrend: [],
        cacheSizeTrend: [],
      };
    } catch (error) {
      console.error('[Redis] Error getting metrics:', error);
      return {
        responseTimeTrend: [],
        hitRateTrend: [],
        cacheSizeTrend: [],
      };
    }
  }

  async getPerformance(): Promise<Record<string, number>> {
    try {
      // Mock performance data - in production, track actual response times
      return {
        avgResponseTime: 3.5,
        minResponseTime: 0.8,
        maxResponseTime: 12.3,
        p95ResponseTime: 8.2,
        p99ResponseTime: 11.1,
      };
    } catch (error) {
      console.error('[Redis] Error getting performance:', error);
      return {
        avgResponseTime: 0,
        minResponseTime: 0,
        maxResponseTime: 0,
        p95ResponseTime: 0,
        p99ResponseTime: 0,
      };
    }
  }

  async clearCache(pattern?: string): Promise<void> {
    try {
      if (pattern) {
        await this.invalidatePattern(pattern);
      } else {
        await this.client.flushdb();
      }
      console.log(`[Redis] Cache cleared${pattern ? ` for pattern: ${pattern}` : ''}`);
    } catch (error) {
      console.error('[Redis] Error clearing cache:', error);
      throw error;
    }
  }
}

// Singleton instance
export const redisCache = new RedisCache();

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[Redis] Shutting down...');
  await redisCache.disconnect();
});

process.on('SIGINT', async () => {
  console.log('[Redis] Shutting down...');
  await redisCache.disconnect();
});

// Cache key builders
export const CacheKeys = {
  user: (userId: string) => `user:${userId}`,
  userAssets: (userId: string) => `user:${userId}:assets`,
  userTelemetry: (userId: string, assetId: string) => `telemetry:${userId}:${assetId}`,
  marketPrice: () => `market:price`,
  drEvent: (eventId: string) => `dr:event:${eventId}`,
  drParticipants: (eventId: string) => `dr:event:${eventId}:participants`,
  payment: (paymentId: string) => `payment:${paymentId}`,
  trade: (tradeId: string) => `trade:${tradeId}`,
  analytics: (type: string, date: string) => `analytics:${type}:${date}`,
  session: (sessionId: string) => `session:${sessionId}`
};
