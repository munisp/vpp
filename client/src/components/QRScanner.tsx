import { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Camera, CameraOff, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';

interface QRScannerProps {
  onScan: (data: string) => void;
  onClose?: () => void;
  title?: string;
  description?: string;
}

export function QRScanner({ onScan, onClose, title = 'Scan QR Code', description }: QRScannerProps) {
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const qrCodeRegionId = 'qr-reader';

  const startScanning = async () => {
    try {
      setError(null);
      setIsScanning(true);

      // Initialize scanner
      if (!scannerRef.current) {
        scannerRef.current = new Html5Qrcode(qrCodeRegionId);
      }

      // Get cameras
      const devices = await Html5Qrcode.getCameras();
      if (!devices || devices.length === 0) {
        throw new Error('No cameras found');
      }

      // Prefer back camera on mobile
      const backCamera = devices.find(device => 
        device.label.toLowerCase().includes('back') || 
        device.label.toLowerCase().includes('rear')
      );
      const cameraId = backCamera?.id || devices[0].id;

      // Start scanning
      await scannerRef.current.start(
        cameraId,
        {
          fps: 10,
          qrbox: { width: 250, height: 250 },
        },
        (decodedText) => {
          // Success callback
          stopScanning();
          onScan(decodedText);
          toast.success('QR code scanned successfully');
        },
        (errorMessage) => {
          // Error callback (scanning errors, not critical)
          // console.log('Scan error:', errorMessage);
        }
      );
    } catch (err: any) {
      const errorMsg = err.message || 'Failed to start camera';
      setError(errorMsg);
      setIsScanning(false);
      toast.error(errorMsg);
    }
  };

  const stopScanning = async () => {
    try {
      if (scannerRef.current?.isScanning) {
        await scannerRef.current.stop();
      }
      setIsScanning(false);
    } catch (err) {
      console.error('Error stopping scanner:', err);
    }
  };

  const handleClose = async () => {
    await stopScanning();
    onClose?.();
  };

  useEffect(() => {
    return () => {
      // Cleanup on unmount
      if (scannerRef.current) {
        scannerRef.current.stop().catch(console.error);
      }
    };
  }, []);

  return (
    <Card className="w-full max-w-md mx-auto">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Camera className="h-5 w-5" />
              {title}
            </CardTitle>
            {description && <CardDescription>{description}</CardDescription>}
          </div>
          {onClose && (
            <Button variant="ghost" size="icon" onClick={handleClose}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Scanner Region */}
        <div className="relative">
          <div
            id={qrCodeRegionId}
            className="w-full aspect-square bg-black rounded-lg overflow-hidden"
          />
          {!isScanning && !error && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-lg">
              <div className="text-center text-white space-y-4">
                <CameraOff className="h-12 w-12 mx-auto opacity-50" />
                <p className="text-sm">Camera is off</p>
              </div>
            </div>
          )}
        </div>

        {/* Error Message */}
        {error && (
          <div className="p-4 bg-destructive/10 text-destructive rounded-lg text-sm">
            {error}
          </div>
        )}

        {/* Controls */}
        <div className="flex gap-2">
          {!isScanning ? (
            <Button onClick={startScanning} className="flex-1">
              <Camera className="mr-2 h-4 w-4" />
              Start Scanning
            </Button>
          ) : (
            <Button onClick={stopScanning} variant="destructive" className="flex-1">
              <CameraOff className="mr-2 h-4 w-4" />
              Stop Scanning
            </Button>
          )}
          {onClose && (
            <Button onClick={handleClose} variant="outline">
              Cancel
            </Button>
          )}
        </div>

        {/* Instructions */}
        <div className="text-sm text-muted-foreground space-y-1">
          <p className="font-medium">Instructions:</p>
          <ul className="list-disc list-inside space-y-1">
            <li>Position the QR code within the camera frame</li>
            <li>Hold steady until the code is detected</li>
            <li>Ensure good lighting for best results</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
