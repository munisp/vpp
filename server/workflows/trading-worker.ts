/**
 * Temporal Worker for Trading Workflows
 * 
 * This worker processes energy trading workflows from the Temporal server.
 * It should be run as a separate process for scalability.
 */

// OTel init must run before anything else loads (auto-instrumentation hooks).
// Prometheus metrics listener defaults to :9093 (see server/_core/telemetry.ts).
import { temporalWorkerTelemetry, withTelemetryShutdown } from '../_core/telemetry';
import { NativeConnection, Worker } from '@temporalio/worker';
import { tradingActivities } from './trading-activities';

async function run() {
  // Validate required environment variables
  const temporalAddress = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
  
  console.log('[Trading Worker] Starting Trading worker...');
  console.log(`[Trading Worker] Connecting to Temporal at: ${temporalAddress}`);

  // Connect to Temporal server
  const connection = await NativeConnection.connect({
    address: temporalAddress,
  });

  console.log('[Trading Worker] Connected to Temporal server');

  // Create worker
  const worker = await Worker.create({
    connection,
    namespace: 'default',
    taskQueue: 'trading-execution',
    workflowsPath: require.resolve('./trading-workflow'),
    activities: tradingActivities,
    maxConcurrentActivityTaskExecutions: 50,
    maxConcurrentWorkflowTaskExecutions: 200,
    // OTel workflow/activity interceptors + workflow span sink.
    ...(await temporalWorkerTelemetry()),
  });

  console.log('[Trading Worker] Worker created for task queue: trading-execution');
  console.log('[Trading Worker] Max concurrent activities: 50');
  console.log('[Trading Worker] Max concurrent workflows: 200');

  // Run worker
  await worker.run();
}

run().catch((err) => {
  console.error('[Trading Worker] Fatal error:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[Trading Worker] Received SIGTERM, shutting down gracefully...');
  await withTelemetryShutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[Trading Worker] Received SIGINT, shutting down gracefully...');
  await withTelemetryShutdown();
  process.exit(0);
});
