/**
 * Running one step of one journey.
 *
 * This is the body every Temporal activity calls, and the same function the
 * tests and the CLI call, so a step behaves identically however it is driven.
 * It builds the principals, runs the step, times it, records the result, and
 * returns the facts the workflow carries to the next step.
 *
 * A thrown error is not swallowed: an unexpected throw is recorded as a failed
 * step and re-reported to the caller, because a journey that hides a crash is
 * worse than no journey at all.
 */

import type { StepResult } from '../../shared/journeys';
import { journeyById, journeyStepMeta } from '../../shared/journeys';
import { principalFor, type JourneyPrincipal } from './caller';
import { stepImplementation } from './registry';
import { errorMessage, type Facts, type StepContext } from './step';
import { finishRun, recordStep, startRun } from '../services/journey-runs';

export class JourneyDefinitionError extends Error {}

export type JourneyPrincipals = {
  memberUserId: number;
  adminUserId: number;
  counterpartyUserId?: number;
};

export type RunStepInput = JourneyPrincipals & {
  journeyId: string;
  stepId: string;
  runId: number;
  runKey: string;
  /** Facts recorded by earlier steps of this run, keyed by step id. */
  prior: Record<string, Facts>;
};

const principalCache = new Map<number, JourneyPrincipal>();

async function principal(userId: number): Promise<JourneyPrincipal> {
  const cached = principalCache.get(userId);
  if (cached) return cached;
  const built = await principalFor(userId);
  principalCache.set(userId, built);
  return built;
}

async function contextFor(input: RunStepInput): Promise<StepContext> {
  const [member, admin] = await Promise.all([
    principal(input.memberUserId),
    principal(input.adminUserId),
  ]);
  const counterparty =
    input.counterpartyUserId === undefined || input.counterpartyUserId === input.memberUserId
      ? admin
      : await principal(input.counterpartyUserId);
  return { member, admin, counterparty, prior: input.prior, runKey: input.runKey };
}

/**
 * Run one step and record it. The returned result is what the workflow keeps in
 * its history, so it carries the facts rather than any service payload.
 */
export async function runStep(input: RunStepInput): Promise<StepResult> {
  const meta = journeyStepMeta(input.journeyId, input.stepId);
  if (!meta) {
    throw new JourneyDefinitionError(
      `Journey "${input.journeyId}" has no step "${input.stepId}" in the catalog.`
    );
  }
  const step = stepImplementation(input.journeyId, input.stepId);
  if (!step) {
    throw new JourneyDefinitionError(
      `Step "${input.journeyId}/${input.stepId}" has no implementation.`
    );
  }

  const context = await contextFor(input);
  const startedAt = Date.now();
  let result: StepResult;
  try {
    const report = await step(context);
    result = {
      stepId: input.stepId,
      outcome: report.outcome,
      detail: report.detail,
      facts: report.facts,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    result = {
      stepId: input.stepId,
      outcome: 'failed',
      detail: errorMessage(error),
      facts: { threw: true },
      durationMs: Date.now() - startedAt,
    };
  }

  await recordStep(input.runId, result);
  return result;
}

export type BeginRunInput = JourneyPrincipals & {
  journeyId: string;
  runKey: string;
  suiteRunKey?: string | null;
  workflowId?: string | null;
};

export async function beginRun(input: BeginRunInput): Promise<number> {
  const journey = journeyById(input.journeyId);
  if (!journey) {
    throw new JourneyDefinitionError(`No journey is named "${input.journeyId}".`);
  }
  return startRun({
    journeyId: input.journeyId,
    runKey: input.runKey,
    suiteRunKey: input.suiteRunKey ?? null,
    workflowId: input.workflowId ?? null,
    memberUserId: input.memberUserId,
    adminUserId: input.adminUserId,
  });
}

export type CompleteRunInput = {
  runId: number;
  state: 'passed' | 'failed' | 'blocked' | 'aborted';
  error?: string | null;
};

export async function completeRun(input: CompleteRunInput): Promise<void> {
  await finishRun(input.runId, input.state, input.error ?? null);
}

/**
 * Run a whole journey in-process, without Temporal. This is how the tests and
 * the CLI drive a journey; the Temporal workflow runs the same steps as
 * separate activities so each one retries and appears in workflow history.
 */
export async function runJourney(
  input: JourneyPrincipals & { journeyId: string; runKey: string; suiteRunKey?: string | null }
): Promise<{ runId: number; steps: StepResult[] }> {
  const journey = journeyById(input.journeyId);
  if (!journey) {
    throw new JourneyDefinitionError(`No journey is named "${input.journeyId}".`);
  }
  const runId = await beginRun(input);
  const prior: Record<string, Facts> = {};
  const steps: StepResult[] = [];

  for (const step of journey.steps) {
    const result = await runStep({
      ...input,
      journeyId: journey.id,
      stepId: step.id,
      runId,
      prior,
    });
    prior[step.id] = result.facts;
    steps.push(result);
  }

  const state = steps.some(step => step.outcome === 'failed')
    ? 'failed'
    : steps.some(step => step.outcome === 'blocked')
      ? 'blocked'
      : 'passed';
  await completeRun({ runId, state });
  return { runId, steps };
}

/** Drop cached principals, so a run picks up a role change made since. */
export function resetPrincipalCache(): void {
  principalCache.clear();
}
