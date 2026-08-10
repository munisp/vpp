import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { Zap, Battery, CheckCircle, XCircle } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { Redirect } from "wouter";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useState } from "react";

export default function AssetApproval() {
  const { user, loading } = useAuth();
  const [selectedAsset, setSelectedAsset] = useState<any>(null);

  const { data: assets, isLoading, refetch } = trpc.admin.getPendingAssets.useQuery();
  const approveMutation = trpc.admin.approveAsset.useMutation({
    onSuccess: (data) => {
      toast.success(data.message);
      setSelectedAsset(null);
      refetch();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to process asset");
    },
  });

  // Check if user is admin
  if (!loading && user?.role !== 'admin') {
    return <Redirect to="/" />;
  }

  const handleApprove = (approved: boolean) => {
    if (!selectedAsset) return;
    approveMutation.mutate({
      assetId: selectedAsset.id,
      approved,
    });
  };

  const getAssetIcon = (type: string) => {
    switch (type) {
      case 'solar_panel':
        return <Zap className="h-4 w-4" />;
      case 'battery':
        return <Battery className="h-4 w-4" />;
      default:
        return <Zap className="h-4 w-4" />;
    }
  };

  const getAssetTypeLabel = (type: string) => {
    return type.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Asset Approval</h1>
          <p className="text-muted-foreground mt-2">
            Review and approve consumer asset registrations.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Pending Assets</CardTitle>
            <CardDescription>
              {assets?.length || 0} assets awaiting review
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="border rounded-lg">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Asset</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Owner</TableHead>
                    <TableHead>Capacity</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>Registered</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-8">
                        Loading assets...
                      </TableCell>
                    </TableRow>
                  ) : !assets || assets.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-8">
                        No pending assets
                      </TableCell>
                    </TableRow>
                  ) : (
                    assets.map((asset: any) => (
                      <TableRow key={asset.id}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <div className="h-8 w-8 rounded-lg bg-green-50 flex items-center justify-center">
                              {getAssetIcon(asset.assetType)}
                            </div>
                            <span className="font-medium">{asset.name}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            {getAssetTypeLabel(asset.assetType)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div>
                            <p className="font-medium text-sm">{asset.userName}</p>
                            <p className="text-xs text-muted-foreground">{asset.userEmail}</p>
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {asset.capacity ? `${asset.capacity} W` : "N/A"}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {asset.location || "N/A"}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {asset.createdAt ? new Date(asset.createdAt).toLocaleDateString() : "N/A"}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setSelectedAsset(asset)}
                          >
                            Review
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Asset Review Dialog */}
      <Dialog open={!!selectedAsset} onOpenChange={(open) => !open && setSelectedAsset(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Review Asset Registration</DialogTitle>
            <DialogDescription>
              Review asset details and approve or reject the registration
            </DialogDescription>
          </DialogHeader>
          {selectedAsset && (
            <div className="space-y-4 py-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">Asset Name</p>
                  <p className="font-medium">{selectedAsset.name}</p>
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">Type</p>
                  <Badge variant="outline">{getAssetTypeLabel(selectedAsset.assetType)}</Badge>
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">Capacity</p>
                  <p className="font-medium">{selectedAsset.capacity ? `${selectedAsset.capacity} W` : "N/A"}</p>
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">Manufacturer</p>
                  <p className="font-medium">{selectedAsset.manufacturer || "N/A"}</p>
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">Model</p>
                  <p className="font-medium">{selectedAsset.model || "N/A"}</p>
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">Serial Number</p>
                  <p className="font-medium">{selectedAsset.serialNumber || "N/A"}</p>
                </div>
                <div className="space-y-2 col-span-2">
                  <p className="text-sm font-medium text-muted-foreground">Location</p>
                  <p className="font-medium">{selectedAsset.location || "N/A"}</p>
                </div>
                <div className="space-y-2 col-span-2">
                  <p className="text-sm font-medium text-muted-foreground">Owner</p>
                  <div className="p-3 bg-muted rounded-lg">
                    <p className="font-medium">{selectedAsset.userName}</p>
                    <p className="text-sm text-muted-foreground">{selectedAsset.userEmail}</p>
                  </div>
                </div>
                {selectedAsset.metadata && (
                  <div className="space-y-2 col-span-2">
                    <p className="text-sm font-medium text-muted-foreground">Additional Information</p>
                    <div className="p-3 bg-muted rounded-lg text-sm">
                      <pre className="whitespace-pre-wrap">{JSON.stringify(JSON.parse(selectedAsset.metadata), null, 2)}</pre>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setSelectedAsset(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => handleApprove(false)}
              disabled={approveMutation.isPending}
            >
              <XCircle className="h-4 w-4 mr-2" />
              Reject
            </Button>
            <Button
              onClick={() => handleApprove(true)}
              disabled={approveMutation.isPending}
            >
              <CheckCircle className="h-4 w-4 mr-2" />
              {approveMutation.isPending ? "Processing..." : "Approve"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
