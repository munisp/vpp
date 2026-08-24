/**
 * Temporal worker for the stakeholder-journey task queue.
 *
 * Run it alongside the API (`npm run worker:journeys`). Journeys call the
 * platform's own services in-process, so this worker needs the same
 * environment the API has — database, Redis, provider configuration.
 */

import { createRequire } from 'node:module';

import { NativeConnection, Worker } from '@temporalio/worker';

import { TASK_QUEUES, temporalConfig } from '../integration/temporal-config';
import * as activities from './journey-activities';

// The package is ESM, so `require` is not in scope; the workflow bundler still
// wants a resolved path to the workflow module.
const require = createRequire(import.meta.url);

async function run(): Promise<void> {
  const connection = await NativeConnection.connect({ address: temporalConfig.address });
  const worker = await Worker.create({
    connection,
    namespace: temporalConfig.namespace,
    taskQueue: TASK_QUEUES.JOURNEYS,
    workflowsPath: require.resolve('./journey-workflow'),
    activities,
    // A journey step runs real services; a handful at a time keeps a suite run
    // from looking like a load test against the platform it is measuring.
    maxConcurrentActivityTaskExecutions: 4,
  });

  console.log(
    `[Journey Worker] Listening on ${TASK_QUEUES.JOURNEYS} at ${temporalConfig.address}`
  );
  await worker.run();
}

run().catch(error => {
  console.error('[Journey Worker] Fatal error:', error);
  process.exit(1);
});
