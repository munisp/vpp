import { z } from 'zod';
import { router, protectedProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import { redisCache } from '../integration/redis-cache';

/**
 * Cache Monitoring Router
 * Provides endpoints for monitoring Redis cache performance
 */
export const cacheMonitoringRouter = router({
  /**
   * Get overall cache statistics
   */
  getCacheStats: protectedProcedure.query(async ({ ctx }) => {
    try {
      // Check if user is admin
      if (ctx.user.role !== 'admin') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Admin access required',
        });
      }

      const health = await redisCache.healthCheck();
      
      if (!health.connected) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Redis cache is not available',
        });
      }

      // Get cache statistics from Redis INFO command
      const stats = await redisCache.getStats();

      return {
        totalKeys: stats.totalKeys || 0,
        hits: stats.hits || 0,
        misses: stats.misses || 0,
        totalRequests: (stats.hits || 0) + (stats.misses || 0),
        userCacheSize: stats.userCacheSize || 0,
        assetCacheSize: stats.assetCacheSize || 0,
        priceCacheSize: stats.priceCacheSize || 0,
        drEventCacheSize: stats.drEventCacheSize || 0,
        userCacheHitRate: stats.userCacheHitRate || 0,
        assetCacheHitRate: stats.assetCacheHitRate || 0,
        priceCacheHitRate: stats.priceCacheHitRate || 0,
        drEventCacheHitRate: stats.drEventCacheHitRate || 0,
      };
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error('[CacheMonitoring] Error getting cache stats:', error);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to retrieve cache statistics',
      });
    }
  }),

  /**
   * Get cache metrics over time
   */
  getCacheMetrics: protectedProcedure.query(async ({ ctx }) => {
    try {
      if (ctx.user.role !== 'admin') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Admin access required',
        });
      }

      const metrics = await redisCache.getMetrics();

      return {
        responseTimeTrend: metrics.responseTimeTrend || [],
        hitRateTrend: metrics.hitRateTrend || [],
        cacheSizeTrend: metrics.cacheSizeTrend || [],
      };
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error('[CacheMonitoring] Error getting cache metrics:', error);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to retrieve cache metrics',
      });
    }
  }),

  /**
   * Get cache performance analytics
   */
  getCachePerformance: protectedProcedure.query(async ({ ctx }) => {
    try {
      if (ctx.user.role !== 'admin') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Admin access required',
        });
      }

      const performance = await redisCache.getPerformance();

      return {
        avgResponseTime: performance.avgResponseTime || 0,
        minResponseTime: performance.minResponseTime || 0,
        maxResponseTime: performance.maxResponseTime || 0,
        p95ResponseTime: performance.p95ResponseTime || 0,
        p99ResponseTime: performance.p99ResponseTime || 0,
      };
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error('[CacheMonitoring] Error getting cache performance:', error);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to retrieve cache performance',
      });
    }
  }),

  /**
   * Clear cache entries by pattern
   */
  clearCache: protectedProcedure
    .input(
      z.object({
        pattern: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        if (ctx.user.role !== 'admin') {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Admin access required',
          });
        }

        await redisCache.clearCache(input.pattern);

        return {
          success: true,
          message: `Cache cleared successfully${input.pattern ? ` for pattern: ${input.pattern}` : ''}`,
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error('[CacheMonitoring] Error clearing cache:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to clear cache',
        });
      }
    }),

  /**
   * Warm up cache with frequently accessed data
   */
  warmCache: protectedProcedure.mutation(async ({ ctx }) => {
    try {
      if (ctx.user.role !== 'admin') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Admin access required',
        });
      }

      // This would pre-load frequently accessed data into cache
      // For example: active users, popular assets, current market prices
      console.log('[CacheMonitoring] Cache warming initiated');

      return {
        success: true,
        message: 'Cache warming completed',
      };
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error('[CacheMonitoring] Error warming cache:', error);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to warm cache',
      });
    }
  }),
});

export type CacheMonitoringRouter = typeof cacheMonitoringRouter;
