import { getTemporalClient, TASK_QUEUES } from './temporal-config';
import { Client, ScheduleOverlapPolicy, WorkflowHandle } from '@temporalio/client';
import { OpenTelemetryWorkflowClientInterceptor } from '@temporalio/interceptors-opentelemetry/lib/client';

let instrumentedClient: Client | null = null;

/**
 * Temporal client carrying the OpenTelemetry interceptor. Every workflow
 * start/signal is wrapped in a client span and the active W3C trace context
 * is injected into the workflow headers (`_tracer-data` payload), where the
 * worker-side interceptors (server/_core/telemetry.ts temporalWorkerTelemetry)
 * extract it — so a trace that begins at an HTTP request continues through
 * the workflow and its activities. Shares the singleton connection from
 * temporal-config; when telemetry is disabled the global tracer is a no-op
 * and the interceptor is inert.
 */
async function getInstrumentedTemporalClient(): Promise<Client> {
  if (instrumentedClient) return instrumentedClient;
  const base = await getTemporalClient();
  instrumentedClient = new Client({
    connection: base.connection,
    namespace: base.options.namespace,
    interceptors: { workflow: [new OpenTelemetryWorkflowClientInterceptor()] },
  });
  return instrumentedClient;
}

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
    const client = await getInstrumentedTemporalClient();
    
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
    const client = await getInstrumentedTemporalClient();
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
    const client = await getInstrumentedTemporalClient();
    const handle = client.workflow.getHandle(`payment-${paymentId}`);
    
    try {
      await handle.cancel();
      console.log(`[Temporal] Cancelled payment workflow: ${paymentId}`);
    } catch (error) {
      console.error(`[Temporal] Error cancelling payment workflow:`, error);
      throw error;
    }
  }

  /**
   * Start a refund workflow (`refundWorkflow` in server/workflows/payment-workflow.ts,
   * registered by server/workflows/worker.ts on the payment-processing queue).
   *
   * The workflow runs the gateway refund and reverts the billing row, so the
   * caller gets a durable execution instead of an in-process attempt lost on
   * restart. Idempotent per transaction: a second start for the same
   * transactionId raises WorkflowExecutionAlreadyStartedError, which callers
   * can treat as "refund already running".
   */
  async startRefundWorkflow(input: {
    transactionId: string;
    gateway: 'mpesa' | 'airtel' | 'tigo';
    userId: number;
    billingId: number;
  }): Promise<WorkflowHandle> {
    const client = await getInstrumentedTemporalClient();

    const handle = await client.workflow.start('refundWorkflow', {
      taskQueue: TASK_QUEUES.PAYMENT_PROCESSING,
      workflowId: `refund-${input.transactionId}`,
      args: [input.transactionId, input.gateway, input.userId, input.billingId],
      searchAttributes: {
        PaymentId: [input.transactionId],
        UserId: [input.userId.toString()],
        Gateway: [input.gateway]
      }
    });

    console.log(`[Temporal] Started refund workflow: ${handle.workflowId}`);
    return handle;
  }

  // DR event workflows
  async startDREventWorkflow(input: DREventWorkflowInput): Promise<WorkflowHandle> {
    const client = await getInstrumentedTemporalClient();
    
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
    const client = await getInstrumentedTemporalClient();
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
    const client = await getInstrumentedTemporalClient();
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
    const client = await getInstrumentedTemporalClient();
    
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
    const client = await getInstrumentedTemporalClient();
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

  /**
   * Start a DR event cancellation workflow (`cancelDREventWorkflow` in
   * server/workflows/dr-event-workflow.ts, registered by
   * server/workflows/dr-worker.ts on the dr-orchestration queue). It marks the
   * event cancelled and notifies enrolled participants; the running
   * `orchestrateDREvent` execution for the same event can be cancelled via
   * temporalQueryService.cancelWorkflow(`dr-event-${eventId}`).
   */
  async startCancelDREventWorkflow(eventId: number, reason: string): Promise<WorkflowHandle> {
    const client = await getInstrumentedTemporalClient();

    const handle = await client.workflow.start('cancelDREventWorkflow', {
      taskQueue: TASK_QUEUES.DR_ORCHESTRATION,
      workflowId: `cancel-dr-event-${eventId}`,
      args: [eventId, reason],
      searchAttributes: {
        EventId: [eventId.toString()]
      }
    });

    console.log(`[Temporal] Started DR event cancellation workflow: ${handle.workflowId}`);
    return handle;
  }

  // NOTE: reconciliation and notification workflow starters were removed.
  // They dispatched 'reconcilePayments' / 'sendNotification' /
  // 'sendBatchNotifications' to the RECONCILIATION and NOTIFICATIONS task
  // queues, but no workflow definition or worker consumes those queues, so
  // every dispatch was silently dead. Reintroduce a starter only together
  // with a worker that registers the workflow type.

  // Health check
  async isHealthy(): Promise<boolean> {
    try {
      const client = await getInstrumentedTemporalClient();
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

/**
 * Idempotently create the Temporal Schedules this platform relies on.
 *
 * The server entry point (server/_core/index.ts) must call this once at boot;
 * it is safe to call on every replica and every restart — an existing schedule
 * is described and left untouched rather than overwritten.
 *
 * Currently ensured:
 *   - `prepaid-consumption-sweep`: daily at 03:15, starts
 *     `prepaidConsumptionSweepWorkflow` (server/workflows/prepaid-issuance-workflow.ts,
 *     registered by server/workflows/prepaid-worker.ts on the prepaid-issuance
 *     queue) so prepaid accounts' metered consumption is swept into billed
 *     segments even when nobody triggers it by hand.
 *
 * When `prepaidSweepAccountIds` is empty the scheduled workflow sweeps every
 * prepaid account at run time (sweep-all semantics in the workflow), so new
 * accounts are picked up without re-registering the schedule.
 */
export async function ensureSchedules(options: {
  prepaidSweepAccountIds?: number[];
} = {}): Promise<void> {
  const scheduleId = 'prepaid-consumption-sweep';
  // An empty list means sweep-all: the workflow resolves every prepaid
  // account at run time, so accounts opened after this schedule was created
  // are included without re-registering the schedule.
  const accountIds = options.prepaidSweepAccountIds ?? [];

  const client = await getTemporalClient();
  const existing = client.schedule.getHandle(scheduleId);
  try {
    await existing.describe();
    console.log(`[Temporal] Schedule ${scheduleId} already exists; leaving it as-is.`);
    return;
  } catch {
    // Not found: create it below. Any other failure surfaces from create().
  }

  await client.schedule.create({
    scheduleId,
    spec: {
      cronExpressions: ['15 3 * * *']
    },
    action: {
      type: 'startWorkflow',
      workflowType: 'prepaidConsumptionSweepWorkflow',
      taskQueue: TASK_QUEUES.PREPAID_ISSUANCE,
      args: [{ accountIds }]
    },
    policies: {
      // A sweep still running at the next tick is skipped, not overlapped:
      // overlapping sweeps would record the same consumption segment twice.
      overlap: ScheduleOverlapPolicy.SKIP,
      catchupWindow: '1 hour'
    }
  });

  console.log(
    `[Temporal] Created schedule ${scheduleId} (daily 03:15) sweeping ` +
    (accountIds.length > 0 ? `${accountIds.length} prepaid account(s).` : 'all prepaid accounts.')
  );
}
