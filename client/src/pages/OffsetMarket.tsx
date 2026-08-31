import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { Leaf, ShoppingCart, Tag } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

type Currency = "NGN" | "TZS" | "USD";

function fmtPrice(cents: number | null | undefined, currency: string | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return `${currency ?? ""} ${(cents / 100).toFixed(2)}`.trim();
}

function fmtWh(wh: number | null | undefined): string {
  if (wh === null || wh === undefined) return "—";
  return wh >= 1000 ? `${(wh / 1000).toFixed(1)} kWh` : `${wh} Wh`;
}

function fmtGrams(g: number | null | undefined): string {
  if (g === null || g === undefined) return "unavailable";
  return g >= 1000 ? `${(g / 1000).toFixed(1)} kg CO₂` : `${g} g CO₂`;
}

export default function OffsetMarket() {
  const { user } = useAuth();
  const utils = trpc.useUtils();

  const browse = trpc.offsetMarket.browse.useQuery({ limit: 50 });
  const myListings = trpc.offsetMarket.myListings.useQuery({ limit: 50 });
  const myTransfers = trpc.offsetMarket.myTransfers.useQuery({ limit: 50 });
  const myCerts = trpc.carbonCredits.listMyCertificates.useQuery({ limit: 50 });

  const [sellOpen, setSellOpen] = useState(false);
  const [certificateId, setCertificateId] = useState<string>("");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState<Currency>("USD");

  const [buyTarget, setBuyTarget] = useState<any | null>(null);

  const invalidateAll = () => {
    utils.offsetMarket.browse.invalidate();
    utils.offsetMarket.myListings.invalidate();
    utils.offsetMarket.myTransfers.invalidate();
    utils.carbonCredits.listMyCertificates.invalidate();
  };

  const createMutation = trpc.offsetMarket.createListing.useMutation({
    onSuccess: () => {
      toast.success("Certificate listed for sale");
      setSellOpen(false);
      setCertificateId("");
      setPrice("");
      invalidateAll();
    },
    onError: (e) => toast.error(e.message || "Failed to create listing"),
  });

  const cancelMutation = trpc.offsetMarket.cancelListing.useMutation({
    onSuccess: () => {
      toast.success("Listing cancelled");
      invalidateAll();
    },
    onError: (e) => toast.error(e.message || "Failed to cancel listing"),
  });

  const purchaseMutation = trpc.offsetMarket.purchase.useMutation({
    onSuccess: (r) => {
      toast.success(`Purchased certificate #${r.certificateId}`);
      setBuyTarget(null);
      invalidateAll();
    },
    onError: (e) => toast.error(e.message || "Purchase failed"),
  });

  const handleCreate = () => {
    const certId = parseInt(certificateId, 10);
    const priceFloat = parseFloat(price);
    if (!certId) return toast.error("Choose a certificate to list");
    if (!priceFloat || priceFloat <= 0) return toast.error("Enter a positive asking price");
    createMutation.mutate({
      certificateId: certId,
      askingPriceCents: Math.round(priceFloat * 100),
      currency,
    });
  };

  // Only 'minted' certificates are sellable; retired or already-transferred
  // ones are refused by the server.
  const sellableCerts = (myCerts.data ?? []).filter((c: any) => c.status === "minted");

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Carbon Offset Marketplace</h1>
            <p className="text-muted-foreground">
              Buy and sell verified carbon certificates. The asking price is the seller's own
              declaration — the platform records the ownership transfer, not a payment.
            </p>
          </div>
          <Button onClick={() => setSellOpen(true)}>
            <Tag className="h-4 w-4 mr-2" /> List a certificate
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Leaf className="h-4 w-4" /> Active listings
            </CardTitle>
            <CardDescription>Open marketplace — all currently sellable certificates</CardDescription>
          </CardHeader>
          <CardContent>
            {browse.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : browse.error ? (
              <p className="text-sm text-muted-foreground">{browse.error.message}</p>
            ) : !browse.data || browse.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">No active listings right now.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Certificate</TableHead>
                    <TableHead>Energy</TableHead>
                    <TableHead>CO₂ avoided</TableHead>
                    <TableHead>Region</TableHead>
                    <TableHead>Asking price</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {browse.data.map((row: any) => {
                    const own = user?.id != null && row.listing.sellerUserId === user.id;
                    return (
                      <TableRow key={row.listing.id}>
                        <TableCell>
                          <code className="text-xs">#{row.certificate.id}</code>
                          {own && (
                            <Badge variant="secondary" className="ml-2">
                              yours
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>{fmtWh(row.certificate.energyWh)}</TableCell>
                        <TableCell>{fmtGrams(row.certificate.co2AvoidedGrams)}</TableCell>
                        <TableCell className="text-sm">{row.certificate.region}</TableCell>
                        <TableCell className="font-medium">
                          {fmtPrice(row.listing.askingPriceCents, row.listing.currency)}
                        </TableCell>
                        <TableCell className="text-right">
                          {own ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => cancelMutation.mutate({ listingId: row.listing.id })}
                              disabled={cancelMutation.isPending}
                            >
                              Cancel
                            </Button>
                          ) : (
                            <Button size="sm" onClick={() => setBuyTarget(row)}>
                              <ShoppingCart className="h-4 w-4 mr-1" /> Buy
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">My listings</CardTitle>
              <CardDescription>active → sold | cancelled</CardDescription>
            </CardHeader>
            <CardContent>
              {myListings.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : !myListings.data || myListings.data.length === 0 ? (
                <p className="text-sm text-muted-foreground">You have not listed any certificates.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Listing</TableHead>
                      <TableHead>Certificate</TableHead>
                      <TableHead>Ask</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {myListings.data.map((l: any) => (
                      <TableRow key={l.id}>
                        <TableCell className="text-sm text-muted-foreground">#{l.id}</TableCell>
                        <TableCell>
                          <code className="text-xs">#{l.certificateId}</code>
                        </TableCell>
                        <TableCell>{fmtPrice(l.askingPriceCents, l.currency)}</TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              l.status === "active" ? "default" : l.status === "sold" ? "secondary" : "outline"
                            }
                          >
                            {l.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          {l.status === "active" && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => cancelMutation.mutate({ listingId: l.id })}
                              disabled={cancelMutation.isPending}
                            >
                              Cancel
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">My transfers</CardTitle>
              <CardDescription>Ownership changes where you were buyer or seller</CardDescription>
            </CardHeader>
            <CardContent>
              {myTransfers.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : !myTransfers.data || myTransfers.data.length === 0 ? (
                <p className="text-sm text-muted-foreground">No transfers yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Certificate</TableHead>
                      <TableHead>Direction</TableHead>
                      <TableHead>Price</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {myTransfers.data.map((t: any) => (
                      <TableRow key={t.id}>
                        <TableCell className="text-sm text-muted-foreground">
                          {new Date(t.transferredAt).toLocaleString()}
                        </TableCell>
                        <TableCell>
                          <code className="text-xs">#{t.certificateId}</code>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            {user?.id != null && t.toUserId === user.id ? "bought" : "sold"}
                          </Badge>
                        </TableCell>
                        <TableCell>{fmtPrice(t.priceCents, t.currency)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

        <Dialog open={sellOpen} onOpenChange={setSellOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>List a certificate for sale</DialogTitle>
              <DialogDescription>
                Only certificates you own in the minted state can be listed. A certificate that has
                already changed hands once cannot be sold again here.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Certificate</Label>
                <Select value={certificateId} onValueChange={setCertificateId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a certificate" />
                  </SelectTrigger>
                  <SelectContent>
                    {sellableCerts.map((c: any) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        #{c.sequence} — {fmtWh(c.energyWh)} — {c.region}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {myCerts.data && sellableCerts.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    No sellable certificates — only minted certificates you still own can be listed.
                  </p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="askPrice">Asking price</Label>
                  <Input
                    id="askPrice"
                    type="number"
                    min="0"
                    step="0.01"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Currency</Label>
                  <Select value={currency} onValueChange={(v) => setCurrency(v as Currency)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="NGN">NGN</SelectItem>
                      <SelectItem value="TZS">TZS</SelectItem>
                      <SelectItem value="USD">USD</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setSellOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreate} disabled={createMutation.isPending}>
                {createMutation.isPending ? "Listing…" : "Create listing"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={buyTarget !== null} onOpenChange={(open) => !open && setBuyTarget(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Confirm purchase</DialogTitle>
              <DialogDescription>
                This transfers certificate ownership to you. No money moves on the platform — the
                transfer row is the receipt of the ownership change only.
              </DialogDescription>
            </DialogHeader>
            {buyTarget && (
              <div className="space-y-1 text-sm">
                <p>
                  Certificate <code className="text-xs">#{buyTarget.certificate.id}</code> —{" "}
                  {fmtWh(buyTarget.certificate.energyWh)}, {fmtGrams(buyTarget.certificate.co2AvoidedGrams)} (
                  {buyTarget.certificate.region})
                </p>
                <p className="font-medium">
                  Price: {fmtPrice(buyTarget.listing.askingPriceCents, buyTarget.listing.currency)}
                </p>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setBuyTarget(null)}>
                Back
              </Button>
              <Button
                onClick={() => buyTarget && purchaseMutation.mutate({ listingId: buyTarget.listing.id })}
                disabled={purchaseMutation.isPending}
              >
                {purchaseMutation.isPending ? "Purchasing…" : "Confirm purchase"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
