/**
 * The workflow is a sequencer, so what is worth testing is the sequence: every
 * catalog step is attempted, facts move forward, a failure does not abort the
 * rest, and the terminal state is derived from outcomes rather than from whether
 * the workflow threw.
 *
 * `@temporalio/workflow` is replaced with a recorder because the real module
 * only works inside a workflow sandbox. That leaves the workflow's own logic
 * under test; the activities it proxies are tested against real services
 * elsewhere.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { JOURNEYS, type StepResult } from '../../shared/journeys';
import type { BeginRunInput, CompleteRunInput, RunStepInput } from '../journeys/engine';

const beginJourneyRun = vi.fn<(input: BeginRunInput) => Promise<number>>();
const runJourneyStep = vi.fn<(input: RunStepInput) => Promise<StepResult>>();
const completeJourneyRun = vi.fn<(input: CompleteRunInput) => Promise<void>>();
const childCalls: Array<{ workflowId: string; args: unknown[] }> = [];
const childResults = new Map<string, unknown>();
let queryHandler: (() => unknown) | null = null;

vi.mock('@temporalio/workflow', () => ({
  proxyActivities: () => ({ beginJourneyRun, runJourneyStep, completeJourneyRun }),
  defineQuery: (name: string) => ({ name }),
  setHandler: (_query: unknown, handler: () => unknown) => {
    queryHandler = handler;
  },
  workflowInfo: () => ({ workflowId: 'test-workflow' }),
  executeChild: async (_workflow: unknown, options: { workflowId: string; args: unknown[] }) => {
    childCalls.push(options);
    const outcome = childResults.get(options.workflowId);
    if (outcome instanceof Error) throw outcome;
    return outcome ?? { runId: 1, state: 'passed', steps: [] };
  },
}));

const { runJourneySuiteWorkflow, runJourneyWorkflow } = await import('./journey-workflow');

function stepResult(stepId: string, outcome: StepResult['outcome']): StepResult {
  return { stepId, outcome, detail: outcome, facts: { seen: stepId }, durationMs: 1 };
}

const input = {
  journeyId: 'member-onboarding',
  runKey: 'member-onboarding:test',
  memberUserId: 7,
  adminUserId: 1,
};

describe('runJourneyWorkflow', () => {
  beforeEach(() => {
    beginJourneyRun.mockReset().mockResolvedValue(11);
    runJourneyStep.mockReset();
    completeJourneyRun.mockReset().mockResolvedValue(undefined);
    queryHandler = null;
  });

  it('refuses a journey the catalog does not define', async () => {
    await expect(runJourneyWorkflow({ ...input, journeyId: 'not-a-journey' })).rejects.toThrow(
      /No journey is named/
    );
    expect(beginJourneyRun).not.toHaveBeenCalled();
  });

  it('runs every catalog step and carries facts forward', async () => {
    const journey = JOURNEYS.find(candidate => candidate.id === input.journeyId)!;
    runJourneyStep.mockImplementation(async call => stepResult(call.stepId, 'passed'));

    const result = await runJourneyWorkflow(input);

    expect(result.state).toBe('passed');
    expect(result.steps.map(step => step.stepId)).toEqual(journey.steps.map(step => step.id));
    // The second step sees the first step's facts, which is what makes a
    // journey a journey rather than a bag of independent checks.
    const second = runJourneyStep.mock.calls[1][0];
    expect(second.prior[journey.steps[0].id]).toEqual({ seen: journey.steps[0].id });
    expect(completeJourneyRun).toHaveBeenCalledWith({ runId: 11, state: 'passed' });
  });

  it('keeps running after a failing step and reports the journey failed', async () => {
    const journey = JOURNEYS.find(candidate => candidate.id === input.journeyId)!;
    runJourneyStep.mockImplementation(async call =>
      stepResult(call.stepId, call.stepId === journey.steps[0].id ? 'failed' : 'passed')
    );

    const result = await runJourneyWorkflow(input);

    expect(result.steps).toHaveLength(journey.steps.length);
    expect(result.state).toBe('failed');
  });

  it('reports blocked when a step could not be exercised and none failed', async () => {
    runJourneyStep.mockImplementation(async call =>
      stepResult(call.stepId, call.stepId.includes('a') ? 'blocked' : 'refused')
    );
    const result = await runJourneyWorkflow(input);
    expect(result.state).toBe('blocked');
  });

  it('answers a progress query while the journey is still short of its steps', async () => {
    runJourneyStep.mockImplementation(async call => stepResult(call.stepId, 'passed'));
    await runJourneyWorkflow(input);
    expect(queryHandler).not.toBeNull();
    const progress = queryHandler!() as { runId: number; state: string };
    expect(progress.runId).toBe(11);
    expect(progress.state).toBe('passed');
  });
});

describe('runJourneySuiteWorkflow', () => {
  beforeEach(() => {
    childCalls.length = 0;
    childResults.clear();
  });

  it('gives a child the same workflow id a single start would use', async () => {
    await runJourneySuiteWorkflow({
      suiteRunKey: 'nightly',
      memberUserId: 7,
      adminUserId: 1,
      journeyIds: ['member-onboarding'],
    });
    expect(childCalls).toHaveLength(1);
    expect(childCalls[0].workflowId).toBe('journey-member-onboarding:nightly');
    expect(childCalls[0].args[0]).toMatchObject({
      runKey: 'member-onboarding:nightly',
      suiteRunKey: 'nightly',
    });
  });

  it('runs the whole catalog when no journeys are named', async () => {
    const result = await runJourneySuiteWorkflow({
      suiteRunKey: 'all',
      memberUserId: 7,
      adminUserId: 1,
    });
    expect(result.runs).toHaveLength(JOURNEYS.length);
  });

  it('contains one journey failing so the rest still run', async () => {
    childResults.set('journey-member-onboarding:nightly', new Error('activity worker died'));
    const result = await runJourneySuiteWorkflow({
      suiteRunKey: 'nightly',
      memberUserId: 7,
      adminUserId: 1,
      journeyIds: ['member-onboarding', 'prosumer-daily-monitoring'],
    });
    expect(result.runs[0]).toMatchObject({ journeyId: 'member-onboarding', state: 'failed' });
    expect(result.runs[0].error).toContain('activity worker died');
    expect(result.runs[1]).toMatchObject({ state: 'passed' });
  });
});
