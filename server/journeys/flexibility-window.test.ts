/**
 * The flexibility delivery step is the only journey step that waits for
 * wall-clock time, and it waits inside a single Temporal activity. If that wait
 * can outlive the activity's start-to-close timeout, Temporal retries the step
 * while the timed-out attempt keeps running, and whichever finishes last writes
 * the step row: a run then records a state its own steps contradict.
 *
 * This is a defence against that pairing drifting apart, not a behaviour test.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@temporalio/workflow', () => ({
  proxyActivities: () => ({}),
  defineQuery: (name: string) => ({ name }),
  setHandler: () => {},
  workflowInfo: () => ({ workflowId: 'test-workflow' }),
  executeChild: async () => ({ runId: 1, state: 'passed', steps: [] }),
}));

const { DELIVERY_WINDOW_LEAD_MS, DELIVERY_WINDOW_LENGTH_MS } = await import('./steps/grid');
const { STEP_ACTIVITY_TIMEOUT_MS } = await import('../workflows/journey-workflow');

/**
 * The step also clears the requirement, ingests telemetry and measures delivery
 * around the wait, all against real services, and a delivery window shorter than
 * a minute is not worth measuring.
 */
const WORK_ALLOWANCE_MS = 60_000;

describe('flexibility delivery window', () => {
  it('closes well inside the activity timeout the step runs under', () => {
    const wait = DELIVERY_WINDOW_LEAD_MS + DELIVERY_WINDOW_LENGTH_MS;
    expect(wait + WORK_ALLOWANCE_MS).toBeLessThan(STEP_ACTIVITY_TIMEOUT_MS);
  });

  it('leaves the offer and clearing steps time before offers close', () => {
    // Offers close when the window opens, so the lead has to cover the offer
    // and clearing calls that run between the requirement and delivery.
    expect(DELIVERY_WINDOW_LEAD_MS).toBeGreaterThanOrEqual(30_000);
    // Settlement integrates the window itself, but a window this short would
    // credit a handful of watt-minutes: keep it at a measurable minute.
    expect(DELIVERY_WINDOW_LENGTH_MS).toBeGreaterThanOrEqual(60_000);
  });
});
