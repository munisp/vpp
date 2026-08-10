# Temporal Payment Workflows

This directory contains Temporal workflow definitions and activities for reliable payment processing.

## Overview

The payment workflow orchestrates the complete payment lifecycle:

1. **Initiate Payment** - Send payment request to gateway (M-Pesa, Airtel, Tigo)
2. **Verify Payment** - Poll gateway for payment confirmation (with retries)
3. **Update Records** - Update payment and billing status in database
4. **Send Notifications** - Notify user of payment success/failure
5. **Compensation** - Automatic rollback on failure

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Payment Workflow                          │
│  (Orchestrates activities with retry & timeout handling)    │
└─────────────────────────────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
        ▼                   ▼                   ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│   Initiate   │    │    Verify    │    │    Update    │
│   Payment    │───▶│   Payment    │───▶│   Records    │
│   Activity   │    │   Activity   │    │   Activity   │
└──────────────┘    └──────────────┘    └──────────────┘
        │                   │                   │
        ▼                   ▼                   ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│   Payment    │    │   Gateway    │    │   Database   │
│   Gateway    │    │   Status     │    │   Updates    │
│   Manager    │    │   Query      │    │   + Kafka    │
└──────────────┘    └──────────────┘    └──────────────┘
```

## Files

### `payment-activities.ts`

Individual activities that perform specific tasks:

- **initiatePaymentActivity** - Calls payment gateway to initiate payment
- **verifyPaymentActivity** - Queries payment status from gateway
- **updatePaymentStatusActivity** - Updates payment record in database
- **updateBillingStatusActivity** - Updates billing record status
- **sendPaymentNotificationActivity** - Sends email/SMS notifications
- **refundPaymentActivity** - Processes payment refunds

Each activity is:
- **Idempotent** - Can be safely retried
- **Deterministic** - Same input produces same output
- **Isolated** - No shared state between activities

### `payment-workflow.ts`

Workflow definitions that orchestrate activities:

- **paymentWorkflow** - Main payment processing workflow
- **refundWorkflow** - Payment refund workflow

Workflows provide:
- **Retry Logic** - Automatic retries on transient failures
- **Timeout Handling** - Configurable timeouts for each step
- **Compensation** - Automatic rollback on failure
- **Durability** - Workflow state persists across failures

## Integration with Temporal Server

### Prerequisites

The VPP platform integrates with the Temporal server running in the `nextgen_vpp_platform`:

```bash
# Temporal server should be running at:
# http://localhost:7233 (gRPC)
# http://localhost:8233 (Web UI)
```

### Worker Setup

To run Temporal workers that execute payment workflows:

```bash
# Install Temporal SDK
cd /home/ubuntu/vpp_consumer_platform
pnpm add @temporalio/worker @temporalio/workflow @temporalio/activity @temporalio/client

# Create worker script
# See: server/workflows/worker.ts (to be created)
```

### Example Worker Implementation

```typescript
// server/workflows/worker.ts
import { Worker } from '@temporalio/worker';
import * as activities from './payment-activities';

async function run() {
  const worker = await Worker.create({
    workflowsPath: require.resolve('./payment-workflow'),
    activities,
    taskQueue: 'payment-processing',
    maxConcurrentActivityTaskExecutions: 10,
  });

  console.log('[Temporal Worker] Starting payment workflow worker...');
  await worker.run();
}

run().catch((err) => {
  console.error('[Temporal Worker] Fatal error:', err);
  process.exit(1);
});
```

### Starting a Workflow

From your tRPC router or API endpoint:

```typescript
import { Connection, Client } from '@temporalio/client';
import { paymentWorkflow } from './workflows/payment-workflow';

// Create Temporal client
const connection = await Connection.connect({
  address: 'localhost:7233',
});

const client = new Client({ connection });

// Start payment workflow
const handle = await client.workflow.start(paymentWorkflow, {
  taskQueue: 'payment-processing',
  workflowId: `payment-${billingId}-${Date.now()}`,
  args: [{
    userId: 123,
    billingId: 456,
    amount: 50000, // TZS 500.00
    gateway: 'mpesa',
    phoneNumber: '+255712345678',
  }],
});

// Wait for result (or return handle for async processing)
const result = await handle.result();
console.log('Payment result:', result);
```

## Workflow Features

### Retry Policies

Activities are configured with exponential backoff:

```typescript
retryPolicy: {
  initialInterval: '1s',      // First retry after 1 second
  backoffCoefficient: 2,       // Double interval each retry
  maximumInterval: '60s',      // Max 60 seconds between retries
  maximumAttempts: 5,          // Max 5 retry attempts
}
```

### Timeouts

Workflows have multiple timeout configurations:

- **workflowExecutionTimeout**: Maximum time for entire workflow (10 minutes)
- **workflowRunTimeout**: Maximum time for single workflow run (5 minutes)
- **workflowTaskTimeout**: Maximum time for workflow task execution (30 seconds)

### Compensation

On workflow failure, compensation activities automatically:

1. Mark payment as `failed` in database
2. Revert billing status to `issued`
3. Send failure notification to user
4. Publish failure event to Kafka

## Monitoring

### Temporal Web UI

Access the Temporal Web UI to monitor workflows:

```
http://localhost:8233
```

Features:
- View all workflow executions
- Inspect workflow history
- Retry failed workflows
- View activity execution details
- Monitor task queue backlogs

### Metrics

Temporal provides built-in metrics:

- Workflow execution count
- Activity execution count
- Task queue latency
- Worker utilization
- Workflow success/failure rates

### Kafka Events

All payment workflows publish events to Kafka:

- `payment.initiated` - Payment request sent to gateway
- `payment.completed` - Payment confirmed by gateway
- `payment.failed` - Payment failed or timeout

These events enable:
- Real-time analytics dashboards
- Audit trail for compliance
- Downstream system integration
- Alerting and monitoring

## Testing

### Unit Tests

Test individual activities:

```typescript
import { initiatePaymentActivity } from './payment-activities';

describe('initiatePaymentActivity', () => {
  it('should initiate M-Pesa payment', async () => {
    const result = await initiatePaymentActivity({
      userId: 1,
      billingId: 1,
      amount: 50000,
      gateway: 'mpesa',
      phoneNumber: '+255712345678',
    });

    expect(result.success).toBe(true);
    expect(result.transactionId).toBeDefined();
  });
});
```

### Integration Tests

Test complete workflow:

```typescript
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { paymentWorkflow } from './payment-workflow';
import * as activities from './payment-activities';

describe('paymentWorkflow', () => {
  let testEnv: TestWorkflowEnvironment;

  beforeAll(async () => {
    testEnv = await TestWorkflowEnvironment.createLocal();
  });

  afterAll(async () => {
    await testEnv?.teardown();
  });

  it('should complete payment successfully', async () => {
    const { client } = testEnv;
    
    const handle = await client.workflow.start(paymentWorkflow, {
      taskQueue: 'test-queue',
      workflowId: 'test-payment-1',
      args: [{
        userId: 1,
        billingId: 1,
        amount: 50000,
        gateway: 'mpesa',
        phoneNumber: '+255712345678',
      }],
    });

    const result = await handle.result();
    expect(result.success).toBe(true);
  });
});
```

## Production Deployment

### Worker Deployment

Deploy Temporal workers as separate services:

```bash
# Using systemd
sudo systemctl start vpp-temporal-worker

# Using Docker
docker run -d \
  --name vpp-temporal-worker \
  --network nextgen_vpp_network \
  -e TEMPORAL_ADDRESS=temporal:7233 \
  vpp-consumer-platform:latest \
  node server/workflows/worker.js
```

### Scaling

Scale workers horizontally for high throughput:

```bash
# Run multiple worker instances
docker-compose scale temporal-worker=5
```

Workers automatically:
- Load balance across task queue
- Handle activity execution
- Report metrics to Temporal server

### High Availability

For production reliability:

1. **Multiple Workers** - Run workers across multiple hosts
2. **Health Checks** - Monitor worker health and restart on failure
3. **Graceful Shutdown** - Allow in-flight activities to complete
4. **Circuit Breakers** - Prevent cascading failures to payment gateways

## Current Status

✅ **Completed:**
- Payment activity definitions
- Workflow orchestration logic
- Kafka event integration
- Error handling and compensation
- Documentation

⏳ **Pending:**
- Temporal SDK installation
- Worker implementation
- Temporal client integration in tRPC routers
- Production deployment configuration

## Next Steps

1. **Install Temporal SDK** - Add `@temporalio/worker`, `@temporalio/workflow`, `@temporalio/client`
2. **Create Worker** - Implement `server/workflows/worker.ts`
3. **Update Payment Router** - Replace direct payment processing with Temporal workflow execution
4. **Deploy Workers** - Add worker to Docker Compose and systemd services
5. **Monitor** - Set up Temporal Web UI access and metrics dashboards

## Resources

- [Temporal Documentation](https://docs.temporal.io/)
- [Temporal TypeScript SDK](https://typescript.temporal.io/)
- [Workflow Patterns](https://docs.temporal.io/workflows)
- [Activity Best Practices](https://docs.temporal.io/activities)
