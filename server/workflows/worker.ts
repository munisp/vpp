/**
 * Temporal Worker for Payment Workflows
 * 
 * This worker processes payment workflows from the Temporal server.
 * It should be run as a separate process for scalability.
 */

// OTel init must run before anything else loads (auto-instrumentation hooks).
// This worker has no HTTP server: its Prometheus exporter listens on
// OTEL_PROMETHEUS_PORT, default 9091 (see server/_core/telemetry.ts).
import { temporalWorkerTelemetry, withTelemetryShutdown } from '../_core/telemetry';
import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './payment-activities';

async function run() {
  // Connect to Temporal server
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS || 'localhost:7233',
  });

  console.log('[Temporal Worker] Connected to Temporal server');

  // Create worker
  const worker = await Worker.create({
    connection,
    namespace: 'default',
    taskQueue: 'payment-processing',
    workflowsPath: require.resolve('./payment-workflow'),
    activities,
    maxConcurrentActivityTaskExecutions: 10,
    maxConcurrentWorkflowTaskExecutions: 100,
    // OTel workflow/activity interceptors + workflow span sink (undefined
    // when telemetry is disabled, e.g. OTEL_SDK_DISABLED=true).
    ...(await temporalWorkerTelemetry()),
  });

  console.log('[Temporal Worker] Worker created for task queue: payment-processing');
  console.log('[Temporal Worker] Max concurrent activities: 10');
  console.log('[Temporal Worker] Max concurrent workflows: 100');

  // Run worker
  await worker.run();
}

run().catch((err) => {
  console.error('[Temporal Worker] Fatal error:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[Temporal Worker] Received SIGTERM, shutting down gracefully...');
  await withTelemetryShutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[Temporal Worker] Received SIGINT, shutting down gracefully...');
  await withTelemetryShutdown();
  process.exit(0);
});
