/**
 * Temporal workflows that run stakeholder journeys.
 *
 * The workflow is the sequencer and nothing else: it reads the step list from
 * the shared catalog (pure data, so replay is deterministic), runs each step as
 * an activity, and carries the facts each step recorded to the ones after it.
 * That is what makes a journey resumable — a worker that dies mid-journey
 * replays the history and continues at the step that had not completed, without
 * re-registering the asset the first step created.
 *
 * A step that fails does not abort the run: the remaining steps still run, so
 * one broken service does not hide the state of the other nineteen journeys.
 */

import {
  defineQuery,
  executeChild,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';

import { JOURNEYS, type StepResult } from '../../shared/journeys';
import type { BeginRunInput, CompleteRunInput, RunStepInput } from '../journeys/engine';

type Facts = Record<string, string | number | boolean | null>;

interface JourneyActivities {
  beginJourneyRun(input: BeginRunInput): Promise<number>;
  runJourneyStep(input: RunStepInput): Promise<StepResult>;
  completeJourneyRun(input: CompleteRunInput): Promise<void>;
}

/**
 * A step calls real services, some of which talk to a provider that may be
 * slow, and one waits for a flexibility delivery window to elapse; the step
 * itself decides whether an unreachable dependency is a block. Retries are for
 * transport faults: a step that reports `failed` has already returned, and is
 * not retried, because retrying a defect just records it three times.
 *
 * The ceiling has to clear the longest legitimate step. A timed-out attempt is
 * not cancelled — it runs on and overwrites the retry's recorded result, which
 * is how a run once recorded `failed` with five passed steps.
 */
export const STEP_ACTIVITY_TIMEOUT_MS = 300_000;

const activities = proxyActivities<JourneyActivities>({
  startToCloseTimeout: STEP_ACTIVITY_TIMEOUT_MS,
  retry: {
    initialInterval: '2s',
    backoffCoefficient: 2,
    maximumAttempts: 3,
    nonRetryableErrorTypes: ['JourneyDefinitionError', 'JourneyPrincipalError'],
  },
});

export type JourneyWorkflowInput = {
  journeyId: string;
  runKey: string;
  memberUserId: number;
  adminUserId: number;
  counterpartyUserId?: number;
  suiteRunKey?: string | null;
};

export type JourneyProgress = {
  journeyId: string;
  runKey: string;
  runId: number | null;
  steps: StepResult[];
  state: 'running' | 'passed' | 'failed' | 'blocked';
};

export const journeyProgressQuery = defineQuery<JourneyProgress>('journeyProgress');

export type JourneyWorkflowResult = {
  runId: number;
  journeyId: string;
  runKey: string;
  state: 'passed' | 'failed' | 'blocked';
  steps: StepResult[];
};

function terminalState(steps: StepResult[]): 'passed' | 'failed' | 'blocked' {
  if (steps.some(step => step.outcome === 'failed')) return 'failed';
  if (steps.some(step => step.outcome === 'blocked')) return 'blocked';
  return 'passed';
}

export async function runJourneyWorkflow(
  input: JourneyWorkflowInput
): Promise<JourneyWorkflowResult> {
  const journey = JOURNEYS.find(candidate => candidate.id === input.journeyId);
  if (!journey) {
    throw new Error(`No journey is named "${input.journeyId}".`);
  }

  const steps: StepResult[] = [];
  let runId: number | null = null;

  setHandler(journeyProgressQuery, () => ({
    journeyId: journey.id,
    runKey: input.runKey,
    runId,
    steps,
    state: steps.length === journey.steps.length ? terminalState(steps) : 'running',
  }));

  runId = await activities.beginJourneyRun({
    journeyId: journey.id,
    runKey: input.runKey,
    suiteRunKey: input.suiteRunKey ?? null,
    workflowId: workflowInfo().workflowId,
    memberUserId: input.memberUserId,
    adminUserId: input.adminUserId,
    counterpartyUserId: input.counterpartyUserId,
  });

  const prior: Record<string, Facts> = {};
  for (const step of journey.steps) {
    const result = await activities.runJourneyStep({
      journeyId: journey.id,
      stepId: step.id,
      runId,
      runKey: input.runKey,
      prior,
      memberUserId: input.memberUserId,
      adminUserId: input.adminUserId,
      counterpartyUserId: input.counterpartyUserId,
    });
    prior[step.id] = result.facts;
    steps.push(result);
  }

  const state = terminalState(steps);
  await activities.completeJourneyRun({ runId, state });
  return { runId, journeyId: journey.id, runKey: input.runKey, state, steps };
}

export type JourneySuiteInput = {
  suiteRunKey: string;
  memberUserId: number;
  adminUserId: number;
  counterpartyUserId?: number;
  /** Journeys to run; the whole catalog when omitted. */
  journeyIds?: string[];
};

export type JourneySuiteResult = {
  suiteRunKey: string;
  runs: Array<{ journeyId: string; state: string; runId: number | null; error?: string }>;
};

/**
 * The suite runs each journey as a child workflow, so one journey's failure is
 * contained and each journey keeps its own history and its own retry budget.
 */
export async function runJourneySuiteWorkflow(
  input: JourneySuiteInput
): Promise<JourneySuiteResult> {
  const ids = input.journeyIds ?? JOURNEYS.map(journey => journey.id);
  const runs: JourneySuiteResult['runs'] = [];

  for (const journeyId of ids) {
    try {
      // Same run key and workflow id a single start of this journey under this
      // label would use, so running the suite and then re-running one journey
      // with the same label resumes that run instead of creating a second one.
      const runKey = `${journeyId}:${input.suiteRunKey}`;
      const result = await executeChild(runJourneyWorkflow, {
        workflowId: `journey-${runKey}`,
        args: [
          {
            journeyId,
            runKey,
            suiteRunKey: input.suiteRunKey,
            memberUserId: input.memberUserId,
            adminUserId: input.adminUserId,
            counterpartyUserId: input.counterpartyUserId,
          },
        ],
      });
      runs.push({ journeyId, state: result.state, runId: result.runId });
    } catch (error) {
      runs.push({
        journeyId,
        state: 'failed',
        runId: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { suiteRunKey: input.suiteRunKey, runs };
}
