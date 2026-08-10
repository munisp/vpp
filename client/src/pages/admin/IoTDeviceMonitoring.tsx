import { trpc } from '@/lib/trpc';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Activity, Wifi, WifiOff, AlertTriangle, Thermometer, Zap, Battery } from 'lucide-react';
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from 'recharts';

export default function IoTDeviceMonitoring() {
  const { data: devicesHealth } = trpc.iotDevices.getAllDevicesHealth.useQuery();
  const { data: brokerStatus } = trpc.iotDevices.getBrokerStatus.useQuery();

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'online':
        return <Wifi className="h-4 w-4 text-green-500" />;
      case 'offline':
        return <WifiOff className="h-4 w-4 text-red-500" />;
      case 'warning':
        return <AlertTriangle className="h-4 w-4 text-yellow-500" />;
      default:
        return <Activity className="h-4 w-4 text-gray-500" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'online':
        return 'bg-green-500';
      case 'offline':
        return 'bg-red-500';
      case 'warning':
        return 'bg-yellow-500';
      default:
        return 'bg-gray-500';
    }
  };

  const onlineCount = devicesHealth?.filter(d => d.status === 'online').length || 0;
  const offlineCount = devicesHealth?.filter(d => d.status === 'offline').length || 0;
  const warningCount = devicesHealth?.filter(d => d.status === 'warning').length || 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">IoT Device Monitoring</h1>
        <p className="text-muted-foreground">Real-time monitoring of connected energy assets</p>
      </div>

      {/* MQTT Broker Status */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            MQTT Broker Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <div className={`h-3 w-3 rounded-full ${brokerStatus?.connected ? 'bg-green-500' : 'bg-red-500'}`} />
            <div>
              <div className="font-medium">
                {brokerStatus?.connected ? 'Connected' : 'Disconnected'}
              </div>
              <div className="text-sm text-muted-foreground">
                Last checked: {brokerStatus?.timestamp ? new Date(brokerStatus.timestamp).toLocaleString() : 'N/A'}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Device Health Summary */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Devices</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{devicesHealth?.length || 0}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Wifi className="h-4 w-4 text-green-500" />
              Online
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{onlineCount}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-yellow-500" />
              Warning
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-600">{warningCount}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <WifiOff className="h-4 w-4 text-red-500" />
              Offline
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{offlineCount}</div>
          </CardContent>
        </Card>
      </div>

      {/* Device List */}
      <Card>
        <CardHeader>
          <CardTitle>Connected Devices</CardTitle>
          <CardDescription>Real-time status of all registered IoT devices</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {devicesHealth && devicesHealth.length > 0 ? (
              devicesHealth.map((device) => (
                <div key={device.assetId} className="flex items-center justify-between p-4 border rounded-lg">
                  <div className="flex items-center gap-4">
                    <div className={`h-2 w-2 rounded-full ${getStatusColor(device.status)}`} />
                    <div>
                      <div className="font-medium">{device.assetName}</div>
                      <div className="text-sm text-muted-foreground flex items-center gap-2">
                        <Badge variant="outline">{device.assetType}</Badge>
                        {device.lastSeen && (
                          <span>Last seen: {new Date(device.lastSeen).toLocaleString()}</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {getStatusIcon(device.status)}
                    <Badge variant={device.status === 'online' ? 'default' : device.status === 'warning' ? 'secondary' : 'destructive'}>
                      {device.status}
                    </Badge>
                  </div>
                </div>
              ))
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                No devices found. Register IoT devices to start monitoring.
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Device Type Distribution */}
      {devicesHealth && devicesHealth.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Device Type Distribution</CardTitle>
            <CardDescription>Breakdown of connected devices by type</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-4">
              {['solar', 'battery', 'meter', 'generator'].map((type) => {
                const count = devicesHealth.filter(d => d.assetType === type).length;
                const Icon = type === 'solar' ? Zap : type === 'battery' ? Battery : type === 'meter' ? Activity : Thermometer;
                
                return (
                  <div key={type} className="p-4 border rounded-lg">
                    <div className="flex items-center gap-2 mb-2">
                      <Icon className="h-4 w-4 text-primary" />
                      <div className="text-sm font-medium capitalize">{type}</div>
                    </div>
                    <div className="text-2xl font-bold">{count}</div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
