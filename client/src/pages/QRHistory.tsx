import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { QrCode, ScanLine, TrendingUp, Calendar, Download, FileText } from "lucide-react";
import { exportQRHistoryCSV, exportQRHistoryPDF } from "@/lib/exportUtils";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { useState, useMemo } from "react";
import { toast } from "sonner";
import { AdvancedFilters, FilterState } from "@/components/AdvancedFilters";
import { isWithinInterval } from "date-fns";

export default function QRHistory() {
  const { data: history = [], isLoading } = trpc.qrHistory.getMyHistory.useQuery({ limit: 100 });
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [filters, setFilters] = useState<FilterState>({
    dateRange: { from: undefined, to: undefined },
    status: "all",
    amountRange: [0, 100000],
    paymentType: "all",
  });

  // Apply filters to history
  const filteredHistory = useMemo(() => {
    return history.filter((item) => {
      // Date range filter
      if (filters.dateRange.from && filters.dateRange.to) {
        const itemDate = new Date(item.createdAt);
        if (!isWithinInterval(itemDate, { start: filters.dateRange.from, end: filters.dateRange.to })) {
          return false;
        }
      }

      // Status filter
      if (filters.status !== "all" && item.status !== filters.status) {
        return false;
      }

      // Payment type filter
      if (filters.paymentType !== "all" && item.paymentType !== filters.paymentType) {
        return false;
      }

      // Amount range filter
      const amount = typeof item.amount === 'string' ? parseFloat(item.amount) : item.amount;
      if (amount < filters.amountRange[0] || amount > filters.amountRange[1]) {
        return false;
      }

      return true;
    });
  }, [history, filters]);

  const resetFilters = () => {
    setFilters({
      dateRange: { from: undefined, to: undefined },
      status: "all",
      amountRange: [0, 100000],
      paymentType: "all",
    });
  };
  const updateStatusMutation = trpc.qrHistory.updateStatus.useMutation({
    onSuccess: () => {
      toast.success("Status updated successfully");
      setSelectedIds([]);
    },
    onError: () => {
      toast.error("Failed to update status");
    },
  });
  
  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds(filteredHistory.map(h => h.id));
    } else {
      setSelectedIds([]);
    }
  };
  
  const handleSelectOne = (id: number, checked: boolean) => {
    if (checked) {
      setSelectedIds([...selectedIds, id]);
    } else {
      setSelectedIds(selectedIds.filter(sid => sid !== id));
    }
  };
  
  const handleBulkStatusUpdate = async (status: "completed" | "failed" | "expired") => {
    if (selectedIds.length === 0) {
      toast.error("No items selected");
      return;
    }
    
    for (const id of selectedIds) {
      await updateStatusMutation.mutateAsync({ id, status });
    }
  };
  const { data: stats, isLoading: statsLoading } = trpc.qrHistory.getMyStats.useQuery();

  const scans = filteredHistory.filter((h) => h.operationType === "scan");
  const generations = filteredHistory.filter((h) => h.operationType === "generate");

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
      pending: "secondary",
      completed: "default",
      failed: "destructive",
      expired: "outline",
    };
    return <Badge variant={variants[status] || "outline"}>{status}</Badge>;
  };

  const formatDate = (date: Date | null) => {
    if (!date) return "N/A";
    return new Date(date).toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const formatCurrency = (amount: string, currency: string) => {
    return `${parseFloat(amount).toLocaleString()} ${currency}`;
  };

  if (isLoading || statsLoading) {
    return (
      <DashboardLayout>
        <div className="space-y-6">
          <Skeleton className="h-12 w-64" />
          <div className="grid gap-4 md:grid-cols-3">
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
          </div>
          <Skeleton className="h-96" />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">QR Code History</h1>
            <p className="text-muted-foreground mt-2">
              Track all your QR code scans and generations
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            {selectedIds.length > 0 && (
              <>
                <Button
                  variant="outline"
                  onClick={() => handleBulkStatusUpdate("completed")}
                  disabled={updateStatusMutation.isPending}
                  className="gap-2"
                >
                  Mark as Completed ({selectedIds.length})
                </Button>
                <Button
                  variant="outline"
                  onClick={() => handleBulkStatusUpdate("failed")}
                  disabled={updateStatusMutation.isPending}
                  className="gap-2"
                >
                  Mark as Failed ({selectedIds.length})
                </Button>
              </>
            )}
            <Button
              variant="outline"
              onClick={() => exportQRHistoryCSV(history)}
              disabled={history.length === 0}
              className="gap-2"
            >
              <Download className="h-4 w-4" />
              Export CSV
            </Button>
            <Button
              variant="outline"
              onClick={() => exportQRHistoryPDF(history)}
              disabled={history.length === 0}
              className="gap-2"
            >
              <FileText className="h-4 w-4" />
              Export PDF
            </Button>
          </div>
        </div>

        {/* Advanced Filters */}
        <AdvancedFilters
          filters={filters}
          onFiltersChange={setFilters}
          onReset={resetFilters}
        />

        {/* Stats Cards */}
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Scans</CardTitle>
              <ScanLine className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats?.totalScans || 0}</div>
              <p className="text-xs text-muted-foreground mt-1">
                QR codes scanned
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Generated</CardTitle>
              <QrCode className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats?.totalGenerations || 0}</div>
              <p className="text-xs text-muted-foreground mt-1">
                QR codes created
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Amount</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats?.totalAmount || "0"}</div>
              <p className="text-xs text-muted-foreground mt-1">
                Completed transactions
              </p>
            </CardContent>
          </Card>
        </div>

        {/* History Tabs */}
        <Tabs defaultValue="all" className="space-y-4">
          <TabsList>
            <TabsTrigger value="all">All Transactions</TabsTrigger>
            <TabsTrigger value="scans">Scans</TabsTrigger>
            <TabsTrigger value="generated">Generated</TabsTrigger>
          </TabsList>

          <TabsContent value="all" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>All QR Code Transactions</CardTitle>
                <CardDescription>
                  Complete history of scanned and generated QR codes
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12">
                        <Checkbox
                          checked={selectedIds.length === history.length && history.length > 0}
                          onCheckedChange={handleSelectAll}
                        />
                      </TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Operation</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Details</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center text-muted-foreground">
                          No QR code transactions yet
                        </TableCell>
                      </TableRow>
                    ) : (
                      history.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell>
                            <Checkbox
                              checked={selectedIds.includes(item.id)}
                              onCheckedChange={(checked) => handleSelectOne(item.id, checked as boolean)}
                            />
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            {formatDate(item.createdAt)}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{item.paymentType}</Badge>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              {item.operationType === "scan" ? (
                                <ScanLine className="h-4 w-4" />
                              ) : (
                                <QrCode className="h-4 w-4" />
                              )}
                              {item.operationType}
                            </div>
                          </TableCell>
                          <TableCell className="font-medium">
                            {formatCurrency(item.amount, item.currency)}
                          </TableCell>
                          <TableCell className="max-w-xs truncate">
                            {item.merchantName || item.recipientName || item.description || "—"}
                          </TableCell>
                          <TableCell>{getStatusBadge(item.status)}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="scans" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Scanned QR Codes</CardTitle>
                <CardDescription>
                  QR codes you've scanned for payments
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Details</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {scans.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center text-muted-foreground">
                          No scanned QR codes yet
                        </TableCell>
                      </TableRow>
                    ) : (
                      scans.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell className="whitespace-nowrap">
                            {formatDate(item.scannedAt)}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{item.paymentType}</Badge>
                          </TableCell>
                          <TableCell className="font-medium">
                            {formatCurrency(item.amount, item.currency)}
                          </TableCell>
                          <TableCell className="max-w-xs truncate">
                            {item.merchantName || item.recipientName || item.description || "—"}
                          </TableCell>
                          <TableCell>{getStatusBadge(item.status)}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="generated" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Generated QR Codes</CardTitle>
                <CardDescription>
                  QR codes you've created for receiving payments
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Details</TableHead>
                      <TableHead>Expires</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {generations.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground">
                          No generated QR codes yet
                        </TableCell>
                      </TableRow>
                    ) : (
                      generations.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell className="whitespace-nowrap">
                            {formatDate(item.generatedAt)}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{item.paymentType}</Badge>
                          </TableCell>
                          <TableCell className="font-medium">
                            {formatCurrency(item.amount, item.currency)}
                          </TableCell>
                          <TableCell className="max-w-xs truncate">
                            {item.merchantName || item.recipientName || item.description || "—"}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            {formatDate(item.expiresAt)}
                          </TableCell>
                          <TableCell>{getStatusBadge(item.status)}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
