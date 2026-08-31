import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Activity, CheckCircle2, XCircle, Clock, Loader2, Play, Square, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

// Live workflow types dispatched by the server (server/routers/workflows.ts
// WORKFLOW_TYPES) — the old PascalCase names belonged to retired duplicate
// workers that nothing dispatches to.
type WorkflowType =
  | 'processPayment'
  | 'refundWorkflow'
  | 'orchestrateDREvent'
  | 'cancelDREventWorkflow'
  | 'executeTrade'
  | 'automatedTradingWorkflow'
  | 'p2pTradingWorkflow'
  | 'prepaidIssuanceWorkflow'
  | 'prepaidConsumptionSweepWorkflow'
  | undefined;
type WorkflowStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'terminated' | undefined;

export default function WorkflowMonitoring() {
  const [selectedType, setSelectedType] = useState<WorkflowType>(undefined);
  const [selectedStatus, setSelectedStatus] = useState<WorkflowStatus>(undefined);
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [terminateDialogOpen, setTerminateDialogOpen] = useState(false);
  const [reason, setReason] = useState('');

  const { data: workflows, isLoading, refetch } = trpc.workflows.list.useQuery({
    workflowType: selectedType,
    status: selectedStatus,
    limit: 50,
  });

  const { data: stats } = trpc.workflows.getStats.useQuery({
    workflowType: selectedType,
  });

  const { data: workflowDetails } = trpc.workflows.getDetails.useQuery(
    { workflowId: selectedWorkflow! },
    { enabled: !!selectedWorkflow }
  );

  const cancelMutation = trpc.workflows.cancel.useMutation({
    onSuccess: () => {
      toast.success('Workflow cancelled successfully');
      setCancelDialogOpen(false);
      setReason('');
      refetch();
    },
    onError: (error) => {
      toast.error(`Failed to cancel workflow: ${error.message}`);
    },
  });

  const terminateMutation = trpc.workflows.terminate.useMutation({
    onSuccess: () => {
      toast.success('Workflow terminated successfully');
      setTerminateDialogOpen(false);
      setReason('');
      refetch();
    },
    onError: (error) => {
      toast.error(`Failed to terminate workflow: ${error.message}`);
    },
  });

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'running':
        return <Activity className="h-4 w-4 text-blue-500 animate-pulse" />;
      case 'completed':
        return <CheckCircle2 className="h-4 w-4 text-green-500" />;
      case 'failed':
        return <XCircle className="h-4 w-4 text-red-500" />;
      case 'cancelled':
        return <Square className="h-4 w-4 text-gray-500" />;
      case 'terminated':
        return <AlertTriangle className="h-4 w-4 text-orange-500" />;
      default:
        return <Clock className="h-4 w-4 text-gray-400" />;
    }
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
      running: 'default',
      completed: 'secondary',
      failed: 'destructive',
      cancelled: 'outline',
      terminated: 'destructive',
    };

    return (
      <Badge variant={variants[status] || 'outline'} className="capitalize">
        {status}
      </Badge>
    );
  };

  const formatDuration = (ms?: number) => {
    if (!ms) return 'N/A';
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  };

  const handleCancel = () => {
    if (!selectedWorkflow || !reason.trim()) return;
    cancelMutation.mutate({ workflowId: selectedWorkflow, reason });
  };

  const handleTerminate = () => {
    if (!selectedWorkflow || !reason.trim()) return;
    terminateMutation.mutate({ workflowId: selectedWorkflow, reason });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Workflow Monitoring</h1>
        <p className="text-muted-foreground">Monitor and control Temporal workflow executions</p>
      </div>

      {/* Statistics Cards */}
      {stats && (
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Total Workflows</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.total}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Running</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-blue-600">{stats.running}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Success Rate</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">{stats.successRate.toFixed(1)}%</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Avg Duration</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{formatDuration(stats.avgExecutionTime)}</div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-4">
          <div className="flex-1">
            <Label>Workflow Type</Label>
            <Select value={selectedType || 'all'} onValueChange={(v) => setSelectedType(v === 'all' ? undefined : v as WorkflowType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="processPayment">Payment Processing</SelectItem>
                <SelectItem value="refundWorkflow">Refund</SelectItem>
                <SelectItem value="orchestrateDREvent">DR Event</SelectItem>
                <SelectItem value="cancelDREventWorkflow">DR Event Cancellation</SelectItem>
                <SelectItem value="executeTrade">Trade Execution</SelectItem>
                <SelectItem value="automatedTradingWorkflow">Automated Trading</SelectItem>
                <SelectItem value="p2pTradingWorkflow">P2P Trading</SelectItem>
                <SelectItem value="prepaidIssuanceWorkflow">Prepaid Issuance</SelectItem>
                <SelectItem value="prepaidConsumptionSweepWorkflow">Prepaid Consumption Sweep</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex-1">
            <Label>Status</Label>
            <Select value={selectedStatus || 'all'} onValueChange={(v) => setSelectedStatus(v === 'all' ? undefined : v as WorkflowStatus)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="running">Running</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
                <SelectItem value="terminated">Terminated</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-end">
            <Button onClick={() => refetch()} variant="outline">
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Workflow List */}
      <Card>
        <CardHeader>
          <CardTitle>Workflows</CardTitle>
          <CardDescription>Click on a workflow to view details and control execution</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : workflows && workflows.length > 0 ? (
            <div className="space-y-2">
              {workflows.map((workflow) => (
                <div
                  key={workflow.workflowId}
                  className="flex items-center justify-between p-4 border rounded-lg hover:bg-accent cursor-pointer"
                  onClick={() => setSelectedWorkflow(workflow.workflowId)}
                >
                  <div className="flex items-center gap-4 flex-1">
                    {getStatusIcon(workflow.status)}
                    <div className="flex-1">
                      <div className="font-medium">{workflow.workflowId}</div>
                      <div className="text-sm text-muted-foreground">{workflow.workflowType}</div>
                    </div>
                    <div className="text-sm text-muted-foreground">
                      Started: {new Date(workflow.startTime).toLocaleString()}
                    </div>
                    {workflow.executionTime && (
                      <div className="text-sm text-muted-foreground">
                        Duration: {formatDuration(workflow.executionTime)}
                      </div>
                    )}
                    {getStatusBadge(workflow.status)}
                  </div>

                  {workflow.status === 'running' && (
                    <div className="flex gap-2 ml-4">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedWorkflow(workflow.workflowId);
                          setCancelDialogOpen(true);
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedWorkflow(workflow.workflowId);
                          setTerminateDialogOpen(true);
                        }}
                      >
                        Terminate
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No workflows found
            </div>
          )}
        </CardContent>
      </Card>

      {/* Workflow Details Dialog */}
      {workflowDetails && (
        <Dialog open={!!selectedWorkflow} onOpenChange={() => setSelectedWorkflow(null)}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>{workflowDetails.workflowId}</DialogTitle>
              <DialogDescription>{workflowDetails.workflowType}</DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div>
                <Label>Status</Label>
                <div className="mt-1">{getStatusBadge(workflowDetails.status)}</div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Start Time</Label>
                  <div className="mt-1 text-sm">{new Date(workflowDetails.startTime).toLocaleString()}</div>
                </div>

                {workflowDetails.closeTime && (
                  <div>
                    <Label>Close Time</Label>
                    <div className="mt-1 text-sm">{new Date(workflowDetails.closeTime).toLocaleString()}</div>
                  </div>
                )}
              </div>

              {workflowDetails.executionTime && (
                <div>
                  <Label>Execution Time</Label>
                  <div className="mt-1 text-sm">{formatDuration(workflowDetails.executionTime)}</div>
                </div>
              )}

              {workflowDetails.input && (
                <div>
                  <Label>Input</Label>
                  <pre className="mt-1 p-2 bg-muted rounded text-xs overflow-auto max-h-40">
                    {JSON.stringify(workflowDetails.input, null, 2)}
                  </pre>
                </div>
              )}

              {workflowDetails.result && (
                <div>
                  <Label>Result</Label>
                  <pre className="mt-1 p-2 bg-muted rounded text-xs overflow-auto max-h-40">
                    {JSON.stringify(workflowDetails.result, null, 2)}
                  </pre>
                </div>
              )}

              {workflowDetails.error && (
                <div>
                  <Label>Error</Label>
                  <div className="mt-1 p-2 bg-destructive/10 text-destructive rounded text-sm">
                    {workflowDetails.error}
                  </div>
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Cancel Dialog */}
      <Dialog open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel Workflow</DialogTitle>
            <DialogDescription>
              Are you sure you want to cancel this workflow? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label htmlFor="cancel-reason">Reason *</Label>
              <Textarea
                id="cancel-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Enter reason for cancellation..."
                rows={3}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelDialogOpen(false)}>
              Close
            </Button>
            <Button
              onClick={handleCancel}
              disabled={!reason.trim() || cancelMutation.isPending}
            >
              {cancelMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Cancel Workflow
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Terminate Dialog */}
      <Dialog open={terminateDialogOpen} onOpenChange={setTerminateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Terminate Workflow</DialogTitle>
            <DialogDescription>
              Are you sure you want to terminate this workflow? This will forcefully stop execution.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label htmlFor="terminate-reason">Reason *</Label>
              <Textarea
                id="terminate-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Enter reason for termination..."
                rows={3}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setTerminateDialogOpen(false)}>
              Close
            </Button>
            <Button
              variant="destructive"
              onClick={handleTerminate}
              disabled={!reason.trim() || terminateMutation.isPending}
            >
              {terminateMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Terminate Workflow
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
