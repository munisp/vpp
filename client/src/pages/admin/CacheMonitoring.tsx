import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { trpc } from '@/lib/trpc';
import { 
  Activity, 
  Database, 
  TrendingUp, 
  TrendingDown, 
  RefreshCw,
  Clock,
  Zap,
  AlertCircle,
  CheckCircle2
} from 'lucide-react';
import { 
  LineChart, 
  Line, 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  Legend, 
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell
} from 'recharts';

const COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444'];

export default function CacheMonitoring() {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshInterval, setRefreshInterval] = useState(5000); // 5 seconds

  const { data: stats, refetch: refetchStats, isLoading } = trpc.cacheMonitoring.getCacheStats.useQuery(undefined, {
    refetchInterval: autoRefresh ? refreshInterval : false,
  });

  const { data: metrics, refetch: refetchMetrics } = trpc.cacheMonitoring.getCacheMetrics.useQuery(undefined, {
    refetchInterval: autoRefresh ? refreshInterval : false,
  });

  const { data: performance, refetch: refetchPerformance } = trpc.cacheMonitoring.getCachePerformance.useQuery(undefined, {
    refetchInterval: autoRefresh ? refreshInterval : false,
  });

  const clearCacheMutation = trpc.cacheMonitoring.clearCache.useMutation({
    onSuccess: () => {
      refetchStats();
      refetchMetrics();
      refetchPerformance();
    },
  });

  const handleRefresh = () => {
    refetchStats();
    refetchMetrics();
    refetchPerformance();
  };

  const handleClearCache = (pattern?: string) => {
    if (confirm(`Are you sure you want to clear ${pattern || 'all'} cache entries?`)) {
      clearCacheMutation.mutate({ pattern });
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <RefreshCw className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  const hitRate = stats?.totalRequests ? (stats.hits / stats.totalRequests * 100).toFixed(2) : '0';
  const missRate = stats?.totalRequests ? (stats.misses / stats.totalRequests * 100).toFixed(2) : '0';

  const hitMissData = [
    { name: 'Hits', value: stats?.hits || 0 },
    { name: 'Misses', value: stats?.misses || 0 },
  ];

  const cacheTypeData = [
    { name: 'User Profiles', value: stats?.userCacheSize || 0 },
    { name: 'Assets', value: stats?.assetCacheSize || 0 },
    { name: 'Market Prices', value: stats?.priceCacheSize || 0 },
    { name: 'DR Events', value: stats?.drEventCacheSize || 0 },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Cache Monitoring</h1>
          <p className="text-muted-foreground mt-1">
            Real-time Redis cache performance metrics and analytics
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={clearCacheMutation.isPending}
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${autoRefresh ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAutoRefresh(!autoRefresh)}
          >
            {autoRefresh ? (
              <>
                <Activity className="h-4 w-4 mr-2" />
                Auto-Refresh On
              </>
            ) : (
              <>
                <Clock className="h-4 w-4 mr-2" />
                Auto-Refresh Off
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Cache Hit Rate</CardTitle>
            <TrendingUp className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{hitRate}%</div>
            <p className="text-xs text-muted-foreground">
              {stats?.hits.toLocaleString()} hits out of {stats?.totalRequests.toLocaleString()} requests
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Cache Miss Rate</CardTitle>
            <TrendingDown className="h-4 w-4 text-red-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{missRate}%</div>
            <p className="text-xs text-muted-foreground">
              {stats?.misses.toLocaleString()} misses
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Avg Response Time</CardTitle>
            <Zap className="h-4 w-4 text-yellow-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{(performance?.avgResponseTime || 0)?.toFixed(2) || 0}ms</div>
            <p className="text-xs text-muted-foreground">
              {(performance?.avgResponseTime || 0) < 10 ? 'Excellent' : (performance?.avgResponseTime || 0) < 50 ? 'Good' : 'Needs attention'}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Cache Size</CardTitle>
            <Database className="h-4 w-4 text-blue-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.totalKeys.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">
              Active cache entries
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="performance">Performance</TabsTrigger>
          <TabsTrigger value="breakdown">Breakdown</TabsTrigger>
          <TabsTrigger value="management">Management</TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Hit vs Miss Distribution</CardTitle>
                <CardDescription>Cache effectiveness visualization</CardDescription>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie
                      data={hitMissData}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                      outerRadius={80}
                      fill="#8884d8"
                      dataKey="value"
                    >
                      {hitMissData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Cache Type Distribution</CardTitle>
                <CardDescription>Entries by cache category</CardDescription>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={cacheTypeData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" />
                    <YAxis />
                    <Tooltip />
                    <Bar dataKey="value" fill="#10b981" />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Performance Tab */}
        <TabsContent value="performance" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Response Time Trends</CardTitle>
              <CardDescription>Cache response time over time</CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={metrics?.responseTimeTrend || []}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="timestamp" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="avgTime" stroke="#10b981" name="Avg Response Time (ms)" />
                  <Line type="monotone" dataKey="maxTime" stroke="#ef4444" name="Max Response Time (ms)" />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Performance Metrics</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Min Response Time</span>
                  <Badge variant="outline">{performance?.minResponseTime.toFixed(2)}ms</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Max Response Time</span>
                  <Badge variant="outline">{performance?.maxResponseTime.toFixed(2)}ms</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">P95 Response Time</span>
                  <Badge variant="outline">{performance?.p95ResponseTime.toFixed(2)}ms</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">P99 Response Time</span>
                  <Badge variant="outline">{performance?.p99ResponseTime.toFixed(2)}ms</Badge>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Cache Health Status</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-2">
                  {parseFloat(hitRate) > 80 ? (
                    <CheckCircle2 className="h-5 w-5 text-green-600" />
                  ) : (
                    <AlertCircle className="h-5 w-5 text-yellow-600" />
                  )}
                  <div>
                    <p className="text-sm font-medium">Hit Rate Status</p>
                    <p className="text-xs text-muted-foreground">
                      {parseFloat(hitRate) > 80 ? 'Excellent' : parseFloat(hitRate) > 60 ? 'Good' : 'Needs Optimization'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {(performance?.avgResponseTime || 0) < 10 ? (
                    <CheckCircle2 className="h-5 w-5 text-green-600" />
                  ) : (
                    <AlertCircle className="h-5 w-5 text-yellow-600" />
                  )}
                  <div>
                    <p className="text-sm font-medium">Response Time Status</p>
                    <p className="text-xs text-muted-foreground">
                      {(performance?.avgResponseTime || 0) < 10 ? 'Excellent' : (performance?.avgResponseTime || 0) < 50 ? 'Good' : 'Slow'}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Breakdown Tab */}
        <TabsContent value="breakdown" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle>User Profile Cache</CardTitle>
                <CardDescription>TTL: 5 minutes</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-sm">Total Entries</span>
                  <span className="font-medium">{stats?.userCacheSize.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm">Hit Rate</span>
                  <span className="font-medium">{stats?.userCacheHitRate.toFixed(2)}%</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Asset Details Cache</CardTitle>
                <CardDescription>TTL: 10 minutes</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-sm">Total Entries</span>
                  <span className="font-medium">{stats?.assetCacheSize.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm">Hit Rate</span>
                  <span className="font-medium">{stats?.assetCacheHitRate.toFixed(2)}%</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Market Prices Cache</CardTitle>
                <CardDescription>TTL: 1 minute</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-sm">Total Entries</span>
                  <span className="font-medium">{stats?.priceCacheSize.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm">Hit Rate</span>
                  <span className="font-medium">{stats?.priceCacheHitRate.toFixed(2)}%</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>DR Events Cache</CardTitle>
                <CardDescription>TTL: 3 minutes</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-sm">Total Entries</span>
                  <span className="font-medium">{stats?.drEventCacheSize.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm">Hit Rate</span>
                  <span className="font-medium">{stats?.drEventCacheHitRate.toFixed(2)}%</span>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Management Tab */}
        <TabsContent value="management" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Cache Management</CardTitle>
              <CardDescription>Clear cache entries by category</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <h4 className="font-medium">Clear User Profile Cache</h4>
                  <p className="text-sm text-muted-foreground">
                    Clear all cached user profile data
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => handleClearCache('user:*')}
                    disabled={clearCacheMutation.isPending}
                  >
                    Clear User Cache
                  </Button>
                </div>

                <div className="space-y-2">
                  <h4 className="font-medium">Clear Asset Cache</h4>
                  <p className="text-sm text-muted-foreground">
                    Clear all cached asset details
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => handleClearCache('asset:*')}
                    disabled={clearCacheMutation.isPending}
                  >
                    Clear Asset Cache
                  </Button>
                </div>

                <div className="space-y-2">
                  <h4 className="font-medium">Clear Market Prices Cache</h4>
                  <p className="text-sm text-muted-foreground">
                    Clear all cached market price data
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => handleClearCache('price:*')}
                    disabled={clearCacheMutation.isPending}
                  >
                    Clear Price Cache
                  </Button>
                </div>

                <div className="space-y-2">
                  <h4 className="font-medium">Clear DR Events Cache</h4>
                  <p className="text-sm text-muted-foreground">
                    Clear all cached DR event data
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => handleClearCache('dr:*')}
                    disabled={clearCacheMutation.isPending}
                  >
                    Clear DR Cache
                  </Button>
                </div>
              </div>

              <div className="pt-4 border-t">
                <div className="space-y-2">
                  <h4 className="font-medium text-red-600">Clear All Cache</h4>
                  <p className="text-sm text-muted-foreground">
                    Clear all cache entries across all categories
                  </p>
                  <Button
                    variant="destructive"
                    onClick={() => handleClearCache()}
                    disabled={clearCacheMutation.isPending}
                  >
                    Clear All Cache
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
