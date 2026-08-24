/**
 * What a journey step is, and how its outcome is decided.
 *
 * A step is a function over principals and the facts earlier steps recorded. It
 * returns the outcome it observed; it does not decide whether the journey as a
 * whole passed, and it does not write to the database itself. Anything a later
 * step needs (an asset id, an offer id) is returned as a fact, which is how a
 * journey stays replayable: the facts live in the workflow history, so a retry
 * resumes with the same identifiers instead of creating a second asset.
 */

import { TRPCError } from '@trpc/server';
import type { ExternalDependency, StepOutcome } from '../../shared/journeys';
import type { JourneyPrincipal } from './caller';

export type Fact = string | number | boolean | null;
export type Facts = Record<string, Fact>;

export type StepReport = {
  outcome: StepOutcome;
  detail: string;
  facts: Facts;
};

export type StepContext = {
  /** The household or business the journey is run on behalf of. */
  member: JourneyPrincipal;
  /** The operator principal. Steps declared `acting: 'admin'` require it. */
  admin: JourneyPrincipal;
  /**
   * The other side of a bilateral trade. Supplied per run; when a run names no
   * counterparty this is the operator account, so a market journey still has a
   * real second party rather than trading with itself.
   */
  counterparty: JourneyPrincipal;
  /** Facts recorded by earlier steps of this run, keyed by step id. */
  prior: Record<string, Facts>;
  /** Stable per-run suffix, so re-running a journey does not collide. */
  runKey: string;
};

export type JourneyStep = (ctx: StepContext) => Promise<StepReport>;

export function passed(detail: string, facts: Facts = {}): StepReport {
  return { outcome: 'passed', detail, facts };
}

/**
 * The platform declined to act, and declining was correct — no gateway
 * evidence, no verified topology, no device credential. A journey containing a
 * refusal still passes: refusing is the behaviour being tested.
 */
export function refused(detail: string, facts: Facts = {}): StepReport {
  return { outcome: 'refused', detail, facts };
}

/**
 * Nothing was proven because something outside the platform is not there.
 * Blocked steps are excluded from the score rather than counted either way.
 */
export function blocked(
  dependency: ExternalDependency,
  detail: string,
  facts: Facts = {}
): StepReport {
  return { outcome: 'blocked', detail, facts: { ...facts, blockedOn: dependency } };
}

export function failed(detail: string, facts: Facts = {}): StepReport {
  return { outcome: 'failed', detail, facts };
}

/**
 * A step that needs a value an earlier step did not record cannot report
 * anything about the service it was going to call, so it fails loudly rather
 * than reporting a pass it did not earn.
 */
export class MissingPriorFact extends Error {
  constructor(stepId: string, fact: string) {
    super(`Step "${stepId}" did not record "${fact}", which this step needs.`);
  }
}

export function priorFact(ctx: StepContext, stepId: string, key: string): Fact {
  const facts = ctx.prior[stepId];
  if (!facts || !(key in facts) || facts[key] === null) {
    throw new MissingPriorFact(stepId, key);
  }
  return facts[key];
}

export function priorNumber(ctx: StepContext, stepId: string, key: string): number {
  const value = priorFact(ctx, stepId, key);
  if (typeof value !== 'number') {
    throw new MissingPriorFact(stepId, key);
  }
  return value;
}

export function priorString(ctx: StepContext, stepId: string, key: string): string {
  const value = priorFact(ctx, stepId, key);
  if (typeof value !== 'string') {
    throw new MissingPriorFact(stepId, key);
  }
  return value;
}

/**
 * tRPC codes the services use when a dependency is absent rather than broken.
 * `SERVICE_UNAVAILABLE` is the platform's own word for "no provider is
 * configured", which is a block; `PRECONDITION_FAILED` is a refusal on
 * evidence. Anything else is the service being wrong.
 */
const UNAVAILABLE_CODES = new Set(['SERVICE_UNAVAILABLE', 'BAD_GATEWAY', 'TIMEOUT']);
const REFUSAL_CODES = new Set(['PRECONDITION_FAILED', 'FORBIDDEN', 'CONFLICT', 'BAD_REQUEST']);

export function errorCode(error: unknown): string | null {
  return error instanceof TRPCError ? error.code : null;
}

export function errorMessage(error: unknown): string {
  if (error instanceof TRPCError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Classify a thrown error for a step that declares an external dependency: an
 * unavailable provider blocks the step, a documented refusal is a refusal, and
 * anything else is a defect.
 */
export function classifyDependencyError(
  error: unknown,
  dependency: ExternalDependency,
  facts: Facts = {}
): StepReport {
  const code = errorCode(error);
  const message = errorMessage(error);
  if (code && UNAVAILABLE_CODES.has(code)) {
    return blocked(dependency, `${message} (${code})`, { ...facts, errorCode: code });
  }
  if (code && REFUSAL_CODES.has(code)) {
    return refused(`${message} (${code})`, { ...facts, errorCode: code });
  }
  return failed(message, { ...facts, errorCode: code ?? 'none' });
}

/** Compact a value for a fact field without dumping a whole payload into it. */
export function count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}
