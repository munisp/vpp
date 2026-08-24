/**
 * Temporal activities for stakeholder journeys.
 *
 * Everything non-deterministic lives here: database writes, service calls,
 * clocks. The workflow only sequences these. Each activity is idempotent — a
 * retried `beginJourneyRun` returns the same run id, and a retried step
 * overwrites its own result — because Temporal will retry them.
 */

import type { StepResult } from '../../shared/journeys';
import {
  beginRun,
  completeRun,
  runStep,
  type BeginRunInput,
  type CompleteRunInput,
  type RunStepInput,
} from '../journeys/engine';

export async function beginJourneyRun(input: BeginRunInput): Promise<number> {
  return beginRun(input);
}

export async function runJourneyStep(input: RunStepInput): Promise<StepResult> {
  return runStep(input);
}

export async function completeJourneyRun(input: CompleteRunInput): Promise<void> {
  await completeRun(input);
}
