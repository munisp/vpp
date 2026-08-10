import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  AlertCircle,
  CheckCircle,
  XCircle,
  Clock,
  Download,
  RefreshCw,
} from 'lucide-react';
import { format, subDays } from 'date-fns';
import { toast } from 'sonner';

export default function ReconciliationDashboard() {
  const [selectedReconciliation, setSelectedReconciliation] = useState<any>(null);
  const [resolutionNotes, setResolutionNotes] = useState('');
  const [resolutionStatus, setResolutionStatus] = useState<'matched' | 'unmatched'>('matched');

  const utils = trpc.useUtils();

  const { data: discrepancies, isLoading: discrepanciesLoading } =
    trpc.reconciliation.getUnresolvedDiscrepancies.useQuery();

  const { data: statistics } = trpc.reconciliation.getStatistics.useQuery({
    startDate: subDays(new Date(), 30),
    endDate: new Date(),
  });

  const { data: reports } = trpc.reconciliation.getReports.useQuery({
    limit: 10,
  });

  const resolveDiscrepancyMutation = trpc.reconciliation.resolveDiscrepancy.useMutation({
    onSuccess: () => {
      toast.success('Discrepancy resolved successfully');
      setSelectedReconciliation(null);
      setResolutionNotes('');
      utils.reconciliation.getUnresolvedDiscrepancies.invalidate();
      utils.reconciliation.getStatistics.invalidate();
    },
    onError: (error) => {
      toast.error(`Failed to resolve: ${error.message}`);
    },
  });

  const generateReportMutation = trpc.reconciliation.generateDailyReport.useMutation({
    onSuccess: () => {
      toast.success('Report generated successfully');
      utils.reconciliation.getReports.invalidate();
    },
    onError: (error) => {
      toast.error(`Failed to generate report: ${error.message}`);
    },
  });

  const handleResolve = () => {
    if (!selectedReconciliation || !resolutionNotes.trim()) {
      toast.error('Please provide resolution notes');
      return;
    }

    resolveDiscrepancyMutation.mutate({
      reconciliationId: selectedReconciliation.id,
      notes: resolutionNotes,
      newStatus: resolutionStatus,
    });
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'matched':
        return (
          <Badge variant="default" className="bg-green-500">
            <CheckCircle className="w-3 h-3 mr-1" />
            Matched
          </Badge>
        );
      case 'unmatched':
        return (
          <Badge variant="secondary">
            <Clock className="w-3 h-3 mr-1" />
            Unmatched
          </Badge>
        );
      case 'discrepancy':
        return (
          <Badge variant="destructive">
            <AlertCircle className="w-3 h-3 mr-1" />
            Discrepancy
          </Badge>
        );
      case 'manual_review':
        return (
          <Badge variant="outline">
            <XCircle className="w-3 h-3 mr-1" />
            Manual Review
          </Badge>
        );
      default:
        return <Badge>{status}</Badge>;
    }
  };

  return (
    <div className="container py-8 space-y-8">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold">Payment Reconciliation</h1>
          <p className="text-muted-foreground">
            Monitor and resolve payment discrepancies
          </p>
        </div>
        <Button
          onClick={() => generateReportMutation.mutate({ date: new Date() })}
          disabled={generateReportMutation.isPending}
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${generateReportMutation.isPending ? 'animate-spin' : ''}`} />
          Generate Today's Report
        </Button>
      </div>

      {/* Statistics Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Reconciled</CardTitle>
            <CheckCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{statistics?.total || 0}</div>
            <p className="text-xs text-muted-foreground">Last 30 days</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Match Rate</CardTitle>
            <CheckCircle className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {(statistics?.matchRate || 0).toFixed(1)}%
            </div>
            <p className="text-xs text-muted-foreground">
              {statistics?.matched || 0} matched
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Discrepancies</CardTitle>
            <AlertCircle className="h-4 w-4 text-red-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{statistics?.discrepancies || 0}</div>
            <p className="text-xs text-muted-foreground">Requires attention</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Amount Difference</CardTitle>
            <AlertCircle className="h-4 w-4 text-orange-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {((statistics?.totalAmountDiscrepancy || 0) / 100).toFixed(0)} TZS
            </div>
            <p className="text-xs text-muted-foreground">Total discrepancy</p>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="discrepancies" className="space-y-4">
        <TabsList>
          <TabsTrigger value="discrepancies">
            Unresolved Discrepancies ({discrepancies?.length || 0})
          </TabsTrigger>
          <TabsTrigger value="reports">Reports</TabsTrigger>
        </TabsList>

        {/* Discrepancies Tab */}
        <TabsContent value="discrepancies" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Unresolved Discrepancies</CardTitle>
              <CardDescription>
                Review and resolve payment reconciliation issues
              </CardDescription>
            </CardHeader>
            <CardContent>
              {discrepanciesLoading ? (
                <div className="text-center py-8">Loading...</div>
              ) : !discrepancies || discrepancies.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <CheckCircle className="mx-auto h-12 w-12 mb-4 text-green-500" />
                  <p>No unresolved discrepancies</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Payment ID</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Gateway Transaction</TableHead>
                      <TableHead>DB Amount</TableHead>
                      <TableHead>Gateway Amount</TableHead>
                      <TableHead>Difference</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {discrepancies.map((discrepancy) => (
                      <TableRow key={discrepancy.id}>
                        <TableCell className="font-medium">
                          #{discrepancy.paymentId}
                        </TableCell>
                        <TableCell>
                          {format(new Date(discrepancy.reconciliationDate), 'MMM dd, yyyy')}
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          {discrepancy.gatewayTransactionId || 'N/A'}
                        </TableCell>
                        <TableCell>
                          {((discrepancy.dbAmount || 0) / 100).toFixed(0)} TZS
                        </TableCell>
                        <TableCell>
                          {discrepancy.gatewayAmount
                            ? `${(discrepancy.gatewayAmount / 100).toFixed(0)} TZS`
                            : 'N/A'}
                        </TableCell>
                        <TableCell>
                          {discrepancy.amountDifference ? (
                            <span
                              className={
                                discrepancy.amountDifference > 0
                                  ? 'text-red-600'
                                  : 'text-green-600'
                              }
                            >
                              {discrepancy.amountDifference > 0 ? '+' : ''}
                              {(discrepancy.amountDifference / 100).toFixed(0)} TZS
                            </span>
                          ) : (
                            'N/A'
                          )}
                        </TableCell>
                        <TableCell>{getStatusBadge(discrepancy.status)}</TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setSelectedReconciliation(discrepancy)}
                          >
                            Resolve
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Reports Tab */}
        <TabsContent value="reports" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Reconciliation Reports</CardTitle>
              <CardDescription>Daily reconciliation summaries</CardDescription>
            </CardHeader>
            <CardContent>
              {!reports || reports.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No reports available
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Total Payments</TableHead>
                      <TableHead>Matched</TableHead>
                      <TableHead>Discrepancies</TableHead>
                      <TableHead>Match Rate</TableHead>
                      <TableHead>Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reports.map((report) => (
                      <TableRow key={report.id}>
                        <TableCell>
                          {format(new Date(report.reportDate), 'MMM dd, yyyy')}
                        </TableCell>
                        <TableCell className="capitalize">{report.reportType}</TableCell>
                        <TableCell>{report.totalPayments}</TableCell>
                        <TableCell className="text-green-600">
                          {report.matchedPayments}
                        </TableCell>
                        <TableCell className="text-red-600">
                          {report.discrepancies}
                        </TableCell>
                        <TableCell>
                          {report.totalPayments > 0
                            ? ((report.matchedPayments / report.totalPayments) * 100).toFixed(1)
                            : 0}
                          %
                        </TableCell>
                        <TableCell>
                          <Button size="sm" variant="ghost">
                            <Download className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Resolution Dialog */}
      <Dialog
        open={!!selectedReconciliation}
        onOpenChange={() => setSelectedReconciliation(null)}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Resolve Discrepancy</DialogTitle>
            <DialogDescription>
              Review the details and provide resolution notes
            </DialogDescription>
          </DialogHeader>

          {selectedReconciliation && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium">Payment ID</p>
                  <p className="text-sm text-muted-foreground">
                    #{selectedReconciliation.paymentId}
                  </p>
                </div>
                <div>
                  <p className="text-sm font-medium">Gateway Transaction</p>
                  <p className="text-sm text-muted-foreground font-mono">
                    {selectedReconciliation.gatewayTransactionId || 'N/A'}
                  </p>
                </div>
                <div>
                  <p className="text-sm font-medium">Database Amount</p>
                  <p className="text-sm text-muted-foreground">
                    {((selectedReconciliation.dbAmount || 0) / 100).toFixed(0)} TZS
                  </p>
                </div>
                <div>
                  <p className="text-sm font-medium">Gateway Amount</p>
                  <p className="text-sm text-muted-foreground">
                    {selectedReconciliation.gatewayAmount
                      ? `${(selectedReconciliation.gatewayAmount / 100).toFixed(0)} TZS`
                      : 'N/A'}
                  </p>
                </div>
                <div>
                  <p className="text-sm font-medium">Amount Difference</p>
                  <p
                    className={`text-sm ${
                      (selectedReconciliation.amountDifference || 0) > 0
                        ? 'text-red-600'
                        : 'text-green-600'
                    }`}
                  >
                    {selectedReconciliation.amountDifference
                      ? `${(selectedReconciliation.amountDifference / 100).toFixed(0)} TZS`
                      : '0 TZS'}
                  </p>
                </div>
                <div>
                  <p className="text-sm font-medium">Status Mismatch</p>
                  <p className="text-sm text-muted-foreground">
                    {selectedReconciliation.statusMismatch ? 'Yes' : 'No'}
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Resolution Status</label>
                <div className="flex gap-2">
                  <Button
                    variant={resolutionStatus === 'matched' ? 'default' : 'outline'}
                    onClick={() => setResolutionStatus('matched')}
                  >
                    Mark as Matched
                  </Button>
                  <Button
                    variant={resolutionStatus === 'unmatched' ? 'default' : 'outline'}
                    onClick={() => setResolutionStatus('unmatched')}
                  >
                    Mark as Unmatched
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Resolution Notes</label>
                <Textarea
                  placeholder="Explain how this discrepancy was resolved..."
                  value={resolutionNotes}
                  onChange={(e) => setResolutionNotes(e.target.value)}
                  rows={4}
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedReconciliation(null)}>
              Cancel
            </Button>
            <Button
              onClick={handleResolve}
              disabled={resolveDiscrepancyMutation.isPending || !resolutionNotes.trim()}
            >
              {resolveDiscrepancyMutation.isPending ? 'Resolving...' : 'Resolve'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
