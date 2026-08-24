/**
 * What a journey outcome means, in one place, so the PWA and the React Native
 * app cannot describe the same result differently.
 *
 * The distinction that matters is between the three non-failures: a step that
 * passed, a step where the platform correctly declined to act, and a step that
 * was never exercised because something outside the platform is absent. Only
 * the first two say anything about the platform's own behaviour, so only they
 * are scored.
 */

import type { JourneyStatus, StepOutcome } from './journeys';

export type JourneyTone = 'good' | 'warning' | 'danger' | 'neutral';

export type StateCopy = { label: string; tone: JourneyTone; meaning: string };

export const OUTCOME_COPY: Record<StepOutcome, StateCopy> = {
  passed: {
    label: 'passed',
    tone: 'good',
    meaning: 'The step ran against the real service and the service behaved.',
  },
  refused: {
    label: 'refused',
    tone: 'good',
    meaning:
      'The platform declined to act, and declining was correct — the evidence it needs was not there. Refusing is the behaviour under test, so this counts as a pass.',
  },
  blocked: {
    label: 'blocked',
    tone: 'warning',
    meaning:
      'Nothing was proven: a provider, broker or cluster outside the platform is absent. Excluded from the score rather than counted either way.',
  },
  failed: {
    label: 'failed',
    tone: 'danger',
    meaning: 'The platform did something it should not have, or could not do something it claims.',
  },
};

export const JOURNEY_STATUS_COPY: Record<JourneyStatus, StateCopy> = {
  passed: {
    label: 'passed',
    tone: 'good',
    meaning: 'Every step of this journey ran and either passed or was correctly refused.',
  },
  failed: {
    label: 'failed',
    tone: 'danger',
    meaning: 'At least one step failed. One failure fails the journey.',
  },
  blocked: {
    label: 'blocked',
    tone: 'warning',
    meaning:
      'No step failed, but part of the journey was never exercised because an external dependency is absent.',
  },
  running: {
    label: 'running',
    tone: 'neutral',
    meaning: 'The workflow has recorded some steps and has not reached the end of the journey.',
  },
  not_run: {
    label: 'not run',
    tone: 'neutral',
    meaning: 'This journey has never been executed on this deployment, so nothing is known about it.',
  },
};

/**
 * The sentence a score has to be read with. A score computed over exercisable
 * steps only is not a statement about external interoperability, and saying so
 * is the difference between a report and a claim.
 */
export function scoreCaveat(stepsBlocked: number, notRun: number): string {
  const parts: string[] = [];
  if (stepsBlocked > 0) {
    parts.push(
      `${stepsBlocked} step${stepsBlocked === 1 ? '' : 's'} could not be exercised because an external dependency is absent, and ${stepsBlocked === 1 ? 'is' : 'are'} excluded from the score`
    );
  }
  if (notRun > 0) {
    parts.push(`${notRun} journey${notRun === 1 ? '' : 's'} has never been run here`);
  }
  if (parts.length === 0) {
    return 'Every catalog step was exercised against a real service on this deployment.';
  }
  return `${parts.join('; ')}. The score says nothing about those.`;
}
