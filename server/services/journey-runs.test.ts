/**
 * What a journey run record has to survive.
 *
 * Temporal retries activities, so both writes have to be idempotent: starting
 * the same run key twice must resume the same row rather than create a rival
 * one, and recording the same step twice must replace its own earlier attempt
 * rather than append a contradictory one. Those are PostgreSQL properties
 * (`ON CONFLICT` on the run key and on the (run, step) pair), so this needs a
 * real database — without `DATABASE_URL` it is skipped rather than replaced by
 * something that proves the fake.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { getDb } from '../db';
import {
  finishRun,
  getRunByKey,
  latestRunPerJourney,
  listRuns,
  recordStep,
  stalledRuns,
  startRun,
  JourneyRunError,
} from './journey-runs';
import { journeyStatus, suiteSummary, type StepResult } from '../../shared/journeys';

const dbUrl = process.env.DATABASE_URL;

function step(stepId: string, outcome: StepResult['outcome'], facts: StepResult['facts'] = {}) {
  return { stepId, outcome, detail: `${stepId} ${outcome}`, facts, durationMs: 5 };
}

describe.skipIf(!dbUrl)('journey run persistence', () => {
  let database: NonNullable<Awaited<ReturnType<typeof getDb>>>;

  beforeAll(async () => {
    const resolved = await getDb();
    if (!resolved) throw new Error('DATABASE_URL is set but no connection could be made');
    database = resolved;
  });

  beforeEach(async () => {
    await database.execute(sql`DELETE FROM journey_step_results`);
    await database.execute(sql`DELETE FROM journey_runs`);
  });

  const base = {
    journeyId: 'member-onboarding',
    runKey: 'member-onboarding:test',
    memberUserId: 7,
    adminUserId: 1,
  };

  it('resumes the same run when the same key is claimed twice', async () => {
    const first = await startRun(base);
    const second = await startRun(base);
    expect(second).toBe(first);
    const rows = await listRuns(10);
    expect(rows).toHaveLength(1);
  });

  it('refuses to reuse a run key for a different journey', async () => {
    await startRun(base);
    await expect(startRun({ ...base, journeyId: 'p2p-neighbour-trade' })).rejects.toBeInstanceOf(
      JourneyRunError
    );
  });

  it('replaces a retried step rather than appending a second verdict', async () => {
    const runId = await startRun(base);
    await recordStep(runId, step('account-exists', 'failed', { attempt: 1 }));
    await recordStep(runId, step('account-exists', 'passed', { attempt: 2 }));

    const run = await getRunByKey(base.runKey);
    expect(run?.steps).toHaveLength(1);
    expect(run?.steps[0].outcome).toBe('passed');
    expect(run?.steps[0].facts).toEqual({ attempt: 2 });
  });

  it('keeps the facts a step recorded, so a later failure can be compared', async () => {
    const runId = await startRun(base);
    await recordStep(runId, step('assets', 'passed', { assetId: 12, verified: true, note: null }));
    const run = await getRunByKey(base.runKey);
    expect(run?.steps[0].facts).toEqual({ assetId: 12, verified: true, note: null });
  });

  it('reports a run as running until it is finished', async () => {
    const runId = await startRun(base);
    expect((await getRunByKey(base.runKey))?.state).toBe('running');
    await finishRun(runId, 'blocked');
    const finished = await getRunByKey(base.runKey);
    expect(finished?.state).toBe('blocked');
    expect(finished?.finishedAt).not.toBeNull();
  });

  it('shows only the latest run of a journey, so an old pass does not survive a failure', async () => {
    const passing = await startRun(base);
    await recordStep(passing, step('one', 'passed'));
    await finishRun(passing, 'passed');

    const failing = await startRun({ ...base, runKey: 'member-onboarding:later' });
    await recordStep(failing, step('one', 'failed'));
    await finishRun(failing, 'failed');

    const latest = await latestRunPerJourney();
    expect(latest).toHaveLength(1);
    expect(latest[0].runKey).toBe('member-onboarding:later');
    expect(latest[0].state).toBe('failed');
  });

  it('scopes a report to one suite', async () => {
    const inSuite = await startRun({
      ...base,
      runKey: 'member-onboarding:nightly',
      suiteRunKey: 'nightly',
    });
    await recordStep(inSuite, step('one', 'passed'));
    await startRun({ ...base, runKey: 'member-onboarding:adhoc' });

    const scoped = await latestRunPerJourney('nightly');
    expect(scoped.map(run => run.runKey)).toEqual(['member-onboarding:nightly']);
  });

  it('surfaces a run that never reached a terminal state', async () => {
    const runId = await startRun(base);
    await database.execute(
      sql`UPDATE journey_runs SET started_at = now() - interval '2 hours' WHERE id = ${runId}`
    );
    const stalled = await stalledRuns(60 * 60 * 1000);
    expect(stalled.map(run => run.runKey)).toContain(base.runKey);

    await finishRun(runId, 'passed');
    expect(await stalledRuns(60 * 60 * 1000)).toHaveLength(0);
  });

  it('scores a stored run the way the report does', async () => {
    const runId = await startRun(base);
    await recordStep(runId, step('a', 'passed'));
    await recordStep(runId, step('b', 'refused'));
    await recordStep(runId, step('c', 'blocked'));
    const run = await getRunByKey(base.runKey);

    // Two exercisable steps, both behaved; the blocked step is excluded rather
    // than counted either way.
    const summary = suiteSummary([{ journeyId: base.journeyId, steps: run!.steps }]);
    expect(summary.exercisableScorePct).toBe(100);
    expect(summary.stepsBlocked).toBe(1);
    // The journey is not complete, so it is running rather than passed.
    expect(journeyStatus(run!.steps, ['a', 'b', 'c', 'd'])).toBe('running');
    expect(journeyStatus(run!.steps, ['a', 'b', 'c'])).toBe('blocked');
  });
});
