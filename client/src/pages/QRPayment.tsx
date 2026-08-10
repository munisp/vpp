import { useState } from 'react';
import { QRScanner } from '@/components/QRScanner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { QrCode, Wallet, CheckCircle2, ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { useLocation } from 'wouter';
import { trpc } from '@/lib/trpc';
import { useAuth } from '@/_core/hooks/useAuth';

export default function QRPayment() {
  const [, setLocation] = useLocation();
  const [showScanner, setShowScanner] = useState(false);
  const [scannedData, setScannedData] = useState<string | null>(null);
  const [paymentDetails, setPaymentDetails] = useState<any>(null);

  const handleScan = (data: string) => {
    setScannedData(data);
    setShowScanner(false);

    // Parse QR code data
    try {
      // Expected format: vpp://payment?amount=100&recipient=user123&reference=inv-001
      const url = new URL(data);
      
      if (url.protocol === 'vpp:' && url.pathname === '//payment') {
        const params = new URLSearchParams(url.search);
        setPaymentDetails({
          amount: params.get('amount'),
          recipient: params.get('recipient'),
          reference: params.get('reference'),
          description: params.get('description') || 'Payment via QR code',
        });
      } else {
        // Generic QR code
        setPaymentDetails({
          rawData: data,
        });
      }
    } catch (err) {
      // Not a URL, treat as raw data
      setPaymentDetails({
        rawData: data,
      });
    }
  };

  const [processing, setProcessing] = useState(false);
  const initiatePayment = trpc.payments.initiate.useMutation();
  const { user } = useAuth();

  const handleProcessPayment = async () => {
    if (!paymentDetails || !paymentDetails.amount) {
      toast.error('No payment details available');
      return;
    }
    setProcessing(true);
    try {
      const amountCents = Math.round(parseFloat(paymentDetails.amount) * 100);
      const result = await initiatePayment.mutateAsync({
        paymentType: 'invoice',
        amount: amountCents,
        paymentMethod: 'mpesa',
        phoneNumber: user?.phone || '',
        accountNumber: paymentDetails.reference || undefined,
      });
      if (result.success) {
        toast.success('Payment initiated successfully. Check your phone to complete the payment.');
        setTimeout(() => setLocation('/payments'), 2000);
      } else {
        toast.error('Failed to initiate payment');
      }
    } catch (error) {
      toast.error('Payment failed. Please try again.');
    } finally {
      setProcessing(false);
    }
  };

  const handleReset = () => {
    setScannedData(null);
    setPaymentDetails(null);
    setShowScanner(false);
  };

  if (showScanner) {
    return (
      <div className="container max-w-2xl py-8">
        <QRScanner
          onScan={handleScan}
          onClose={() => setShowScanner(false)}
          title="Scan Payment QR Code"
          description="Position the QR code within the camera frame"
        />
      </div>
    );
  }

  if (paymentDetails) {
    return (
      <div className="container max-w-2xl py-8 space-y-6">
        <Button variant="ghost" onClick={handleReset}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wallet className="h-5 w-5" />
              Confirm Payment
            </CardTitle>
            <CardDescription>Review payment details before confirming</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {paymentDetails.amount && (
              <div className="space-y-2">
                <Label>Amount</Label>
                <div className="text-3xl font-bold">${paymentDetails.amount}</div>
              </div>
            )}

            {paymentDetails.recipient && (
              <div className="space-y-2">
                <Label>Recipient</Label>
                <Input value={paymentDetails.recipient} readOnly />
              </div>
            )}

            {paymentDetails.reference && (
              <div className="space-y-2">
                <Label>Reference</Label>
                <Input value={paymentDetails.reference} readOnly />
              </div>
            )}

            {paymentDetails.description && (
              <div className="space-y-2">
                <Label>Description</Label>
                <Input value={paymentDetails.description} readOnly />
              </div>
            )}

            {paymentDetails.rawData && !paymentDetails.amount && (
              <div className="space-y-2">
                <Label>Scanned Data</Label>
                <div className="p-4 bg-muted rounded-lg font-mono text-sm break-all">
                  {paymentDetails.rawData}
                </div>
              </div>
            )}

            <div className="flex gap-2 pt-4">
              <Button onClick={handleProcessPayment} className="flex-1">
                <CheckCircle2 className="mr-2 h-4 w-4" />
                Confirm Payment
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
        <h1 className="text-3xl font-bold">QR Payment</h1>
        <p className="text-muted-foreground mt-2">
          Scan a QR code to make a quick payment
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <QrCode className="h-5 w-5" />
            Quick Payment
          </CardTitle>
          <CardDescription>
            Use your camera to scan a payment QR code
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button onClick={() => setShowScanner(true)} className="w-full" size="lg">
            <QrCode className="mr-2 h-5 w-5" />
            Scan QR Code
          </Button>

          <div className="text-sm text-muted-foreground space-y-2 pt-4 border-t">
            <p className="font-medium">Supported QR Codes:</p>
            <ul className="list-disc list-inside space-y-1">
              <li>VPP payment codes from other users</li>
              <li>Merchant payment codes</li>
              <li>Invoice QR codes</li>
              <li>Energy trading payment codes</li>
            </ul>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-muted/50">
        <CardHeader>
          <CardTitle className="text-base">About QR Payments</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>
            QR payments provide a fast and secure way to send money. Simply scan the recipient's
            QR code and confirm the payment details.
          </p>
          <p>
            <strong>Security:</strong> Always verify the payment amount and recipient before
            confirming. QR payments are processed immediately and cannot be reversed.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
