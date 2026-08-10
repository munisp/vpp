import React, { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { Activity, AlertCircle, CheckCircle, XCircle, Loader2, Plus, Send, Eye, Trash2 } from 'lucide-react';

export default function DeviceManagement() {
  const [selectedDevice, setSelectedDevice] = useState<number | null>(null);
  const [showRegisterDialog, setShowRegisterDialog] = useState(false);
  const [showCommandDialog, setShowCommandDialog] = useState(false);
  const [showLogsDialog, setShowLogsDialog] = useState(false);

  const { data: devicesData, isLoading } = trpc.devices.list.useQuery();
  const { data: stats } = trpc.devices.getStats.useQuery();
  const { data: logsData } = trpc.devices.getLogs.useQuery(
    { deviceId: selectedDevice! },
    { enabled: !!selectedDevice && showLogsDialog }
  );

  const utils = trpc.useUtils();

  const deleteMutation = trpc.devices.delete.useMutation({
    onSuccess: () => {
      toast.success('Device deleted successfully');
      utils.devices.list.invalidate();
      utils.devices.getStats.invalidate();
    },
    onError: (error) => {
      toast.error(`Failed to delete device: ${error.message}`);
    },
  });

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'online':
        return <CheckCircle className="h-5 w-5 text-green-600" />;
      case 'offline':
        return <XCircle className="h-5 w-5 text-gray-400" />;
      case 'error':
        return <AlertCircle className="h-5 w-5 text-red-600" />;
      case 'maintenance':
        return <Activity className="h-5 w-5 text-yellow-600" />;
      default:
        return <XCircle className="h-5 w-5 text-gray-400" />;
    }
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
      online: 'default',
      offline: 'secondary',
      error: 'destructive',
      maintenance: 'outline',
    };
    return (
      <Badge variant={variants[status] || 'secondary'}>
        {status}
      </Badge>
    );
  };

  return (
    <div className="container py-8">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold">Device Management</h1>
          <p className="text-muted-foreground mt-2">
            Manage IoT devices connected to the VPP platform
          </p>
        </div>
        <Dialog open={showRegisterDialog} onOpenChange={setShowRegisterDialog}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Register Device
            </Button>
          </DialogTrigger>
          <DialogContent>
            <RegisterDeviceForm
              onSuccess={() => {
                setShowRegisterDialog(false);
                utils.devices.list.invalidate();
                utils.devices.getStats.invalidate();
              }}
            />
          </DialogContent>
        </Dialog>
      </div>

      {/* Statistics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-8">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Devices</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.total || 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Online</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{stats?.online || 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Offline</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-gray-400">{stats?.offline || 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Error</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{stats?.error || 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Maintenance</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-600">{stats?.maintenance || 0}</div>
          </CardContent>
        </Card>
      </div>

      {/* Devices List */}
      {isLoading ? (
        <div className="flex justify-center items-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {devicesData?.devices.map((device) => (
            <Card key={device.id}>
              <CardHeader>
                <div className="flex justify-between items-start">
                  <div className="flex items-center gap-3">
                    {getStatusIcon(device.status)}
                    <div>
                      <CardTitle>{device.deviceId}</CardTitle>
                      <CardDescription>
                        {device.manufacturer} {device.model} • {device.deviceType}
                      </CardDescription>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {getStatusBadge(device.status)}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                  <div>
                    <p className="text-sm text-muted-foreground">Asset ID</p>
                    <p className="font-medium">{device.assetId}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Firmware</p>
                    <p className="font-medium">{device.firmwareVersion || 'N/A'}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Telemetry Interval</p>
                    <p className="font-medium">{device.telemetryInterval}s</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Last Seen</p>
                    <p className="font-medium">
                      {device.lastSeen
                        ? new Date(device.lastSeen).toLocaleString()
                        : 'Never'}
                    </p>
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSelectedDevice(device.id);
                      setShowCommandDialog(true);
                    }}
                  >
                    <Send className="h-4 w-4 mr-2" />
                    Send Command
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSelectedDevice(device.id);
                      setShowLogsDialog(true);
                    }}
                  >
                    <Eye className="h-4 w-4 mr-2" />
                    View Logs
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => deleteMutation.mutate({ id: device.id })}
                    disabled={deleteMutation.isPending}
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}

          {devicesData?.devices.length === 0 && (
            <Card>
              <CardContent className="py-12 text-center">
                <p className="text-muted-foreground">
                  No devices registered yet. Click "Register Device" to add your first device.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Command Dialog */}
      <Dialog open={showCommandDialog} onOpenChange={setShowCommandDialog}>
        <DialogContent>
          <SendCommandForm
            deviceId={selectedDevice!}
            onSuccess={() => {
              setShowCommandDialog(false);
              toast.success('Command sent successfully');
            }}
          />
        </DialogContent>
      </Dialog>

      {/* Logs Dialog */}
      <Dialog open={showLogsDialog} onOpenChange={setShowLogsDialog}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Device Logs</DialogTitle>
            <DialogDescription>
              Recent events and messages from this device
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {logsData?.logs.map((log) => (
              <div key={log.id} className="border-l-4 border-gray-200 pl-4 py-2">
                <div className="flex justify-between items-start">
                  <div>
                    <Badge variant={log.eventType === 'error' ? 'destructive' : 'default'}>
                      {log.eventType}
                    </Badge>
                    <p className="mt-1">{log.message}</p>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {new Date(log.createdAt).toLocaleString()}
                  </p>
                </div>
              </div>
            ))}
            {logsData?.logs.length === 0 && (
              <p className="text-center text-muted-foreground py-8">No logs available</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RegisterDeviceForm({ onSuccess }: { onSuccess: () => void }) {
  const [formData, setFormData] = useState({
    assetId: '',
    deviceId: '',
    deviceType: 'smart_meter' as const,
    manufacturer: '',
    model: '',
    firmwareVersion: '',
    telemetryInterval: '5',
  });

  const registerMutation = trpc.devices.register.useMutation({
    onSuccess: (data) => {
      toast.success('Device registered successfully');
      // Show credentials in a separate dialog
      alert(`Device registered!\n\nMQTT Credentials (save these securely):\nUsername: ${data.mqttCredentials.username}\nPassword: ${data.mqttCredentials.password}`);
      onSuccess();
    },
    onError: (error) => {
      toast.error(`Failed to register device: ${error.message}`);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    registerMutation.mutate({
      assetId: parseInt(formData.assetId),
      deviceId: formData.deviceId,
      deviceType: formData.deviceType,
      manufacturer: formData.manufacturer || undefined,
      model: formData.model || undefined,
      firmwareVersion: formData.firmwareVersion || undefined,
      telemetryInterval: parseInt(formData.telemetryInterval),
    });
  };

  return (
    <form onSubmit={handleSubmit}>
      <DialogHeader>
        <DialogTitle>Register New Device</DialogTitle>
        <DialogDescription>
          Add a new IoT device to the platform
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 py-4">
        <div className="grid gap-2">
          <Label htmlFor="assetId">Asset ID *</Label>
          <Input
            id="assetId"
            type="number"
            value={formData.assetId}
            onChange={(e) => setFormData({ ...formData, assetId: e.target.value })}
            required
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="deviceId">Device ID *</Label>
          <Input
            id="deviceId"
            value={formData.deviceId}
            onChange={(e) => setFormData({ ...formData, deviceId: e.target.value })}
            placeholder="e.g., SM-12345"
            required
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="deviceType">Device Type *</Label>
          <Select
            value={formData.deviceType}
            onValueChange={(value: any) => setFormData({ ...formData, deviceType: value })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="smart_meter">Smart Meter</SelectItem>
              <SelectItem value="inverter">Inverter</SelectItem>
              <SelectItem value="battery_controller">Battery Controller</SelectItem>
              <SelectItem value="sensor">Sensor</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="manufacturer">Manufacturer</Label>
          <Input
            id="manufacturer"
            value={formData.manufacturer}
            onChange={(e) => setFormData({ ...formData, manufacturer: e.target.value })}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="model">Model</Label>
          <Input
            id="model"
            value={formData.model}
            onChange={(e) => setFormData({ ...formData, model: e.target.value })}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="firmwareVersion">Firmware Version</Label>
          <Input
            id="firmwareVersion"
            value={formData.firmwareVersion}
            onChange={(e) => setFormData({ ...formData, firmwareVersion: e.target.value })}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="telemetryInterval">Telemetry Interval (seconds)</Label>
          <Input
            id="telemetryInterval"
            type="number"
            value={formData.telemetryInterval}
            onChange={(e) => setFormData({ ...formData, telemetryInterval: e.target.value })}
          />
        </div>
      </div>
      <DialogFooter>
        <Button type="submit" disabled={registerMutation.isPending}>
          {registerMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Register Device
        </Button>
      </DialogFooter>
    </form>
  );
}

function SendCommandForm({ deviceId, onSuccess }: { deviceId: number; onSuccess: () => void }) {
  const [command, setCommand] = useState('');
  const [payload, setPayload] = useState('{}');

  const sendCommandMutation = trpc.devices.sendCommand.useMutation({
    onSuccess: () => {
      onSuccess();
    },
    onError: (error) => {
      toast.error(`Failed to send command: ${error.message}`);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const parsedPayload = JSON.parse(payload);
      sendCommandMutation.mutate({
        deviceId,
        command,
        payload: parsedPayload,
      });
    } catch (error) {
      toast.error('Invalid JSON payload');
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <DialogHeader>
        <DialogTitle>Send Command to Device</DialogTitle>
        <DialogDescription>
          Execute a command on the selected device
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 py-4">
        <div className="grid gap-2">
          <Label htmlFor="command">Command *</Label>
          <Select value={command} onValueChange={setCommand}>
            <SelectTrigger>
              <SelectValue placeholder="Select command" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="reset">Reset</SelectItem>
              <SelectItem value="update_interval">Update Interval</SelectItem>
              <SelectItem value="calibrate">Calibrate</SelectItem>
              <SelectItem value="firmware_update">Firmware Update</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="payload">Payload (JSON)</Label>
          <textarea
            id="payload"
            className="min-h-[100px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
          />
        </div>
      </div>
      <DialogFooter>
        <Button type="submit" disabled={sendCommandMutation.isPending || !command}>
          {sendCommandMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Send Command
        </Button>
      </DialogFooter>
    </form>
  );
}
