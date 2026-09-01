/**
 * Temporal worker for prepaid / PAYG token issuance and metered consumption.
 *
 * Runs as its own process on its own task queue so a slow SMS provider or an
 * unreachable ledger delays prepaid vending only, and never payment capture or
 * trading.
 */

// OTel init must run before anything else loads (auto-instrumentation hooks).
// Prometheus metrics listener defaults to :9094 (see server/_core/telemetry.ts).
import { temporalWorkerTelemetry, withTelemetryShutdown } from '../_core/telemetry';
import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './prepaid-issuance-activities';
import { TASK_QUEUES } from '../integration/temporal-config';

const PREPAID_TASK_QUEUE = TASK_QUEUES.PREPAID_ISSUANCE;

async function run() {
  const temporalAddress = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
  console.log(`[Prepaid Worker] Connecting to Temporal at: ${temporalAddress}`);

  const connection = await NativeConnection.connect({ address: temporalAddress });
  console.log('[Prepaid Worker] Connected to Temporal server');

  const worker = await Worker.create({
    connection,
    namespace: 'default',
    taskQueue: PREPAID_TASK_QUEUE,
    workflowsPath: require.resolve('./prepaid-issuance-workflow'),
    activities,
    maxConcurrentActivityTaskExecutions: 20,
    maxConcurrentWorkflowTaskExecutions: 100,
    // OTel workflow/activity interceptors + workflow span sink.
    ...(await temporalWorkerTelemetry()),
  });

  console.log(`[Prepaid Worker] Worker created for task queue: ${PREPAID_TASK_QUEUE}`);
  await worker.run();
}

run().catch((err) => {
  console.error('[Prepaid Worker] Fatal error:', err);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  console.log('[Prepaid Worker] Received SIGTERM, shutting down gracefully...');
  await withTelemetryShutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[Prepaid Worker] Received SIGINT, shutting down gracefully...');
  await withTelemetryShutdown();
  process.exit(0);
});
