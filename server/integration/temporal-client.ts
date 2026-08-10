import { getTemporalClient, TASK_QUEUES } from './temporal-config';
import { WorkflowHandle } from '@temporalio/client';

export interface PaymentWorkflowInput {
  paymentId: string;
  userId: string;
  amount: number;
  currency: string;
  gateway: string;
  phoneNumber?: string;
  billingId?: number;
  metadata?: Record<string, any>;
}

export interface DREventWorkflowInput {
  eventId: string;
  type: string;
  startTime: Date;
  endTime: Date;
  targetReduction: number;
  compensationRate: number;
  participants: string[];
}

export interface ReconciliationWorkflowInput {
  date: string;
  gateway?: string;
}

export interface TradingWorkflowInput {
  tradeId: number;
  userId: number;
  tradeType: string;
  energy: number;
  price: number;
  counterpartyId?: number;
}

export class TemporalWorkflowClient {
  // Payment workflows
  async startPaymentWorkflow(input: PaymentWorkflowInput): Promise<WorkflowHandle> {
    const client = await getTemporalClient();
    
    const handle = await client.workflow.start('processPayment', {
      taskQueue: TASK_QUEUES.PAYMENT_PROCESSING,
      workflowId: `payment-${input.paymentId}`,
      args: [input],
      searchAttributes: {
        PaymentId: [input.paymentId],
        UserId: [input.userId],
        Gateway: [input.gateway]
      }
    });

    console.log(`[Temporal] Started payment workflow: ${handle.workflowId}`);
    return handle;
  }

  async getPaymentWorkflowStatus(paymentId: string): Promise<any> {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(`payment-${paymentId}`);
    
    try {
      const description = await handle.describe();
      return {
        status: description.status.name,
        runId: description.runId,
        startTime: description.startTime,
        closeTime: description.closeTime
      };
    } catch (error) {
      console.error(`[Temporal] Error getting payment workflow status:`, error);
      return null;
    }
  }

  async cancelPaymentWorkflow(paymentId: string): Promise<void> {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(`payment-${paymentId}`);
    
    try {
      await handle.cancel();
      console.log(`[Temporal] Cancelled payment workflow: ${paymentId}`);
    } catch (error) {
      console.error(`[Temporal] Error cancelling payment workflow:`, error);
      throw error;
    }
  }

  // DR event workflows
  async startDREventWorkflow(input: DREventWorkflowInput): Promise<WorkflowHandle> {
    const client = await getTemporalClient();
    
    const handle = await client.workflow.start('orchestrateDREvent', {
      taskQueue: TASK_QUEUES.DR_ORCHESTRATION,
      workflowId: `dr-event-${input.eventId}`,
      args: [input],
      searchAttributes: {
        EventId: [input.eventId],
        EventType: [input.type]
      }
    });

    console.log(`[Temporal] Started DR event workflow: ${handle.workflowId}`);
    return handle;
  }

  async getDREventWorkflowStatus(eventId: string): Promise<any> {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(`dr-event-${eventId}`);
    
    try {
      const description = await handle.describe();
      return {
        status: description.status.name,
        runId: description.runId,
        startTime: description.startTime,
        closeTime: description.closeTime
      };
    } catch (error) {
      console.error(`[Temporal] Error getting DR event workflow status:`, error);
      return null;
    }
  }

  async signalDREventWorkflow(eventId: string, signal: string, args?: any[]): Promise<void> {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(`dr-event-${eventId}`);
    
    try {
      await handle.signal(signal, args);
      console.log(`[Temporal] Sent signal ${signal} to DR event workflow: ${eventId}`);
    } catch (error) {
      console.error(`[Temporal] Error signaling DR event workflow:`, error);
      throw error;
    }
  }

  // Trading workflows
  async startTradingWorkflow(input: TradingWorkflowInput): Promise<WorkflowHandle> {
    const client = await getTemporalClient();
    
    const handle = await client.workflow.start('executeTrade', {
      taskQueue: TASK_QUEUES.TRADING_EXECUTION,
      workflowId: `trade-${input.tradeId}`,
      args: [input],
      searchAttributes: {
        TradeId: [input.tradeId.toString()],
        UserId: [input.userId.toString()],
        TradeType: [input.tradeType]
      }
    });

    console.log(`[Temporal] Started trading workflow: ${handle.workflowId}`);
    return handle;
  }

  async getTradingWorkflowStatus(tradeId: number): Promise<any> {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(`trade-${tradeId}`);
    
    try {
      const description = await handle.describe();
      return {
        status: description.status.name,
        runId: description.runId,
        startTime: description.startTime,
        closeTime: description.closeTime
      };
    } catch (error) {
      console.error(`[Temporal] Error getting trading workflow status:`, error);
      return null;
    }
  }

  // Reconciliation workflows
  async startReconciliationWorkflow(input: ReconciliationWorkflowInput): Promise<WorkflowHandle> {
    const client = await getTemporalClient();
    
    const workflowId = `reconciliation-${input.date}${input.gateway ? `-${input.gateway}` : ''}`;
    
    const handle = await client.workflow.start('reconcilePayments', {
      taskQueue: TASK_QUEUES.RECONCILIATION,
      workflowId,
      args: [input],
      searchAttributes: {
        ReconciliationDate: [input.date],
        ...(input.gateway && { Gateway: [input.gateway] })
      }
    });

    console.log(`[Temporal] Started reconciliation workflow: ${handle.workflowId}`);
    return handle;
  }

  async getReconciliationWorkflowResult(date: string, gateway?: string): Promise<any> {
    const client = await getTemporalClient();
    const workflowId = `reconciliation-${date}${gateway ? `-${gateway}` : ''}`;
    const handle = client.workflow.getHandle(workflowId);
    
    try {
      const result = await handle.result();
      return result;
    } catch (error) {
      console.error(`[Temporal] Error getting reconciliation result:`, error);
      return null;
    }
  }

  // Scheduled workflows
  async scheduleReconciliation(schedule: {
    scheduleId: string;
    spec: {
      cronExpressions: string[];
    };
    gateway?: string;
  }): Promise<void> {
    const client = await getTemporalClient();
    
    await client.schedule.create({
      scheduleId: schedule.scheduleId,
      spec: {
        cronExpressions: schedule.spec.cronExpressions
      },
      action: {
        type: 'startWorkflow',
        workflowType: 'reconcilePayments',
        taskQueue: TASK_QUEUES.RECONCILIATION,
        args: [{
          date: new Date().toISOString().split('T')[0],
          gateway: schedule.gateway
        }]
      }
    });

    console.log(`[Temporal] Created schedule: ${schedule.scheduleId}`);
  }

  // Notification workflows
  async startNotificationWorkflow(input: {
    userId: string;
    type: string;
    title: string;
    message: string;
    channels: string[];
  }): Promise<WorkflowHandle> {
    const client = await getTemporalClient();
    
    const handle = await client.workflow.start('sendNotification', {
      taskQueue: TASK_QUEUES.NOTIFICATIONS,
      workflowId: `notification-${Date.now()}-${input.userId}`,
      args: [input]
    });

    console.log(`[Temporal] Started notification workflow: ${handle.workflowId}`);
    return handle;
  }

  // Batch notification workflows
  async startBatchNotificationWorkflow(input: {
    userIds: string[];
    type: string;
    title: string;
    message: string;
    channels: string[];
  }): Promise<WorkflowHandle> {
    const client = await getTemporalClient();
    
    const handle = await client.workflow.start('sendBatchNotifications', {
      taskQueue: TASK_QUEUES.NOTIFICATIONS,
      workflowId: `batch-notification-${Date.now()}`,
      args: [input]
    });

    console.log(`[Temporal] Started batch notification workflow: ${handle.workflowId}`);
    return handle;
  }

  // Health check
  async isHealthy(): Promise<boolean> {
    try {
      const client = await getTemporalClient();
      // Simple connection check
      return client !== null && client.connection !== null;
    } catch (error) {
      console.error('[Temporal] Health check failed:', error);
      return false;
    }
  }
}

// Singleton instance
export const temporalClient = new TemporalWorkflowClient();
