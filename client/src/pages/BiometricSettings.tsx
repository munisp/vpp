import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Fingerprint, Trash2, Plus, Smartphone, Monitor, AlertCircle, Shield, CheckCircle2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { BiometricRegistration } from "@/components/BiometricLogin";

export default function BiometricSettings() {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedCredential, setSelectedCredential] = useState<number | null>(null);
  const [registerDialogOpen, setRegisterDialogOpen] = useState(false);

  // Fetch biometric credentials from backend
  const { data: credentials = [], isLoading, refetch } = trpc.biometric.getMyCredentials.useQuery();
  const deleteCredentialMutation = trpc.biometric.deleteCredential.useMutation({
    onSuccess: () => {
      toast.success("Biometric credential removed successfully");
      refetch();
      setDeleteDialogOpen(false);
      setSelectedCredential(null);
    },
    onError: () => {
      toast.error("Failed to remove credential");
    },
  });

  const handleDeleteCredential = async () => {
    if (!selectedCredential) return;
    deleteCredentialMutation.mutate({ id: selectedCredential });
  };

  const getDeviceIcon = (deviceType: string | null) => {
    return deviceType === "platform" ? <Smartphone className="h-4 w-4" /> : <Monitor className="h-4 w-4" />;
  };

  const formatDate = (date: Date | null | string) => {
    if (!date) return "N/A";
    return new Date(date).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const getTimeSince = (date: Date | null | string) => {
    if (!date) return "Never";
    const seconds = Math.floor((new Date().getTime() - new Date(date).getTime()) / 1000);
    
    if (seconds < 60) return "Just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)} days ago`;
    return formatDate(date);
  };

  return (
    <div className="container py-8 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold">Biometric Authentication</h1>
        <p className="text-muted-foreground mt-2">
          Manage your biometric credentials for secure and convenient login
        </p>
      </div>

      {/* Security Info */}
      <Alert>
        <Shield className="h-4 w-4" />
        <AlertDescription>
          Your biometric data never leaves your device. We only store a secure credential that verifies your identity.
        </AlertDescription>
      </Alert>

      {/* Status Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-green-600" />
            Biometric Login Enabled
          </CardTitle>
          <CardDescription>
            You have {credentials.length} device{credentials.length !== 1 ? "s" : ""} registered for biometric authentication
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <Button onClick={() => setRegisterDialogOpen(true)} className="gap-2">
              <Plus className="h-4 w-4" />
              Add New Device
            </Button>
            <p className="text-sm text-muted-foreground">
              Register additional devices to use biometric login across all your devices
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Registered Devices */}
      <Card>
        <CardHeader>
          <CardTitle>Registered Devices</CardTitle>
          <CardDescription>
            Manage devices that can use biometric authentication
          </CardDescription>
        </CardHeader>
        <CardContent>
          {credentials.length === 0 ? (
            <div className="text-center py-8 space-y-4">
              <Fingerprint className="h-12 w-12 mx-auto text-muted-foreground" />
              <div>
                <p className="text-muted-foreground">No biometric credentials registered</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Add a device to enable biometric login
                </p>
              </div>
              <Button onClick={() => setRegisterDialogOpen(true)} className="gap-2">
                <Plus className="h-4 w-4" />
                Register First Device
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Device</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Registered</TableHead>
                  <TableHead>Last Used</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {credentials.map((credential) => (
                  <TableRow key={credential.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {getDeviceIcon(credential.deviceType)}
                        {credential.deviceName}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        {credential.deviceType === "platform" ? "Platform" : "Cross-platform"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(credential.createdAt)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {getTimeSince(credential.lastUsed)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          setSelectedCredential(credential.id);
                          setDeleteDialogOpen(true);
                        }}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* How It Works */}
      <Card>
        <CardHeader>
          <CardTitle>How Biometric Authentication Works</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4 text-sm text-muted-foreground">
            <div className="flex gap-3">
              <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center text-primary font-semibold">
                1
              </div>
              <div>
                <p className="font-medium text-foreground">Register Your Device</p>
                <p>Your device creates a unique cryptographic key pair stored securely on your device</p>
              </div>
            </div>
            <div className="flex gap-3">
              <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center text-primary font-semibold">
                2
              </div>
              <div>
                <p className="font-medium text-foreground">Biometric Verification</p>
                <p>When logging in, your device verifies your identity using fingerprint or face recognition</p>
              </div>
            </div>
            <div className="flex gap-3">
              <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center text-primary font-semibold">
                3
              </div>
              <div>
                <p className="font-medium text-foreground">Secure Authentication</p>
                <p>Your device signs the authentication request, proving your identity without sending biometric data</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Security Tips */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5" />
            Security Tips
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm text-muted-foreground list-disc list-inside">
            <li>Only register devices that you personally own and control</li>
            <li>Remove credentials from devices you no longer use or have lost</li>
            <li>Keep your device's operating system and security features up to date</li>
            <li>Use a strong device passcode as a backup authentication method</li>
            <li>Be cautious when using biometric login on shared or public devices</li>
          </ul>
        </CardContent>
      </Card>

      {/* Register Dialog */}
      <Dialog open={registerDialogOpen} onOpenChange={setRegisterDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Register New Device</DialogTitle>
            <DialogDescription>
              Add biometric authentication for this device
            </DialogDescription>
          </DialogHeader>
          <BiometricRegistration />
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove Biometric Credential</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove this device? You won't be able to use biometric login on this device anymore.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeleteDialogOpen(false);
                setSelectedCredential(null);
              }}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeleteCredential}>
              Remove Device
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
