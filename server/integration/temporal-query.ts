/**
 * Temporal Workflow Query Integration
 * 
 * Provides methods to query workflow status and control workflow execution
 * Production-ready with real Temporal client integration
 */

import { getTemporalClient, temporalConfig } from './temporal-config';
import { WorkflowExecutionInfo } from '@temporalio/client';

export interface WorkflowListOptions {
  workflowType?: string;
  status?: 'running' | 'completed' | 'failed' | 'cancelled' | 'terminated';
  limit?: number;
  offset?: number;
}

export interface WorkflowExecution {
  workflowId: string;
  runId: string;
  workflowType: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'terminated';
  startTime: Date;
  closeTime?: Date;
  executionTime?: number; // milliseconds
  input?: any;
  result?: any;
  error?: string;
}

export interface WorkflowStats {
  total: number;
  running: number;
  completed: number;
  failed: number;
  avgExecutionTime: number;
  successRate: number;
}

// Map Temporal status to our status type
function mapWorkflowStatus(status: string): WorkflowExecution['status'] {
  const statusMap: Record<string, WorkflowExecution['status']> = {
    'RUNNING': 'running',
    'COMPLETED': 'completed',
    'FAILED': 'failed',
    'CANCELED': 'cancelled',
    'CANCELLED': 'cancelled',
    'TERMINATED': 'terminated',
    'CONTINUED_AS_NEW': 'running',
    'TIMED_OUT': 'failed',
  };
  return statusMap[status] || 'running';
}

class TemporalQueryService {
  private temporalAddress: string;
  private namespace: string;

  constructor() {
    this.temporalAddress = temporalConfig.address;
    this.namespace = temporalConfig.namespace;
  }

  /**
   * List workflows with filters using real Temporal client
   */
  async listWorkflows(options: WorkflowListOptions = {}): Promise<WorkflowExecution[]> {
    try {
      const client = await getTemporalClient();
      const workflows: WorkflowExecution[] = [];

      // Build query string for Temporal
      const queryParts: string[] = [];
      
      if (options.workflowType) {
        queryParts.push(`WorkflowType = '${options.workflowType}'`);
      }
      
      if (options.status) {
        const statusMap: Record<string, string> = {
          'running': 'Running',
          'completed': 'Completed',
          'failed': 'Failed',
          'cancelled': 'Canceled',
          'terminated': 'Terminated',
        };
        queryParts.push(`ExecutionStatus = '${statusMap[options.status] || options.status}'`);
      }

      const query = queryParts.length > 0 ? queryParts.join(' AND ') : undefined;
      const limit = options.limit || 50;

      // Use Temporal's list workflows API with pagination
      const workflowIterator = client.workflow.list({
        query,
        pageSize: limit,
      });

      let count = 0;
      const offset = options.offset || 0;
      let skipped = 0;

      for await (const workflow of workflowIterator) {
        // Skip for offset
        if (skipped < offset) {
          skipped++;
          continue;
        }

        // Stop at limit
        if (count >= limit) break;

        // Extract type and status - Temporal SDK returns these as objects with name property
        const workflowType = (workflow as any).type?.name || String((workflow as any).type) || 'Unknown';
        const workflowStatus = (workflow as any).status?.name || String((workflow as any).status) || 'RUNNING';
        
        const execution: WorkflowExecution = {
          workflowId: workflow.workflowId,
          runId: workflow.runId,
          workflowType,
          status: mapWorkflowStatus(workflowStatus),
          startTime: workflow.startTime,
          closeTime: workflow.closeTime || undefined,
          executionTime: workflow.closeTime && workflow.startTime
            ? workflow.closeTime.getTime() - workflow.startTime.getTime()
            : undefined,
        };

        workflows.push(execution);
        count++;
      }

      console.log(`[Temporal Query] Listed ${workflows.length} workflows`);
      return workflows;
    } catch (error: any) {
      console.error('[Temporal Query] List workflows error:', error);
      // Return empty array on connection failure instead of throwing
      // This allows the UI to still function when Temporal is unavailable
      if (error.message?.includes('UNAVAILABLE') || error.message?.includes('connect')) {
        console.warn('[Temporal Query] Temporal server unavailable, returning empty list');
        return [];
      }
      throw new Error(`Failed to list workflows: ${error.message}`);
    }
  }

  /**
   * Get workflow details using real Temporal client
   */
  async getWorkflowDetails(workflowId: string): Promise<WorkflowExecution | null> {
    try {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(workflowId);
      
      const description = await handle.describe();
      
      // Extract type and status - Temporal SDK returns these as objects with name property
      const workflowType = (description as any).type?.name || String((description as any).type) || 'Unknown';
      const workflowStatus = (description as any).status?.name || String((description as any).status) || 'RUNNING';
      
      const execution: WorkflowExecution = {
        workflowId: description.workflowId,
        runId: description.runId,
        workflowType,
        status: mapWorkflowStatus(workflowStatus),
        startTime: description.startTime,
        closeTime: description.closeTime || undefined,
        executionTime: description.closeTime && description.startTime
          ? description.closeTime.getTime() - description.startTime.getTime()
          : undefined,
      };

      return execution;
    } catch (error: any) {
      console.error('[Temporal Query] Get workflow details error:', error);
      // Return null if workflow not found
      if (error.message?.includes('not found') || error.code === 5) {
        return null;
      }
      throw new Error(`Failed to get workflow details: ${error.message}`);
    }
  }

  /**
   * Get workflow statistics
   */
  async getWorkflowStats(workflowType?: string): Promise<WorkflowStats> {
    try {
      const workflows = await this.listWorkflows({ workflowType });

      const stats: WorkflowStats = {
        total: workflows.length,
        running: workflows.filter(w => w.status === 'running').length,
        completed: workflows.filter(w => w.status === 'completed').length,
        failed: workflows.filter(w => w.status === 'failed').length,
        avgExecutionTime: 0,
        successRate: 0,
      };

      // Calculate average execution time
      const completedWorkflows = workflows.filter(w => w.executionTime);
      if (completedWorkflows.length > 0) {
        stats.avgExecutionTime = completedWorkflows.reduce((sum, w) => sum + (w.executionTime || 0), 0) / completedWorkflows.length;
      }

      // Calculate success rate
      const finishedWorkflows = workflows.filter(w => w.status === 'completed' || w.status === 'failed');
      if (finishedWorkflows.length > 0) {
        stats.successRate = (stats.completed / finishedWorkflows.length) * 100;
      }

      return stats;
    } catch (error: any) {
      console.error('[Temporal Query] Get workflow stats error:', error);
      throw new Error(`Failed to get workflow stats: ${error.message}`);
    }
  }

  /**
   * Cancel workflow using real Temporal client
   */
  async cancelWorkflow(workflowId: string, reason: string): Promise<boolean> {
    try {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(workflowId);
      
      await handle.cancel();
      console.log(`[Temporal Query] Cancelled workflow ${workflowId}: ${reason}`);
      
      return true;
    } catch (error: any) {
      console.error('[Temporal Query] Cancel workflow error:', error);
      throw new Error(`Failed to cancel workflow: ${error.message}`);
    }
  }

  /**
   * Terminate workflow using real Temporal client
   */
  async terminateWorkflow(workflowId: string, reason: string): Promise<boolean> {
    try {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(workflowId);
      
      await handle.terminate(reason);
      console.log(`[Temporal Query] Terminated workflow ${workflowId}: ${reason}`);
      
      return true;
    } catch (error: any) {
      console.error('[Temporal Query] Terminate workflow error:', error);
      throw new Error(`Failed to terminate workflow: ${error.message}`);
    }
  }

  /**
   * Get workflow history using real Temporal client
   */
  async getWorkflowHistory(workflowId: string): Promise<any[]> {
    try {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(workflowId);
      
      const history: any[] = [];
      const historyResult = await handle.fetchHistory();
      
      if (historyResult && historyResult.events) {
        for (const event of historyResult.events) {
          history.push({
            eventId: event.eventId?.toString(),
            eventType: event.eventType,
            timestamp: event.eventTime,
            attributes: event,
          });
        }
      }

      console.log(`[Temporal Query] Retrieved ${history.length} history events for workflow ${workflowId}`);
      return history;
    } catch (error: any) {
      console.error('[Temporal Query] Get workflow history error:', error);
      // Return empty array if workflow not found
      if (error.message?.includes('not found') || error.code === 5) {
        return [];
      }
      throw new Error(`Failed to get workflow history: ${error.message}`);
    }
  }
}

// Singleton instance
export const temporalQueryService = new TemporalQueryService();
