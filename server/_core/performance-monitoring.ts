/**
 * Performance Monitoring System
 * 
 * Collects and tracks performance metrics for APIs, database queries,
 * and system health monitoring.
 */

import type { Request, Response, NextFunction } from 'express';

/**
 * Performance Metrics Store
 */
interface PerformanceMetric {
  timestamp: Date;
  type: 'api' | 'database' | 'external_api' | 'workflow';
  name: string;
  duration: number; // milliseconds
  success: boolean;
  metadata?: Record<string, any>;
}

class PerformanceMonitor {
  private metrics: PerformanceMetric[] = [];
  private readonly MAX_METRICS = 10000; // Keep last 10k metrics in memory

  /**
   * Record a performance metric
   */
  record(metric: Omit<PerformanceMetric, 'timestamp'>): void {
    this.metrics.push({
      ...metric,
      timestamp: new Date(),
    });

    // Trim old metrics
    if (this.metrics.length > this.MAX_METRICS) {
      this.metrics = this.metrics.slice(-this.MAX_METRICS);
    }
  }

  /**
   * Get metrics within a time range
   */
  getMetrics(options: {
    type?: PerformanceMetric['type'];
    startTime?: Date;
    endTime?: Date;
    limit?: number;
  }): PerformanceMetric[] {
    let filtered = this.metrics;

    if (options.type) {
      filtered = filtered.filter(m => m.type === options.type);
    }

    if (options.startTime) {
      filtered = filtered.filter(m => m.timestamp >= options.startTime!);
    }

    if (options.endTime) {
      filtered = filtered.filter(m => m.timestamp <= options.endTime!);
    }

    if (options.limit) {
      filtered = filtered.slice(-options.limit);
    }

    return filtered;
  }

  /**
   * Get aggregated statistics
   */
  getStats(options: {
    type?: PerformanceMetric['type'];
    name?: string;
    timeWindow?: number; // minutes
  }): {
    count: number;
    avgDuration: number;
    minDuration: number;
    maxDuration: number;
    p50Duration: number;
    p95Duration: number;
    p99Duration: number;
    successRate: number;
  } {
    const now = new Date();
    const startTime = options.timeWindow
      ? new Date(now.getTime() - options.timeWindow * 60 * 1000)
      : undefined;

    let metrics = this.getMetrics({
      type: options.type,
      startTime,
    });

    if (options.name) {
      metrics = metrics.filter(m => m.name === options.name);
    }

    if (metrics.length === 0) {
      return {
        count: 0,
        avgDuration: 0,
        minDuration: 0,
        maxDuration: 0,
        p50Duration: 0,
        p95Duration: 0,
        p99Duration: 0,
        successRate: 0,
      };
    }

    const durations = metrics.map(m => m.duration).sort((a, b) => a - b);
    const successCount = metrics.filter(m => m.success).length;

    return {
      count: metrics.length,
      avgDuration: durations.reduce((a, b) => a + b, 0) / durations.length,
      minDuration: durations[0],
      maxDuration: durations[durations.length - 1],
      p50Duration: durations[Math.floor(durations.length * 0.5)],
      p95Duration: durations[Math.floor(durations.length * 0.95)],
      p99Duration: durations[Math.floor(durations.length * 0.99)],
      successRate: (successCount / metrics.length) * 100,
    };
  }

  /**
   * Clear all metrics
   */
  clear(): void {
    this.metrics = [];
  }
}

// Singleton instance
export const performanceMonitor = new PerformanceMonitor();

/**
 * Express middleware for API performance monitoring
 */
export function apiPerformanceMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const startTime = Date.now();
  const originalSend = res.send;

  // Override res.send to capture response time
  res.send = function (data: any): Response {
    const duration = Date.now() - startTime;
    const success = res.statusCode < 400;

    performanceMonitor.record({
      type: 'api',
      name: `${req.method} ${req.path}`,
      duration,
      success,
      metadata: {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        userAgent: req.get('user-agent'),
      },
    });

    // Log slow requests
    if (duration > 1000) {
      console.warn(`[Performance] Slow API request: ${req.method} ${req.path} took ${duration}ms`);
    }

    return originalSend.call(this, data);
  };

  next();
}

/**
 * Database query performance tracker
 */
export function trackDatabaseQuery<T>(
  queryName: string,
  queryFn: () => Promise<T>
): Promise<T> {
  const startTime = Date.now();

  return queryFn()
    .then(result => {
      const duration = Date.now() - startTime;

      performanceMonitor.record({
        type: 'database',
        name: queryName,
        duration,
        success: true,
      });

      // Log slow queries
      if (duration > 500) {
        console.warn(`[Performance] Slow database query: ${queryName} took ${duration}ms`);
      }

      return result;
    })
    .catch(error => {
      const duration = Date.now() - startTime;

      performanceMonitor.record({
        type: 'database',
        name: queryName,
        duration,
        success: false,
        metadata: {
          error: error.message,
        },
      });

      throw error;
    });
}

/**
 * External API call performance tracker
 */
export function trackExternalAPI<T>(
  apiName: string,
  apiFn: () => Promise<T>
): Promise<T> {
  const startTime = Date.now();

  return apiFn()
    .then(result => {
      const duration = Date.now() - startTime;

      performanceMonitor.record({
        type: 'external_api',
        name: apiName,
        duration,
        success: true,
      });

      // Log slow external API calls
      if (duration > 2000) {
        console.warn(`[Performance] Slow external API call: ${apiName} took ${duration}ms`);
      }

      return result;
    })
    .catch(error => {
      const duration = Date.now() - startTime;

      performanceMonitor.record({
        type: 'external_api',
        name: apiName,
        duration,
        success: false,
        metadata: {
          error: error.message,
        },
      });

      throw error;
    });
}

/**
 * Workflow performance tracker
 */
export function trackWorkflow<T>(
  workflowName: string,
  workflowFn: () => Promise<T>
): Promise<T> {
  const startTime = Date.now();

  return workflowFn()
    .then(result => {
      const duration = Date.now() - startTime;

      performanceMonitor.record({
        type: 'workflow',
        name: workflowName,
        duration,
        success: true,
      });

      console.log(`[Performance] Workflow ${workflowName} completed in ${duration}ms`);

      return result;
    })
    .catch(error => {
      const duration = Date.now() - startTime;

      performanceMonitor.record({
        type: 'workflow',
        name: workflowName,
        duration,
        success: false,
        metadata: {
          error: error.message,
        },
      });

      throw error;
    });
}

/**
 * Get performance dashboard data
 */
export function getPerformanceDashboard(timeWindow: number = 60): {
  api: ReturnType<typeof performanceMonitor.getStats>;
  database: ReturnType<typeof performanceMonitor.getStats>;
  externalApi: ReturnType<typeof performanceMonitor.getStats>;
  workflow: ReturnType<typeof performanceMonitor.getStats>;
  recentSlowRequests: Array<{
    type: string;
    name: string;
    duration: number;
    timestamp: Date;
  }>;
} {
  const apiStats = performanceMonitor.getStats({ type: 'api', timeWindow });
  const dbStats = performanceMonitor.getStats({ type: 'database', timeWindow });
  const externalApiStats = performanceMonitor.getStats({ type: 'external_api', timeWindow });
  const workflowStats = performanceMonitor.getStats({ type: 'workflow', timeWindow });

  // Get recent slow requests (>1s)
  const allMetrics = performanceMonitor.getMetrics({
    startTime: new Date(Date.now() - timeWindow * 60 * 1000),
    limit: 1000,
  });

  const slowRequests = allMetrics
    .filter(m => m.duration > 1000)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 20)
    .map(m => ({
      type: m.type,
      name: m.name,
      duration: m.duration,
      timestamp: m.timestamp,
    }));

  return {
    api: apiStats,
    database: dbStats,
    externalApi: externalApiStats,
    workflow: workflowStats,
    recentSlowRequests: slowRequests,
  };
}

/**
 * Health check based on performance metrics
 */
export function getHealthStatus(): {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: {
    api: boolean;
    database: boolean;
    externalApi: boolean;
  };
  message: string;
} {
  const stats = getPerformanceDashboard(5); // Last 5 minutes

  const checks = {
    api: stats.api.p95Duration < 2000 && stats.api.successRate > 95,
    database: stats.database.p95Duration < 1000 && stats.database.successRate > 98,
    externalApi: stats.externalApi.p95Duration < 5000 && stats.externalApi.successRate > 90,
  };

  const failedChecks = Object.entries(checks).filter(([_, passed]) => !passed);

  if (failedChecks.length === 0) {
    return {
      status: 'healthy',
      checks,
      message: 'All systems operating normally',
    };
  } else if (failedChecks.length === 1) {
    return {
      status: 'degraded',
      checks,
      message: `Performance degradation detected in: ${failedChecks.map(([name]) => name).join(', ')}`,
    };
  } else {
    return {
      status: 'unhealthy',
      checks,
      message: `Multiple systems experiencing issues: ${failedChecks.map(([name]) => name).join(', ')}`,
    };
  }
}
