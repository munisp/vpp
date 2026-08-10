import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { QrCode, Download, Copy, RefreshCw } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function QRGenerator() {
  const [paymentType, setPaymentType] = useState<"merchant" | "p2p" | "bill" | "token">("merchant");
  const [currency, setCurrency] = useState<"NGN" | "TZS" | "USD">("NGN");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [merchantName, setMerchantName] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [billType, setBillType] = useState("");
  const [qrCodeUrl, setQrCodeUrl] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const recordGeneration = trpc.qrHistory.recordGeneration.useMutation();

  const handleGenerateQR = async () => {
    // Validate inputs
    if (!amount || parseFloat(amount) <= 0) {
      toast.error("Please enter a valid amount");
      return;
    }

    if (paymentType === "merchant" && !merchantName) {
      toast.error("Please enter merchant name");
      return;
    }

    if (paymentType === "p2p" && !recipientName) {
      toast.error("Please enter recipient name");
      return;
    }

    if (paymentType === "bill" && !billType) {
      toast.error("Please enter bill type");
      return;
    }

    setGenerating(true);

    try {
      // In production, call the QR code generation API
      // const response = await trpc.qr.generate.mutate({
      //   type: paymentType,
      //   amount: Math.round(parseFloat(amount) * 100),
      //   currency,
      //   merchantName,
      //   recipientName,
      //   billType,
      //   description,
      // });

      // Simulate QR code generation
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Mock QR code URL (in production, this would be the actual QR code image)
      const mockQrCode = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect fill='white' width='100' height='100'/%3E%3Ctext x='50' y='50' text-anchor='middle' font-size='8' fill='black'%3EQR Code%3C/text%3E%3C/svg%3E`;
      setQrCodeUrl(mockQrCode);

      // Record generation to history
      const qrData = {
        type: paymentType,
        amount: Math.round(parseFloat(amount) * 100),
        currency,
        merchantName,
        recipientName,
        billType,
        description,
      };

      await recordGeneration.mutateAsync({
        paymentType,
        amount: parseFloat(amount).toString(),
        currency,
        qrCodeData: JSON.stringify(qrData),
        qrCodeImage: mockQrCode,
        merchantName: merchantName || undefined,
        recipientName: recipientName || undefined,
        billType: billType || undefined,
        description: description || undefined,
      });

      toast.success("QR code generated successfully!");
    } catch (error) {
      toast.error("Failed to generate QR code");
    } finally {
      setGenerating(false);
    }
  };

  const handleDownloadQR = () => {
    if (!qrCodeUrl) return;

    const link = document.createElement("a");
    link.href = qrCodeUrl;
    link.download = `payment-qr-${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    toast.success("QR code downloaded!");
  };

  const handleCopyQRData = () => {
    const qrData = {
      type: paymentType,
      amount: Math.round(parseFloat(amount) * 100),
      currency,
      merchantName,
      recipientName,
      billType,
      description,
    };

    navigator.clipboard.writeText(JSON.stringify(qrData, null, 2));
    toast.success("QR data copied to clipboard!");
  };

  const handleReset = () => {
    setAmount("");
    setDescription("");
    setMerchantName("");
    setRecipientName("");
    setBillType("");
    setQrCodeUrl(null);
  };

  const formatCurrency = (value: string) => {
    if (!value) return "";
    const num = parseFloat(value);
    if (isNaN(num)) return "";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency === "NGN" ? "NGN" : currency === "TZS" ? "TZS" : "USD",
    }).format(num);
  };

  return (
    <div className="container py-8 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold">QR Code Generator</h1>
        <p className="text-muted-foreground mt-2">
          Create custom payment QR codes for your business
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Generator Form */}
        <Card>
          <CardHeader>
            <CardTitle>Generate Payment QR Code</CardTitle>
            <CardDescription>
              Fill in the payment details to create a scannable QR code
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs value={paymentType} onValueChange={(v) => setPaymentType(v as typeof paymentType)}>
              <TabsList className="grid w-full grid-cols-4">
                <TabsTrigger value="merchant">Merchant</TabsTrigger>
                <TabsTrigger value="p2p">P2P</TabsTrigger>
                <TabsTrigger value="bill">Bill</TabsTrigger>
                <TabsTrigger value="token">Token</TabsTrigger>
              </TabsList>

              <div className="space-y-4 mt-6">
                {/* Common Fields */}
                <div className="space-y-2">
                  <Label htmlFor="amount">Amount *</Label>
                  <Input
                    id="amount"
                    type="number"
                    placeholder="0.00"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    min="0"
                    step="0.01"
                  />
                  {amount && (
                    <p className="text-xs text-muted-foreground">
                      {formatCurrency(amount)}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="currency">Currency</Label>
                  <Select value={currency} onValueChange={(v) => setCurrency(v as typeof currency)}>
                    <SelectTrigger id="currency">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="NGN">Nigerian Naira (NGN)</SelectItem>
                      <SelectItem value="TZS">Tanzanian Shilling (TZS)</SelectItem>
                      <SelectItem value="USD">US Dollar (USD)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Type-specific Fields */}
                <TabsContent value="merchant" className="space-y-4 mt-0">
                  <div className="space-y-2">
                    <Label htmlFor="merchantName">Merchant Name *</Label>
                    <Input
                      id="merchantName"
                      placeholder="Your Business Name"
                      value={merchantName}
                      onChange={(e) => setMerchantName(e.target.value)}
                    />
                  </div>
                </TabsContent>

                <TabsContent value="p2p" className="space-y-4 mt-0">
                  <div className="space-y-2">
                    <Label htmlFor="recipientName">Recipient Name *</Label>
                    <Input
                      id="recipientName"
                      placeholder="Recipient's Name"
                      value={recipientName}
                      onChange={(e) => setRecipientName(e.target.value)}
                    />
                  </div>
                </TabsContent>

                <TabsContent value="bill" className="space-y-4 mt-0">
                  <div className="space-y-2">
                    <Label htmlFor="billType">Bill Type *</Label>
                    <Select value={billType} onValueChange={setBillType}>
                      <SelectTrigger id="billType">
                        <SelectValue placeholder="Select bill type" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="electricity">Electricity</SelectItem>
                        <SelectItem value="water">Water</SelectItem>
                        <SelectItem value="internet">Internet</SelectItem>
                        <SelectItem value="phone">Phone</SelectItem>
                        <SelectItem value="gas">Gas</SelectItem>
                        <SelectItem value="other">Other</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </TabsContent>

                <TabsContent value="token" className="space-y-4 mt-0">
                  <p className="text-sm text-muted-foreground">
                    Generate a QR code for energy token purchase
                  </p>
                </TabsContent>

                <div className="space-y-2">
                  <Label htmlFor="description">Description (Optional)</Label>
                  <Textarea
                    id="description"
                    placeholder="Add a note or description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={3}
                  />
                </div>

                <div className="flex gap-2">
                  <Button
                    onClick={handleGenerateQR}
                    disabled={generating}
                    className="flex-1 gap-2"
                  >
                    {generating ? (
                      <>
                        <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        Generating...
                      </>
                    ) : (
                      <>
                        <QrCode className="h-4 w-4" />
                        Generate QR Code
                      </>
                    )}
                  </Button>
                  <Button variant="outline" onClick={handleReset}>
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </Tabs>
          </CardContent>
        </Card>

        {/* QR Code Display */}
        <Card>
          <CardHeader>
            <CardTitle>Generated QR Code</CardTitle>
            <CardDescription>
              {qrCodeUrl
                ? "Your QR code is ready to use"
                : "Generate a QR code to see it here"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {qrCodeUrl ? (
              <div className="space-y-4">
                {/* QR Code Display */}
                <div className="aspect-square bg-white rounded-lg border-2 border-border p-8 flex items-center justify-center">
                  <img
                    src={qrCodeUrl}
                    alt="Payment QR Code"
                    className="w-full h-full object-contain"
                  />
                </div>

                {/* Payment Details */}
                <div className="space-y-2 p-4 bg-muted rounded-lg">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Type:</span>
                    <span className="font-medium capitalize">{paymentType}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Amount:</span>
                    <span className="font-medium">{formatCurrency(amount)}</span>
                  </div>
                  {merchantName && (
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Merchant:</span>
                      <span className="font-medium">{merchantName}</span>
                    </div>
                  )}
                  {recipientName && (
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Recipient:</span>
                      <span className="font-medium">{recipientName}</span>
                    </div>
                  )}
                  {billType && (
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Bill Type:</span>
                      <span className="font-medium capitalize">{billType}</span>
                    </div>
                  )}
                </div>

                {/* Action Buttons */}
                <div className="flex gap-2">
                  <Button onClick={handleDownloadQR} className="flex-1 gap-2">
                    <Download className="h-4 w-4" />
                    Download
                  </Button>
                  <Button variant="outline" onClick={handleCopyQRData} className="gap-2">
                    <Copy className="h-4 w-4" />
                    Copy Data
                  </Button>
                </div>

                <p className="text-xs text-muted-foreground text-center">
                  This QR code expires in 15 minutes for security
                </p>
              </div>
            ) : (
              <div className="aspect-square flex items-center justify-center bg-muted rounded-lg">
                <div className="text-center space-y-2">
                  <QrCode className="h-16 w-16 mx-auto text-muted-foreground" />
                  <p className="text-muted-foreground">No QR code generated yet</p>
                  <p className="text-sm text-muted-foreground">
                    Fill in the form and click Generate
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Usage Instructions */}
      <Card>
        <CardHeader>
          <CardTitle>How to Use</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground">
            <li>Select the payment type (Merchant, P2P, Bill, or Token)</li>
            <li>Enter the amount and currency</li>
            <li>Fill in the required details based on payment type</li>
            <li>Click "Generate QR Code" to create your payment QR code</li>
            <li>Download the QR code or display it for customers to scan</li>
            <li>Customers can scan the code with their phone to complete payment</li>
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
