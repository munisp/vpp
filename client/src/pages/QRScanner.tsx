import { useState, useRef, useEffect } from "react";
import jsQR from "jsqr";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Camera, X, CheckCircle, AlertCircle, QrCode, Upload } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

interface QRPaymentData {
  type: "merchant" | "p2p" | "bill" | "token";
  amount: number;
  currency: "NGN" | "TZS" | "USD";
  merchantId?: string;
  merchantName?: string;
  recipientId?: string;
  recipientName?: string;
  billId?: string;
  billType?: string;
  reference?: string;
  description?: string;
  expiresAt?: string;
}

export default function QRScanner() {
  const [scanning, setScanning] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [scannedData, setScannedData] = useState<QRPaymentData | null>(null);
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [processing, setProcessing] = useState(false);
  const recordScan = trpc.qrHistory.recordScan.useMutation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanIntervalRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, []);

  const startCamera = async () => {
    try {
      setCameraError(null);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        streamRef.current = stream;
        setScanning(true);

        // Start scanning for QR codes
        scanIntervalRef.current = window.setInterval(() => {
          scanQRCode();
        }, 500);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to access camera";
      setCameraError(errorMessage);
      toast.error("Camera access denied. Please enable camera permissions.");
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (scanIntervalRef.current) {
      clearInterval(scanIntervalRef.current);
      scanIntervalRef.current = null;
    }
    setScanning(false);
  };

  const scanQRCode = () => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");

    if (!context || video.readyState !== video.HAVE_ENOUGH_DATA) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Use jsQR to scan for QR codes
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(imageData.data, imageData.width, imageData.height);
    
    if (code) {
      handleQRCodeDetected(code.data);
    }
  };

  const handleQRCodeDetected = (qrData: string) => {
    try {
      const data: QRPaymentData = JSON.parse(qrData);

      // Validate QR code data
      if (!data.type || !data.amount || !data.currency) {
        throw new Error("Invalid QR code data");
      }

      // Check expiration
      if (data.expiresAt && new Date(data.expiresAt) < new Date()) {
        throw new Error("QR code has expired");
      }

      setScannedData(data);
      setConfirmDialogOpen(true);
      stopCamera();
      toast.success("QR code scanned successfully!");
    } catch (err) {
      toast.error("Invalid QR code. Please try again.");
    }
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // In a real implementation, you would:
    // 1. Read the image file
    // 2. Use a QR code library to decode it
    // 3. Process the decoded data

    toast.info("QR code image upload is not yet implemented");
  };

  const handleConfirmPayment = async () => {
    if (!scannedData) return;

    setProcessing(true);

    try {
      // Record the scan to history
      await recordScan.mutateAsync({
        paymentType: scannedData.type,
        amount: (scannedData.amount / 100).toString(),
        currency: scannedData.currency,
        qrCodeData: JSON.stringify(scannedData),
        merchantId: scannedData.merchantId,
        merchantName: scannedData.merchantName,
        recipientId: scannedData.recipientId,
        recipientName: scannedData.recipientName,
        billId: scannedData.billId,
        billType: scannedData.billType,
        reference: scannedData.reference,
        description: scannedData.description,
      });

      // In a real implementation, you would:
      // 1. Call the payment API with scannedData
      // 2. Process the payment
      // 3. Show success/failure

      // Simulate payment processing
      await new Promise((resolve) => setTimeout(resolve, 2000));

      toast.success("Payment processed successfully!");
      setConfirmDialogOpen(false);
      setScannedData(null);
    } catch (err) {
      toast.error("Payment failed. Please try again.");
    } finally {
      setProcessing(false);
    }
  };

  const formatCurrency = (amount: number, currency: string) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency === "NGN" ? "NGN" : currency === "TZS" ? "TZS" : "USD",
    }).format(amount / 100);
  };

  const getPaymentTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      merchant: "Merchant Payment",
      p2p: "P2P Transfer",
      bill: "Bill Payment",
      token: "Token Purchase",
    };
    return labels[type] || type;
  };

  return (
    <div className="container py-4 md:py-8 space-y-4 md:space-y-6 px-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">QR Payment Scanner</h1>
          <p className="text-muted-foreground mt-2">
            Scan QR codes to make quick and secure payments
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => window.location.href = "/qr-generator"}
          className="gap-2"
        >
          <QrCode className="h-4 w-4" />
          Generate QR Code
        </Button>
      </div>

      {/* Scanner Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <QrCode className="h-5 w-5" />
            Scan QR Code
          </CardTitle>
          <CardDescription>
            Point your camera at a payment QR code to scan
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {cameraError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{cameraError}</AlertDescription>
            </Alert>
          )}

          {/* Camera View */}
          <div className="relative aspect-video bg-muted rounded-lg overflow-hidden">
            {scanning ? (
              <>
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  className="w-full h-full object-cover"
                />
                <canvas ref={canvasRef} className="hidden" />
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-64 h-64 border-4 border-primary rounded-lg animate-pulse" />
                </div>
                <Button
                  variant="destructive"
                  size="icon"
                  className="absolute top-4 right-4"
                  onClick={stopCamera}
                >
                  <X className="h-4 w-4" />
                </Button>
              </>
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <div className="text-center space-y-4">
                  <QrCode className="h-16 w-16 mx-auto text-muted-foreground" />
                  <p className="text-muted-foreground">Camera not active</p>
                </div>
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div className="flex flex-col sm:flex-row gap-2 w-full">
            {!scanning ? (
              <>
                <Button onClick={startCamera} className="flex-1 gap-2">
                  <Camera className="h-4 w-4" />
                  Start Camera
                </Button>
                <Button variant="outline" className="gap-2" asChild>
                  <label htmlFor="qr-upload" className="cursor-pointer">
                    <Upload className="h-4 w-4" />
                    Upload Image
                    <input
                      id="qr-upload"
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={handleFileUpload}
                    />
                  </label>
                </Button>
              </>
            ) : (
              <Button onClick={stopCamera} variant="destructive" className="w-full gap-2">
                <X className="h-4 w-4" />
                Stop Scanning
              </Button>
            )}
          </div>

          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Make sure the QR code is well-lit and centered in the camera view
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {/* How to Use */}
      <Card>
        <CardHeader>
          <CardTitle>How to Use</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground">
            <li>Click "Start Camera" to activate your device camera</li>
            <li>Point the camera at a payment QR code</li>
            <li>Hold steady until the QR code is detected</li>
            <li>Review the payment details and confirm</li>
            <li>Your payment will be processed securely</li>
          </ol>
        </CardContent>
      </Card>

      {/* Payment Confirmation Dialog */}
      <Dialog open={confirmDialogOpen} onOpenChange={setConfirmDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Payment</DialogTitle>
            <DialogDescription>
              Please review the payment details before confirming
            </DialogDescription>
          </DialogHeader>

          {scannedData && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Payment Type</span>
                <Badge>{getPaymentTypeLabel(scannedData.type)}</Badge>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Amount</span>
                <span className="text-2xl font-bold">
                  {formatCurrency(scannedData.amount, scannedData.currency)}
                </span>
              </div>

              {scannedData.merchantName && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Merchant</span>
                  <span className="font-medium">{scannedData.merchantName}</span>
                </div>
              )}

              {scannedData.recipientName && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Recipient</span>
                  <span className="font-medium">{scannedData.recipientName}</span>
                </div>
              )}

              {scannedData.billType && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Bill Type</span>
                  <span className="font-medium capitalize">{scannedData.billType}</span>
                </div>
              )}

              {scannedData.description && (
                <div className="space-y-1">
                  <span className="text-sm text-muted-foreground">Description</span>
                  <p className="text-sm">{scannedData.description}</p>
                </div>
              )}

              {scannedData.reference && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Reference</span>
                  <code className="text-xs">{scannedData.reference}</code>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setConfirmDialogOpen(false);
                setScannedData(null);
              }}
              disabled={processing}
            >
              Cancel
            </Button>
            <Button onClick={handleConfirmPayment} disabled={processing} className="gap-2">
              {processing ? (
                <>
                  <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Processing...
                </>
              ) : (
                <>
                  <CheckCircle className="h-4 w-4" />
                  Confirm Payment
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
