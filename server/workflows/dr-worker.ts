/**
 * Temporal Worker for DR Event Workflows
 * 
 * This worker processes demand response event workflows from the Temporal server.
 * It should be run as a separate process for scalability.
 */

// OTel init must run before anything else loads (auto-instrumentation hooks).
// Prometheus metrics listener defaults to :9092 (see server/_core/telemetry.ts).
import { temporalWorkerTelemetry, withTelemetryShutdown } from '../_core/telemetry';
import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './dr-event-activities';

async function run() {
  // Validate required environment variables
  const temporalAddress = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
  
  console.log('[DR Worker] Starting DR Event worker...');
  console.log(`[DR Worker] Connecting to Temporal at: ${temporalAddress}`);

  // Connect to Temporal server
  const connection = await NativeConnection.connect({
    address: temporalAddress,
  });

  console.log('[DR Worker] Connected to Temporal server');

  // Create worker
  const worker = await Worker.create({
    connection,
    namespace: 'default',
    taskQueue: 'dr-orchestration',
    workflowsPath: require.resolve('./dr-event-workflow'),
    activities,
    maxConcurrentActivityTaskExecutions: 20,
    maxConcurrentWorkflowTaskExecutions: 100,
    // OTel workflow/activity interceptors + workflow span sink.
    ...(await temporalWorkerTelemetry()),
  });

  console.log('[DR Worker] Worker created for task queue: dr-orchestration');
  console.log('[DR Worker] Max concurrent activities: 20');
  console.log('[DR Worker] Max concurrent workflows: 100');

  // Run worker
  await worker.run();
}

run().catch((err) => {
  console.error('[DR Worker] Fatal error:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[DR Worker] Received SIGTERM, shutting down gracefully...');
  await withTelemetryShutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[DR Worker] Received SIGINT, shutting down gracefully...');
  await withTelemetryShutdown();
  process.exit(0);
});
