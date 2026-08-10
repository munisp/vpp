import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Activity, Database, Globe, Workflow, TrendingUp, AlertCircle, CheckCircle } from "lucide-react";

export default function PerformanceDashboard() {
  const [timeWindow, setTimeWindow] = useState<number>(60);

  const { data: dashboard, isLoading } = trpc.performance.getDashboard.useQuery(
    { timeWindow },
    { refetchInterval: 30000 } // Refresh every 30 seconds
  );

  const { data: health } = trpc.performance.getHealth.useQuery(undefined, {
    refetchInterval: 10000, // Refresh every 10 seconds
  });

  const { data: apiEndpoints } = trpc.performance.getApiEndpoints.useQuery({ timeWindow });
  const { data: dbQueries } = trpc.performance.getDatabaseQueries.useQuery({ timeWindow });

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  const formatPercentage = (value: number) => {
    return `${value.toFixed(1)}%`;
  };

  const getHealthBadge = () => {
    if (!health) return null;

    const variants = {
      healthy: "default" as const,
      degraded: "secondary" as const,
      unhealthy: "destructive" as const,
    };

    const icons = {
      healthy: <CheckCircle className="h-4 w-4" />,
      degraded: <AlertCircle className="h-4 w-4" />,
      unhealthy: <AlertCircle className="h-4 w-4" />,
    };

    return (
      <Badge variant={variants[health.status]} className="gap-1">
        {icons[health.status]}
        {health.status.toUpperCase()}
      </Badge>
    );
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold">Performance Monitoring</h1>
          <p className="text-muted-foreground mt-2">
            Real-time system performance metrics and health status
          </p>
        </div>
        <div className="flex items-center gap-4">
          {getHealthBadge()}
          <Select value={timeWindow.toString()} onValueChange={(v) => setTimeWindow(parseInt(v))}>
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="5">Last 5 minutes</SelectItem>
              <SelectItem value="15">Last 15 minutes</SelectItem>
              <SelectItem value="60">Last hour</SelectItem>
              <SelectItem value="360">Last 6 hours</SelectItem>
              <SelectItem value="1440">Last 24 hours</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Health Status */}
      {health && (
        <Card>
          <CardHeader>
            <CardTitle>System Health</CardTitle>
            <CardDescription>{health.message}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-4">
              <div className="flex items-center gap-2">
                <Activity className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">API</p>
                  <Badge variant={health.checks.api ? "default" : "destructive"}>
                    {health.checks.api ? "Healthy" : "Issues"}
                  </Badge>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Database className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Database</p>
                  <Badge variant={health.checks.database ? "default" : "destructive"}>
                    {health.checks.database ? "Healthy" : "Issues"}
                  </Badge>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Globe className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">External APIs</p>
                  <Badge variant={health.checks.externalApi ? "default" : "destructive"}>
                    {health.checks.externalApi ? "Healthy" : "Issues"}
                  </Badge>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Performance Metrics */}
      {isLoading ? (
        <div className="grid grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : dashboard ? (
        <div className="grid grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium">API Requests</CardTitle>
                <Activity className="h-4 w-4 text-muted-foreground" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-1">
                <p className="text-2xl font-bold">{dashboard.api.count}</p>
                <p className="text-xs text-muted-foreground">
                  Avg: {formatDuration(dashboard.api.avgDuration)}
                </p>
                <p className="text-xs text-muted-foreground">
                  P95: {formatDuration(dashboard.api.p95Duration)}
                </p>
                <p className="text-xs">
                  Success: {formatPercentage(dashboard.api.successRate)}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium">Database Queries</CardTitle>
                <Database className="h-4 w-4 text-muted-foreground" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-1">
                <p className="text-2xl font-bold">{dashboard.database.count}</p>
                <p className="text-xs text-muted-foreground">
                  Avg: {formatDuration(dashboard.database.avgDuration)}
                </p>
                <p className="text-xs text-muted-foreground">
                  P95: {formatDuration(dashboard.database.p95Duration)}
                </p>
                <p className="text-xs">
                  Success: {formatPercentage(dashboard.database.successRate)}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium">External APIs</CardTitle>
                <Globe className="h-4 w-4 text-muted-foreground" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-1">
                <p className="text-2xl font-bold">{dashboard.externalApi.count}</p>
                <p className="text-xs text-muted-foreground">
                  Avg: {formatDuration(dashboard.externalApi.avgDuration)}
                </p>
                <p className="text-xs text-muted-foreground">
                  P95: {formatDuration(dashboard.externalApi.p95Duration)}
                </p>
                <p className="text-xs">
                  Success: {formatPercentage(dashboard.externalApi.successRate)}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium">Workflows</CardTitle>
                <Workflow className="h-4 w-4 text-muted-foreground" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-1">
                <p className="text-2xl font-bold">{dashboard.workflow.count}</p>
                <p className="text-xs text-muted-foreground">
                  Avg: {formatDuration(dashboard.workflow.avgDuration)}
                </p>
                <p className="text-xs text-muted-foreground">
                  P95: {formatDuration(dashboard.workflow.p95Duration)}
                </p>
                <p className="text-xs">
                  Success: {formatPercentage(dashboard.workflow.successRate)}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {/* Slow Requests */}
      {dashboard && dashboard.recentSlowRequests.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Recent Slow Requests (&gt;1s)</CardTitle>
            <CardDescription>Top 20 slowest requests in the selected time window</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Timestamp</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dashboard.recentSlowRequests.map((req, idx) => (
                  <TableRow key={idx}>
                    <TableCell>
                      <Badge variant="outline">{req.type}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-sm">{req.name}</TableCell>
                    <TableCell>
                      <span className={req.duration > 5000 ? "text-destructive font-semibold" : ""}>
                        {formatDuration(req.duration)}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(req.timestamp).toLocaleTimeString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* API Endpoints Performance */}
      {apiEndpoints && apiEndpoints.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>API Endpoints Performance</CardTitle>
            <CardDescription>Performance breakdown by endpoint</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Endpoint</TableHead>
                  <TableHead>Requests</TableHead>
                  <TableHead>Avg Duration</TableHead>
                  <TableHead>Min</TableHead>
                  <TableHead>Max</TableHead>
                  <TableHead>Success Rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {apiEndpoints.slice(0, 10).map((endpoint, idx) => (
                  <TableRow key={idx}>
                    <TableCell className="font-mono text-sm">{endpoint.endpoint}</TableCell>
                    <TableCell>{endpoint.count}</TableCell>
                    <TableCell>{formatDuration(endpoint.avgDuration)}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDuration(endpoint.minDuration)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDuration(endpoint.maxDuration)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={endpoint.successRate >= 95 ? "default" : "destructive"}>
                        {formatPercentage(endpoint.successRate)}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Database Queries Performance */}
      {dbQueries && dbQueries.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Database Queries Performance</CardTitle>
            <CardDescription>Performance breakdown by query</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Query</TableHead>
                  <TableHead>Executions</TableHead>
                  <TableHead>Avg Duration</TableHead>
                  <TableHead>Min</TableHead>
                  <TableHead>Max</TableHead>
                  <TableHead>Success Rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dbQueries.slice(0, 10).map((query, idx) => (
                  <TableRow key={idx}>
                    <TableCell className="font-mono text-sm">{query.query}</TableCell>
                    <TableCell>{query.count}</TableCell>
                    <TableCell>
                      <span className={query.avgDuration > 500 ? "text-destructive font-semibold" : ""}>
                        {formatDuration(query.avgDuration)}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDuration(query.minDuration)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDuration(query.maxDuration)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={query.successRate >= 98 ? "default" : "destructive"}>
                        {formatPercentage(query.successRate)}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
