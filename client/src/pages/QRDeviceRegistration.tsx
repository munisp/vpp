import { useState } from 'react';
import { QRScanner } from '@/components/QRScanner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { QrCode, Zap, CheckCircle2, ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { useLocation } from 'wouter';
import { trpc } from '@/lib/trpc';

export default function QRDeviceRegistration() {
  const [, setLocation] = useLocation();
  const [showScanner, setShowScanner] = useState(false);
  const [scannedData, setScannedData] = useState<string | null>(null);
  const [deviceInfo, setDeviceInfo] = useState<any>(null);

  const registerDeviceMutation = trpc.assets.register.useMutation();

  const handleScan = (data: string) => {
    setScannedData(data);
    setShowScanner(false);

    // Parse QR code data
    try {
      // Expected format: vpp://device?id=DEV123&type=solar&capacity=5000
      const url = new URL(data);
      
      if (url.protocol === 'vpp:' && url.pathname === '//device') {
        const params = new URLSearchParams(url.search);
        setDeviceInfo({
          deviceId: params.get('id'),
          type: params.get('type') || 'solar',
          capacity: params.get('capacity') || '0',
          manufacturer: params.get('manufacturer') || 'Unknown',
          model: params.get('model') || 'Unknown',
        });
      } else {
        // Generic QR code - treat as device ID
        setDeviceInfo({
          deviceId: data,
          type: 'solar',
          capacity: '0',
          manufacturer: 'Unknown',
          model: 'Unknown',
        });
      }
    } catch (err) {
      // Not a URL, treat as device ID
      setDeviceInfo({
        deviceId: data,
        type: 'solar',
        capacity: '0',
        manufacturer: 'Unknown',
        model: 'Unknown',
      });
    }
  };

  const handleRegisterDevice = async () => {
    try {
      await registerDeviceMutation.mutateAsync({
        name: `${deviceInfo.type} - ${deviceInfo.deviceId}`,
        assetType: deviceInfo.type as 'solar' | 'battery' | 'meter' | 'generator' | 'wind',
        capacity: parseFloat(deviceInfo.capacity),
        make: deviceInfo.manufacturer,
        model: deviceInfo.model,
        serialNumber: deviceInfo.deviceId,
      });

      toast.success('Device registered successfully');
      setTimeout(() => {
        setLocation('/assets');
      }, 1500);
    } catch (error) {
      toast.error('Failed to register device');
    }
  };

  const handleReset = () => {
    setScannedData(null);
    setDeviceInfo(null);
    setShowScanner(false);
  };

  if (showScanner) {
    return (
      <div className="container max-w-2xl py-8">
        <QRScanner
          onScan={handleScan}
          onClose={() => setShowScanner(false)}
          title="Scan Device QR Code"
          description="Scan the QR code on your solar panel or battery"
        />
      </div>
    );
  }

  if (deviceInfo) {
    return (
      <div className="container max-w-2xl py-8 space-y-6">
        <Button variant="ghost" onClick={handleReset}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5" />
              Register Device
            </CardTitle>
            <CardDescription>Review device details before registering</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Device ID</Label>
              <Input
                value={deviceInfo.deviceId}
                onChange={(e) => setDeviceInfo({ ...deviceInfo, deviceId: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label>Device Type</Label>
              <Input
                value={deviceInfo.type}
                onChange={(e) => setDeviceInfo({ ...deviceInfo, type: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label>Capacity (kW)</Label>
              <Input
                type="number"
                value={deviceInfo.capacity}
                onChange={(e) => setDeviceInfo({ ...deviceInfo, capacity: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label>Manufacturer</Label>
              <Input
                value={deviceInfo.manufacturer}
                onChange={(e) => setDeviceInfo({ ...deviceInfo, manufacturer: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label>Model</Label>
              <Input
                value={deviceInfo.model}
                onChange={(e) => setDeviceInfo({ ...deviceInfo, model: e.target.value })}
              />
            </div>

            <div className="flex gap-2 pt-4">
              <Button
                onClick={handleRegisterDevice}
                className="flex-1"
                disabled={registerDeviceMutation.isPending}
              >
                <CheckCircle2 className="mr-2 h-4 w-4" />
                {registerDeviceMutation.isPending ? 'Registering...' : 'Register Device'}
              </Button>
              <Button onClick={handleReset} variant="outline">
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container max-w-2xl py-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">QR Device Registration</h1>
        <p className="text-muted-foreground mt-2">
          Quickly register your solar panels or batteries by scanning their QR code
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <QrCode className="h-5 w-5" />
            Quick Registration
          </CardTitle>
          <CardDescription>
            Use your camera to scan the device QR code
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button onClick={() => setShowScanner(true)} className="w-full" size="lg">
            <QrCode className="mr-2 h-5 w-5" />
            Scan Device QR Code
          </Button>

          <div className="text-sm text-muted-foreground space-y-2 pt-4 border-t">
            <p className="font-medium">Supported Devices:</p>
            <ul className="list-disc list-inside space-y-1">
              <li>Solar panels with QR identification</li>
              <li>Battery storage systems</li>
              <li>Smart inverters</li>
              <li>IoT energy meters</li>
            </ul>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-muted/50">
        <CardHeader>
          <CardTitle className="text-base">About QR Registration</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>
            QR registration makes it easy to add devices to your VPP account. Simply scan the
            QR code on your device and confirm the details.
          </p>
          <p>
            <strong>Note:</strong> After registration, your device will need to be verified by
            an administrator before it can participate in trading and demand response programs.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
