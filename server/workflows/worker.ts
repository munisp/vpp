/**
 * Temporal Worker for Payment Workflows
 * 
 * This worker processes payment workflows from the Temporal server.
 * It should be run as a separate process for scalability.
 */

import { createRequire } from 'node:module';

import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './payment-activities';

// The package is ESM, so `require` is not in scope; the workflow bundler still
// wants a resolved path to the workflow module.
const require = createRequire(import.meta.url);

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
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[Temporal Worker] Received SIGINT, shutting down gracefully...');
  process.exit(0);
});
