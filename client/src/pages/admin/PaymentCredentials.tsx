import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { CreditCard, Plus, Check, X, AlertCircle, Eye, Trash2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

type Gateway = "mpesa" | "airtel" | "tigo";

export default function PaymentCredentials() {
  const [selectedGateway, setSelectedGateway] = useState<Gateway>("mpesa");
  const [environment, setEnvironment] = useState<"sandbox" | "production">("sandbox");
  const [dialogOpen, setDialogOpen] = useState(false);
  
  // M-Pesa form state
  const [mpesaConsumerKey, setMpesaConsumerKey] = useState("");
  const [mpesaConsumerSecret, setMpesaConsumerSecret] = useState("");
  const [mpesaShortcode, setMpesaShortcode] = useState("");
  const [mpesaPasskey, setMpesaPasskey] = useState("");
  const [mpesaCallback, setMpesaCallback] = useState("");
  
  // Airtel form state
  const [airtelClientId, setAirtelClientId] = useState("");
  const [airtelClientSecret, setAirtelClientSecret] = useState("");
  const [airtelMerchantCode, setAirtelMerchantCode] = useState("");
  const [airtelCallback, setAirtelCallback] = useState("");
  
  // Tigo form state
  const [tigoApiKey, setTigoApiKey] = useState("");
  const [tigoApiSecret, setTigoApiSecret] = useState("");
  const [tigoMerchantNumber, setTigoMerchantNumber] = useState("");
  const [tigoCallback, setTigoCallback] = useState("");

  const utils = trpc.useUtils();
  
  // Queries
  const { data: credentials = [], isLoading } = trpc.paymentCredentials.list.useQuery();

  // Mutations
  const saveMpesaMutation = trpc.paymentCredentials.saveMpesa.useMutation({
    onSuccess: () => {
      toast.success("M-Pesa credentials saved successfully!");
      utils.paymentCredentials.list.invalidate();
      setDialogOpen(false);
      resetMpesaForm();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const saveAirtelMutation = trpc.paymentCredentials.saveAirtel.useMutation({
    onSuccess: () => {
      toast.success("Airtel Money credentials saved successfully!");
      utils.paymentCredentials.list.invalidate();
      setDialogOpen(false);
      resetAirtelForm();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const saveTigoMutation = trpc.paymentCredentials.saveTigo.useMutation({
    onSuccess: () => {
      toast.success("Tigo Pesa credentials saved successfully!");
      utils.paymentCredentials.list.invalidate();
      setDialogOpen(false);
      resetTigoForm();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const validateMutation = trpc.paymentCredentials.validate.useMutation({
    onSuccess: () => {
      toast.success("Credentials validated successfully!");
      utils.paymentCredentials.list.invalidate();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const toggleActiveMutation = trpc.paymentCredentials.toggleActive.useMutation({
    onSuccess: () => {
      toast.success("Status updated!");
      utils.paymentCredentials.list.invalidate();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const deleteMutation = trpc.paymentCredentials.delete.useMutation({
    onSuccess: () => {
      toast.success("Credentials deleted!");
      utils.paymentCredentials.list.invalidate();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const resetMpesaForm = () => {
    setMpesaConsumerKey("");
    setMpesaConsumerSecret("");
    setMpesaShortcode("");
    setMpesaPasskey("");
    setMpesaCallback("");
  };

  const resetAirtelForm = () => {
    setAirtelClientId("");
    setAirtelClientSecret("");
    setAirtelMerchantCode("");
    setAirtelCallback("");
  };

  const resetTigoForm = () => {
    setTigoApiKey("");
    setTigoApiSecret("");
    setTigoMerchantNumber("");
    setTigoCallback("");
  };

  const handleSave = () => {
    if (selectedGateway === "mpesa") {
      if (!mpesaConsumerKey || !mpesaConsumerSecret || !mpesaShortcode || !mpesaPasskey || !mpesaCallback) {
        toast.error("Please fill in all M-Pesa fields");
        return;
      }
      
      saveMpesaMutation.mutate({
        environment,
        credentials: {
          consumerKey: mpesaConsumerKey,
          consumerSecret: mpesaConsumerSecret,
          shortcode: mpesaShortcode,
          passkey: mpesaPasskey,
          callbackUrl: mpesaCallback,
        },
      });
    } else if (selectedGateway === "airtel") {
      if (!airtelClientId || !airtelClientSecret || !airtelMerchantCode || !airtelCallback) {
        toast.error("Please fill in all Airtel Money fields");
        return;
      }
      
      saveAirtelMutation.mutate({
        environment,
        credentials: {
          clientId: airtelClientId,
          clientSecret: airtelClientSecret,
          merchantCode: airtelMerchantCode,
          callbackUrl: airtelCallback,
        },
      });
    } else if (selectedGateway === "tigo") {
      if (!tigoApiKey || !tigoApiSecret || !tigoMerchantNumber || !tigoCallback) {
        toast.error("Please fill in all Tigo Pesa fields");
        return;
      }
      
      saveTigoMutation.mutate({
        environment,
        credentials: {
          apiKey: tigoApiKey,
          apiSecret: tigoApiSecret,
          merchantNumber: tigoMerchantNumber,
          callbackUrl: tigoCallback,
        },
      });
    }
  };

  const getGatewayName = (gateway: string) => {
    switch (gateway) {
      case "mpesa": return "M-Pesa";
      case "airtel_money": return "Airtel Money";
      case "tigo_pesa": return "Tigo Pesa";
      default: return gateway;
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold">Payment Gateway Credentials</h1>
            <p className="text-muted-foreground mt-2">
              Manage API credentials for mobile money payment gateways
            </p>
          </div>
          <Button onClick={() => setDialogOpen(true)} size="lg">
            <Plus className="h-4 w-4 mr-2" />
            Add Credentials
          </Button>
        </div>

        {/* Credentials List */}
        <div className="grid gap-4">
          {isLoading ? (
            <>
              <Skeleton className="h-32" />
              <Skeleton className="h-32" />
              <Skeleton className="h-32" />
            </>
          ) : credentials.length === 0 ? (
            <Card>
              <CardContent className="py-12">
                <div className="text-center">
                  <CreditCard className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                  <h3 className="text-lg font-semibold mb-2">No credentials configured</h3>
                  <p className="text-muted-foreground mb-4">
                    Add payment gateway credentials to enable real transactions
                  </p>
                  <Button onClick={() => setDialogOpen(true)}>
                    <Plus className="h-4 w-4 mr-2" />
                    Add Credentials
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            credentials.map((cred) => (
              <Card key={cred.id}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <CreditCard className="h-5 w-5" />
                      <div>
                        <CardTitle>{getGatewayName(cred.gateway)}</CardTitle>
                        <CardDescription>
                          {cred.environment === "sandbox" ? "Sandbox" : "Production"} environment
                        </CardDescription>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={cred.isActive === "true" ? "default" : "secondary"}>
                        {cred.isActive === "true" ? "Active" : "Inactive"}
                      </Badge>
                      <Badge variant={cred.isValidated === "true" ? "default" : "destructive"}>
                        {cred.isValidated === "true" ? "Validated" : "Not Validated"}
                      </Badge>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between">
                    <div className="text-sm text-muted-foreground">
                      {cred.lastValidated ? (
                        <p>Last validated: {new Date(cred.lastValidated).toLocaleString()}</p>
                      ) : (
                        <p>Never validated</p>
                      )}
                      {cred.validationError && (
                        <p className="text-destructive mt-1 flex items-center gap-1">
                          <AlertCircle className="h-4 w-4" />
                          {cred.validationError}
                        </p>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => validateMutation.mutate({ id: cred.id })}
                        disabled={validateMutation.isPending}
                      >
                        <Check className="h-4 w-4 mr-1" />
                        Validate
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          toggleActiveMutation.mutate({
                            id: cred.id,
                            isActive: cred.isActive !== "true",
                          })
                        }
                        disabled={toggleActiveMutation.isPending}
                      >
                        {cred.isActive === "true" ? "Deactivate" : "Activate"}
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => {
                          if (confirm("Are you sure you want to delete these credentials?")) {
                            deleteMutation.mutate({ id: cred.id });
                          }
                        }}
                        disabled={deleteMutation.isPending}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>

        {/* Add/Edit Dialog */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Add Payment Gateway Credentials</DialogTitle>
              <DialogDescription>
                Configure API credentials for mobile money payment gateway
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Payment Gateway</Label>
                  <Select
                    value={selectedGateway}
                    onValueChange={(v: Gateway) => setSelectedGateway(v)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mpesa">M-Pesa</SelectItem>
                      <SelectItem value="airtel">Airtel Money</SelectItem>
                      <SelectItem value="tigo">Tigo Pesa</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Environment</Label>
                  <Select
                    value={environment}
                    onValueChange={(v: "sandbox" | "production") => setEnvironment(v)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="sandbox">Sandbox (Testing)</SelectItem>
                      <SelectItem value="production">Production (Live)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* M-Pesa Form */}
              {selectedGateway === "mpesa" && (
                <div className="space-y-3">
                  <div>
                    <Label htmlFor="mpesa-consumer-key">Consumer Key *</Label>
                    <Input
                      id="mpesa-consumer-key"
                      type="password"
                      value={mpesaConsumerKey}
                      onChange={(e) => setMpesaConsumerKey(e.target.value)}
                      placeholder="Enter M-Pesa consumer key"
                    />
                  </div>
                  <div>
                    <Label htmlFor="mpesa-consumer-secret">Consumer Secret *</Label>
                    <Input
                      id="mpesa-consumer-secret"
                      type="password"
                      value={mpesaConsumerSecret}
                      onChange={(e) => setMpesaConsumerSecret(e.target.value)}
                      placeholder="Enter M-Pesa consumer secret"
                    />
                  </div>
                  <div>
                    <Label htmlFor="mpesa-shortcode">Shortcode *</Label>
                    <Input
                      id="mpesa-shortcode"
                      value={mpesaShortcode}
                      onChange={(e) => setMpesaShortcode(e.target.value)}
                      placeholder="Enter business shortcode"
                    />
                  </div>
                  <div>
                    <Label htmlFor="mpesa-passkey">Passkey *</Label>
                    <Input
                      id="mpesa-passkey"
                      type="password"
                      value={mpesaPasskey}
                      onChange={(e) => setMpesaPasskey(e.target.value)}
                      placeholder="Enter M-Pesa passkey"
                    />
                  </div>
                  <div>
                    <Label htmlFor="mpesa-callback">Callback URL *</Label>
                    <Input
                      id="mpesa-callback"
                      value={mpesaCallback}
                      onChange={(e) => setMpesaCallback(e.target.value)}
                      placeholder="https://yourdomain.com/api/mpesa/callback"
                    />
                  </div>
                </div>
              )}

              {/* Airtel Form */}
              {selectedGateway === "airtel" && (
                <div className="space-y-3">
                  <div>
                    <Label htmlFor="airtel-client-id">Client ID *</Label>
                    <Input
                      id="airtel-client-id"
                      type="password"
                      value={airtelClientId}
                      onChange={(e) => setAirtelClientId(e.target.value)}
                      placeholder="Enter Airtel Money client ID"
                    />
                  </div>
                  <div>
                    <Label htmlFor="airtel-client-secret">Client Secret *</Label>
                    <Input
                      id="airtel-client-secret"
                      type="password"
                      value={airtelClientSecret}
                      onChange={(e) => setAirtelClientSecret(e.target.value)}
                      placeholder="Enter Airtel Money client secret"
                    />
                  </div>
                  <div>
                    <Label htmlFor="airtel-merchant-code">Merchant Code *</Label>
                    <Input
                      id="airtel-merchant-code"
                      value={airtelMerchantCode}
                      onChange={(e) => setAirtelMerchantCode(e.target.value)}
                      placeholder="Enter merchant code"
                    />
                  </div>
                  <div>
                    <Label htmlFor="airtel-callback">Callback URL *</Label>
                    <Input
                      id="airtel-callback"
                      value={airtelCallback}
                      onChange={(e) => setAirtelCallback(e.target.value)}
                      placeholder="https://yourdomain.com/api/airtel/callback"
                    />
                  </div>
                </div>
              )}

              {/* Tigo Form */}
              {selectedGateway === "tigo" && (
                <div className="space-y-3">
                  <div>
                    <Label htmlFor="tigo-api-key">API Key *</Label>
                    <Input
                      id="tigo-api-key"
                      type="password"
                      value={tigoApiKey}
                      onChange={(e) => setTigoApiKey(e.target.value)}
                      placeholder="Enter Tigo Pesa API key"
                    />
                  </div>
                  <div>
                    <Label htmlFor="tigo-api-secret">API Secret *</Label>
                    <Input
                      id="tigo-api-secret"
                      type="password"
                      value={tigoApiSecret}
                      onChange={(e) => setTigoApiSecret(e.target.value)}
                      placeholder="Enter Tigo Pesa API secret"
                    />
                  </div>
                  <div>
                    <Label htmlFor="tigo-merchant-number">Merchant Number *</Label>
                    <Input
                      id="tigo-merchant-number"
                      value={tigoMerchantNumber}
                      onChange={(e) => setTigoMerchantNumber(e.target.value)}
                      placeholder="Enter merchant number"
                    />
                  </div>
                  <div>
                    <Label htmlFor="tigo-callback">Callback URL *</Label>
                    <Input
                      id="tigo-callback"
                      value={tigoCallback}
                      onChange={(e) => setTigoCallback(e.target.value)}
                      placeholder="https://yourdomain.com/api/tigo/callback"
                    />
                  </div>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={
                  saveMpesaMutation.isPending ||
                  saveAirtelMutation.isPending ||
                  saveTigoMutation.isPending
                }
              >
                Save Credentials
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
