import { router, protectedProcedure, publicProcedure } from "../_core/trpc";
import { z } from "zod";
import {
  performanceMonitor,
  getPerformanceDashboard,
  getHealthStatus,
} from "../_core/performance-monitoring";

export const performanceRouter = router({
  /**
   * Get performance dashboard data
   */
  getDashboard: protectedProcedure
    .input(
      z.object({
        timeWindow: z.number().min(1).max(1440).optional().default(60), // minutes
      })
    )
    .query(({ input, ctx }) => {
      // Only admins can view performance metrics
      if (ctx.user.role !== "admin") {
        throw new Error("Unauthorized");
      }

      return getPerformanceDashboard(input.timeWindow);
    }),

  /**
   * Get performance stats for specific metric
   */
  getStats: protectedProcedure
    .input(
      z.object({
        type: z.enum(["api", "database", "external_api", "workflow"]).optional(),
        name: z.string().optional(),
        timeWindow: z.number().min(1).max(1440).optional().default(60),
      })
    )
    .query(({ input, ctx }) => {
      if (ctx.user.role !== "admin") {
        throw new Error("Unauthorized");
      }

      return performanceMonitor.getStats({
        type: input.type,
        name: input.name,
        timeWindow: input.timeWindow,
      });
    }),

  /**
   * Get recent metrics
   */
  getRecentMetrics: protectedProcedure
    .input(
      z.object({
        type: z.enum(["api", "database", "external_api", "workflow"]).optional(),
        limit: z.number().min(1).max(1000).optional().default(100),
      })
    )
    .query(({ input, ctx }) => {
      if (ctx.user.role !== "admin") {
        throw new Error("Unauthorized");
      }

      return performanceMonitor.getMetrics({
        type: input.type,
        limit: input.limit,
      });
    }),

  /**
   * Get health status
   */
  getHealth: publicProcedure.query(() => {
    return getHealthStatus();
  }),

  /**
   * Clear metrics (admin only)
   */
  clearMetrics: protectedProcedure.mutation(({ ctx }) => {
    if (ctx.user.role !== "admin") {
      throw new Error("Unauthorized");
    }

    performanceMonitor.clear();
    return { success: true };
  }),

  /**
   * Get API endpoint performance
   */
  getApiEndpoints: protectedProcedure
    .input(
      z.object({
        timeWindow: z.number().min(1).max(1440).optional().default(60),
      })
    )
    .query(({ input, ctx }) => {
      if (ctx.user.role !== "admin") {
        throw new Error("Unauthorized");
      }

      const metrics = performanceMonitor.getMetrics({
        type: "api",
        startTime: new Date(Date.now() - input.timeWindow * 60 * 1000),
      });

      // Group by endpoint
      const endpointStats = new Map<
        string,
        {
          count: number;
          totalDuration: number;
          minDuration: number;
          maxDuration: number;
          successCount: number;
        }
      >();

      metrics.forEach((metric) => {
        const existing = endpointStats.get(metric.name);
        if (existing) {
          existing.count++;
          existing.totalDuration += metric.duration;
          existing.minDuration = Math.min(existing.minDuration, metric.duration);
          existing.maxDuration = Math.max(existing.maxDuration, metric.duration);
          if (metric.success) existing.successCount++;
        } else {
          endpointStats.set(metric.name, {
            count: 1,
            totalDuration: metric.duration,
            minDuration: metric.duration,
            maxDuration: metric.duration,
            successCount: metric.success ? 1 : 0,
          });
        }
      });

      // Convert to array and calculate averages
      return Array.from(endpointStats.entries()).map(([name, stats]) => ({
        endpoint: name,
        count: stats.count,
        avgDuration: stats.totalDuration / stats.count,
        minDuration: stats.minDuration,
        maxDuration: stats.maxDuration,
        successRate: (stats.successCount / stats.count) * 100,
      }));
    }),

  /**
   * Get database query performance
   */
  getDatabaseQueries: protectedProcedure
    .input(
      z.object({
        timeWindow: z.number().min(1).max(1440).optional().default(60),
      })
    )
    .query(({ input, ctx }) => {
      if (ctx.user.role !== "admin") {
        throw new Error("Unauthorized");
      }

      const metrics = performanceMonitor.getMetrics({
        type: "database",
        startTime: new Date(Date.now() - input.timeWindow * 60 * 1000),
      });

      // Group by query name
      const queryStats = new Map<
        string,
        {
          count: number;
          totalDuration: number;
          minDuration: number;
          maxDuration: number;
          successCount: number;
        }
      >();

      metrics.forEach((metric) => {
        const existing = queryStats.get(metric.name);
        if (existing) {
          existing.count++;
          existing.totalDuration += metric.duration;
          existing.minDuration = Math.min(existing.minDuration, metric.duration);
          existing.maxDuration = Math.max(existing.maxDuration, metric.duration);
          if (metric.success) existing.successCount++;
        } else {
          queryStats.set(metric.name, {
            count: 1,
            totalDuration: metric.duration,
            minDuration: metric.duration,
            maxDuration: metric.duration,
            successCount: metric.success ? 1 : 0,
          });
        }
      });

      return Array.from(queryStats.entries()).map(([name, stats]) => ({
        query: name,
        count: stats.count,
        avgDuration: stats.totalDuration / stats.count,
        minDuration: stats.minDuration,
        maxDuration: stats.maxDuration,
        successRate: (stats.successCount / stats.count) * 100,
      }));
    }),
});
