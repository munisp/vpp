import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CheckCircle2, Clock, XCircle, Play, Square, RefreshCw } from "lucide-react";

interface WorkflowStatusMonitorProps {
  className?: string;
}

export function WorkflowStatusMonitor({ className }: WorkflowStatusMonitorProps) {
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null);
  const [statusDialogOpen, setStatusDialogOpen] = useState(false);

  const utils = trpc.useUtils();

  // Query user workflows
  const { data: workflows = [], isLoading, refetch } = trpc.orchestrator.listUserWorkflows.useQuery();

  // Query specific workflow status
  const { data: workflowStatus } = trpc.orchestrator.getWorkflowStatus.useQuery(
    { workflowId: selectedWorkflow! },
    { enabled: !!selectedWorkflow }
  );

  // Cancel workflow mutation
  const cancelWorkflowMutation = trpc.orchestrator.cancelWorkflow.useMutation({
    onSuccess: () => {
      toast.success("Workflow cancelled successfully!");
      utils.orchestrator.listUserWorkflows.invalidate();
      setStatusDialogOpen(false);
    },
    onError: (error) => {
      toast.error(error.message || "Failed to cancel workflow");
    },
  });

  const getStatusBadge = (status: string) => {
    const variants: Record<string, { variant: "default" | "secondary" | "destructive" | "outline", icon: any }> = {
      running: { variant: "secondary", icon: Play },
      completed: { variant: "default", icon: CheckCircle2 },
      failed: { variant: "destructive", icon: XCircle },
      cancelled: { variant: "outline", icon: Square },
    };
    const config = variants[status] || variants.running;
    const Icon = config.icon;
    return (
      <Badge variant={config.variant} className="flex items-center gap-1 w-fit">
        <Icon className="h-3 w-3" />
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </Badge>
    );
  };

  const handleViewStatus = (workflowId: string) => {
    setSelectedWorkflow(workflowId);
    setStatusDialogOpen(true);
  };

  const handleCancelWorkflow = () => {
    if (selectedWorkflow) {
      cancelWorkflowMutation.mutate({ workflowId: selectedWorkflow });
    }
  };

  const formatDate = (date: string | Date) => {
    return new Date(date).toLocaleString();
  };

  const getWorkflowTypeName = (workflowId: string): string => {
    if (workflowId.includes("auto-trading")) return "Auto Trading";
    if (workflowId.includes("manual-trade")) return "Manual Trade";
    if (workflowId.includes("p2p-trade")) return "P2P Trade";
    if (workflowId.includes("dr-enrollment")) return "DR Enrollment";
    if (workflowId.includes("dr-forecasting")) return "DR Forecasting";
    if (workflowId.includes("payment")) return "Payment";
    if (workflowId.includes("qr-payment")) return "QR Payment";
    if (workflowId.includes("telemetry")) return "Telemetry Monitoring";
    if (workflowId.includes("alert")) return "Alert Processing";
    if (workflowId.includes("leaderboard")) return "Leaderboard Update";
    if (workflowId.includes("achievement")) return "Achievement Tracking";
    return "Unknown Workflow";
  };

  if (isLoading) {
    return (
      <Card className={className}>
        <CardHeader>
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-64 mt-2" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-64 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card className={className}>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Workflow Status Monitor</CardTitle>
              <CardDescription>Track your active and completed workflows</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {workflows.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Clock className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No workflows found</p>
              <p className="text-sm mt-1">Start a workflow from Assets, Trading, or DR Events pages</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead>Completed</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {workflows.map((workflow: any) => (
                    <TableRow key={workflow.workflowId}>
                      <TableCell className="font-medium">
                        {getWorkflowTypeName(workflow.workflowId)}
                      </TableCell>
                      <TableCell>{getStatusBadge(workflow.status)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDate(workflow.startTime)}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {workflow.endTime ? formatDate(workflow.endTime) : "-"}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleViewStatus(workflow.workflowId)}
                        >
                          View Details
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={statusDialogOpen} onOpenChange={setStatusDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Workflow Details</DialogTitle>
            <DialogDescription>
              View detailed information about this workflow execution
            </DialogDescription>
          </DialogHeader>
          {workflowStatus && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Workflow ID</p>
                  <p className="text-sm font-mono break-all">{workflowStatus.workflowId}</p>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Run ID</p>
                  <p className="text-sm font-mono break-all">{workflowStatus.runId}</p>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Status</p>
                  <div className="mt-1">{getStatusBadge(workflowStatus.status)}</div>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Type</p>
                  <p className="text-sm">{getWorkflowTypeName(workflowStatus.workflowId)}</p>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Started</p>
                  <p className="text-sm">{formatDate(workflowStatus.startTime)}</p>
                </div>
                {workflowStatus.endTime && (
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">Completed</p>
                    <p className="text-sm">{formatDate(workflowStatus.endTime)}</p>
                  </div>
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            {workflowStatus?.status === "running" && (
              <Button
                variant="destructive"
                onClick={handleCancelWorkflow}
                disabled={cancelWorkflowMutation.isPending}
              >
                <Square className="h-4 w-4 mr-2" />
                Cancel Workflow
              </Button>
            )}
            <Button variant="outline" onClick={() => setStatusDialogOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
