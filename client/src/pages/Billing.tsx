import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { CreditCard, DollarSign, Download, Receipt } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";

export default function Billing() {
  const [selectedStatus, setSelectedStatus] = useState<"all" | "paid" | "pending" | "overdue">("all");
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<number | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const { data: billingsData, isLoading } = trpc.billing.list.useQuery({ limit: 50 });
  const billings = billingsData?.billings || [];

  const { data: invoiceDetails } = trpc.billing.getById.useQuery(
    { billingId: selectedInvoiceId! },
    { enabled: selectedInvoiceId !== null }
  );

  // Filter billings by status
  const filteredBillings = billings.filter((billing) => {
    if (selectedStatus === "all") return true;
    return billing.status === selectedStatus;
  });

  // Calculate summary
  const totalBilled = billings.reduce((sum, b) => sum + b.totalValue, 0);
  const totalPaid = billings.filter((b) => b.status === "paid").reduce((sum, b) => sum + b.totalValue, 0);
  const outstandingBalance = billings.filter((b) => b.status !== "paid").reduce((sum, b) => sum + b.totalValue, 0);

  const getStatusBadge = (status: string) => {
    const variants: Record<string, { variant: "default" | "secondary" | "destructive", label: string }> = {
      paid: { variant: "default", label: "Paid" },
      pending: { variant: "secondary", label: "Pending" },
      overdue: { variant: "destructive", label: "Overdue" },
    };
    const config = variants[status] || variants.pending;
    return <Badge variant={config.variant}>{config.label}</Badge>;
  };

  const handleViewDetails = (id: number) => {
    setSelectedInvoiceId(id);
    setIsDialogOpen(true);
  };

  const handleDownload = () => {
    toast.info("Download feature coming soon");
    setIsDialogOpen(false);
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Billing</h1>
            <p className="text-muted-foreground mt-2">
              View your invoices, payment history, and billing summary.
            </p>
          </div>
          <Select value={selectedStatus} onValueChange={(value: any) => setSelectedStatus(value)}>
            <SelectTrigger className="w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="paid">Paid</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="overdue">Overdue</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Summary Cards */}
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Billed</CardTitle>
              <Receipt className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-8 w-24" />
              ) : (
                <>
                  <div className="text-2xl font-bold">{totalBilled.toFixed(2)} TZS</div>
                  <p className="text-xs text-muted-foreground mt-1">All time</p>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Paid</CardTitle>
              <DollarSign className="h-4 w-4 text-green-600" />
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-8 w-24" />
              ) : (
                <>
                  <div className="text-2xl font-bold text-green-600">{totalPaid.toFixed(2)} TZS</div>
                  <p className="text-xs text-muted-foreground mt-1">Successfully paid</p>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Outstanding Balance</CardTitle>
              <CreditCard className="h-4 w-4 text-red-600" />
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-8 w-24" />
              ) : (
                <>
                  <div className="text-2xl font-bold text-red-600">{outstandingBalance.toFixed(2)} TZS</div>
                  <p className="text-xs text-muted-foreground mt-1">Pending payment</p>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Invoices Table */}
        <Card>
          <CardHeader>
            <CardTitle>Invoices</CardTitle>
            <CardDescription>
              View and manage your billing invoices
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : filteredBillings.length === 0 ? (
              <div className="text-center py-12">
                <Receipt className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-semibold mb-2">No invoices found</h3>
                <p className="text-sm text-muted-foreground">
                  {selectedStatus === "all"
                    ? "You don't have any invoices yet."
                    : `No ${selectedStatus} invoices found.`}
                </p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Invoice ID</TableHead>
                    <TableHead>Billing Period</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Due Date</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredBillings.map((billing) => (
                    <TableRow key={billing.id}>
                      <TableCell className="font-medium">#{billing.id}</TableCell>
                      <TableCell>
                        {new Date(billing.periodStart).toLocaleDateString()} -{" "}
                        {new Date(billing.periodEnd).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="font-semibold">{(billing.totalValue / 100).toFixed(2)} TZS</TableCell>
                      <TableCell>{getStatusBadge(billing.status)}</TableCell>
                      <TableCell>{new Date(billing.periodEnd).toLocaleDateString()}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleViewDetails(billing.id)}
                        >
                          View Details
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Invoice Details Dialog */}
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Invoice Details</DialogTitle>
              <DialogDescription>
                View the full details of the selected invoice
              </DialogDescription>
            </DialogHeader>
            {invoiceDetails && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm text-muted-foreground">Invoice ID</p>
                    <p className="font-medium">#{invoiceDetails.id}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Status</p>
                    {getStatusBadge(invoiceDetails.status)}
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Billing Period</p>
                    <p className="font-medium">
                      {new Date(invoiceDetails.periodStart).toLocaleDateString()} -{" "}
                      {new Date(invoiceDetails.periodEnd).toLocaleDateString()}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Generation</p>
                    <p className="font-medium">{invoiceDetails.generationKwh} kWh</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Consumption</p>
                    <p className="font-medium">{invoiceDetails.consumptionKwh} kWh</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Export Revenue</p>
                    <p className="font-medium">{(invoiceDetails.exportRevenue / 100).toFixed(2)} TZS</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Your Share (70%)</p>
                    <p className="font-medium">{(invoiceDetails.consumerShare / 100).toFixed(2)} TZS</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Total Value</p>
                    <p className="text-lg font-bold text-green-600">
                      {(invoiceDetails.totalValue / 100).toFixed(2)} TZS
                    </p>
                  </div>
                </div>
                <Button onClick={handleDownload} className="w-full">
                  <Download className="mr-2 h-4 w-4" />
                  Download Invoice
                </Button>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
