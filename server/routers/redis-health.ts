import { z } from 'zod';
import { adminProcedure, router } from '../_core/trpc';
import { redisCache } from '../services/redis-cache';

export const redisHealthRouter = router({
  /**
   * Get Redis connection status and statistics
   */
  getStatus: adminProcedure.query(async () => {
    const stats = await redisCache.getStats();
    return {
      connected: stats.connected,
      dbSize: stats.dbSize,
      usedMemory: stats.usedMemory,
      hitRate: stats.hitRate,
      status: stats.connected ? 'healthy' : 'disconnected',
    };
  }),

  /**
   * Test Redis connection
   */
  testConnection: adminProcedure.mutation(async () => {
    try {
      const testKey = 'health:test';
      const testValue = { timestamp: new Date().toISOString() };
      
      // Try to set and get a value
      const setResult = await redisCache.set(testKey, testValue, { ttl: 10 });
      if (!setResult) {
        throw new Error('Failed to set test value');
      }
      
      const getValue = await redisCache.get(testKey);
      if (!getValue) {
        throw new Error('Failed to retrieve test value');
      }
      
      // Clean up
      await redisCache.del(testKey);
      
      return {
        success: true,
        message: 'Redis connection test successful',
        latency: 'OK',
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Redis connection test failed: ${error.message}`,
        latency: 'N/A',
      };
    }
  }),

  /**
   * Clear all cache
   */
  clearCache: adminProcedure
    .input(z.object({
      pattern: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const pattern = input.pattern || 'vpp:*';
      const deletedCount = await redisCache.delPattern(pattern);
      
      return {
        success: true,
        deletedCount,
        message: `Cleared ${deletedCount} cache entries`,
      };
    }),

  /**
   * Get cache key info
   */
  getKeyInfo: adminProcedure
    .input(z.object({
      key: z.string(),
    }))
    .query(async ({ input }) => {
      const exists = await redisCache.exists(input.key);
      const ttl = await redisCache.ttl(input.key);
      
      let value = null;
      if (exists) {
        value = await redisCache.get(input.key);
      }
      
      return {
        exists,
        ttl,
        value,
      };
    }),
});
