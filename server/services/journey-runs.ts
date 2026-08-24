/**
 * Persistence for journey runs.
 *
 * A journey is only useful if its history survives the run: a step that has
 * been blocked on an unprovisioned provider for a month has to be
 * distinguishable from one that passed this morning, and a journey that starts
 * failing has to point at when it changed. The Temporal workflow owns
 * sequencing; this module owns the record.
 *
 * Writes are idempotent because Temporal retries activities: starting a run
 * twice with the same run key returns the existing run, and recording a step
 * twice overwrites its own result rather than appending a contradictory one.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { getDb } from '../db';
import { journeyRuns, journeyStepResults } from '../../drizzle/journeys-schema';
import type { StepOutcome, StepResult } from '../../shared/journeys';

export class JourneyRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JourneyRunError';
  }
}

async function db() {
  const instance = await getDb();
  if (!instance) {
    throw new JourneyRunError('Database unavailable; journey runs cannot be recorded.');
  }
  return instance;
}

export type JourneyRunState = 'running' | 'passed' | 'failed' | 'blocked' | 'aborted';

export type JourneyRunRecord = {
  id: number;
  journeyId: string;
  runKey: string;
  suiteRunKey: string | null;
  workflowId: string | null;
  state: JourneyRunState;
  memberUserId: number;
  adminUserId: number | null;
  startedAt: Date;
  finishedAt: Date | null;
  error: string | null;
  steps: StepResult[];
};

export type StartRunInput = {
  journeyId: string;
  runKey: string;
  suiteRunKey?: string | null;
  workflowId?: string | null;
  memberUserId: number;
  adminUserId?: number | null;
};

/**
 * Claim a run for a run key. Re-running the same key resumes the same row: the
 * key is how a re-run of a journey is told apart from a duplicate of one.
 */
export async function startRun(input: StartRunInput): Promise<number> {
  const instance = await db();
  const inserted = await instance
    .insert(journeyRuns)
    .values({
      journeyId: input.journeyId,
      runKey: input.runKey,
      suiteRunKey: input.suiteRunKey ?? null,
      workflowId: input.workflowId ?? null,
      memberUserId: input.memberUserId,
      adminUserId: input.adminUserId ?? null,
      state: 'running',
    })
    .onConflictDoNothing({ target: journeyRuns.runKey })
    .returning({ id: journeyRuns.id });

  if (inserted.length > 0) return inserted[0].id;

  const existing = await instance
    .select({ id: journeyRuns.id, journeyId: journeyRuns.journeyId })
    .from(journeyRuns)
    .where(eq(journeyRuns.runKey, input.runKey))
    .limit(1);
  if (existing.length === 0) {
    throw new JourneyRunError(`Run key ${input.runKey} could neither be created nor found.`);
  }
  if (existing[0].journeyId !== input.journeyId) {
    throw new JourneyRunError(
      `Run key ${input.runKey} already belongs to journey ${existing[0].journeyId}.`
    );
  }
  return existing[0].id;
}

/**
 * Record one step. The unique key is (run, step), so a retried activity
 * replaces its own earlier attempt.
 */
export async function recordStep(runId: number, result: StepResult): Promise<void> {
  const instance = await db();
  await instance
    .insert(journeyStepResults)
    .values({
      runId,
      stepId: result.stepId,
      outcome: result.outcome,
      detail: result.detail,
      facts: result.facts,
      durationMs: result.durationMs,
    })
    .onConflictDoUpdate({
      target: [journeyStepResults.runId, journeyStepResults.stepId],
      set: {
        outcome: result.outcome,
        detail: result.detail,
        facts: result.facts,
        durationMs: result.durationMs,
        createdAt: new Date(),
      },
    });
}

export async function finishRun(
  runId: number,
  state: Exclude<JourneyRunState, 'running'>,
  error?: string | null
): Promise<void> {
  const instance = await db();
  await instance
    .update(journeyRuns)
    .set({ state, finishedAt: new Date(), error: error ?? null })
    .where(eq(journeyRuns.id, runId));
}

function toStepResult(row: {
  stepId: string;
  outcome: string;
  detail: string;
  facts: unknown;
  durationMs: number;
}): StepResult {
  return {
    stepId: row.stepId,
    outcome: row.outcome as StepOutcome,
    detail: row.detail,
    facts: (row.facts ?? {}) as StepResult['facts'],
    durationMs: row.durationMs,
  };
}

async function attachSteps(
  rows: Array<Omit<JourneyRunRecord, 'steps'>>
): Promise<JourneyRunRecord[]> {
  if (rows.length === 0) return [];
  const instance = await db();
  const stepRows = await instance
    .select()
    .from(journeyStepResults)
    .where(inArray(journeyStepResults.runId, rows.map(row => row.id)))
    .orderBy(journeyStepResults.id);

  const byRun = new Map<number, StepResult[]>();
  for (const row of stepRows) {
    const list = byRun.get(row.runId) ?? [];
    list.push(toStepResult(row));
    byRun.set(row.runId, list);
  }
  return rows.map(row => ({ ...row, steps: byRun.get(row.id) ?? [] }));
}

export async function getRunByKey(runKey: string): Promise<JourneyRunRecord | null> {
  const instance = await db();
  const rows = await instance
    .select()
    .from(journeyRuns)
    .where(eq(journeyRuns.runKey, runKey))
    .limit(1);
  const withSteps = await attachSteps(rows as unknown as Array<Omit<JourneyRunRecord, 'steps'>>);
  return withSteps[0] ?? null;
}

export async function listRuns(limit = 50, journeyId?: string): Promise<JourneyRunRecord[]> {
  const instance = await db();
  const rows = await instance
    .select()
    .from(journeyRuns)
    .where(journeyId ? eq(journeyRuns.journeyId, journeyId) : sql`true`)
    .orderBy(desc(journeyRuns.startedAt))
    .limit(limit);
  return attachSteps(rows as unknown as Array<Omit<JourneyRunRecord, 'steps'>>);
}

/**
 * The most recent run of each journey.
 *
 * A journey's current state is its latest run and nothing else: an old pass
 * does not survive a later failure, which is the point of re-runnable journeys
 * rather than a one-off report.
 */
export async function latestRunPerJourney(suiteRunKey?: string): Promise<JourneyRunRecord[]> {
  const instance = await db();
  const rows = await instance
    .select()
    .from(journeyRuns)
    .where(suiteRunKey ? eq(journeyRuns.suiteRunKey, suiteRunKey) : sql`true`)
    .orderBy(desc(journeyRuns.startedAt))
    .limit(1_000);

  const seen = new Set<string>();
  const latest: Array<Omit<JourneyRunRecord, 'steps'>> = [];
  for (const row of rows as unknown as Array<Omit<JourneyRunRecord, 'steps'>>) {
    if (seen.has(row.journeyId)) continue;
    seen.add(row.journeyId);
    latest.push(row);
  }
  return attachSteps(latest);
}

/** Runs that never reached a terminal state, for an operator to notice. */
export async function stalledRuns(olderThanMs: number): Promise<JourneyRunRecord[]> {
  const instance = await db();
  const cutoff = new Date(Date.now() - olderThanMs);
  const rows = await instance
    .select()
    .from(journeyRuns)
    .where(and(eq(journeyRuns.state, 'running'), sql`${journeyRuns.startedAt} < ${cutoff}`))
    .orderBy(desc(journeyRuns.startedAt))
    .limit(100);
  return attachSteps(rows as unknown as Array<Omit<JourneyRunRecord, 'steps'>>);
}
