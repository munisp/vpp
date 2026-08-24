/**
 * Every journey step in the catalog, mapped to the function that performs it.
 *
 * The catalog in `shared/journeys.ts` is the contract; this file is the
 * implementation of that contract. `missingImplementations()` is what stops the
 * two drifting apart: a step added to the catalog with no body here is a hole
 * the tests fail on, rather than a journey that quietly runs four steps out of
 * five and reports itself green.
 */

import { JOURNEYS } from '../../shared/journeys';
import type { JourneyStep } from './step';
import { memberSteps } from './steps/member';
import { marketSteps } from './steps/market';
import { moneySteps } from './steps/money';
import { gridSteps } from './steps/grid';
import { opsSteps } from './steps/ops';

export const JOURNEY_STEPS: Record<string, Record<string, JourneyStep>> = {
  ...memberSteps,
  ...marketSteps,
  ...moneySteps,
  ...gridSteps,
  ...opsSteps,
};

export function stepImplementation(journeyId: string, stepId: string): JourneyStep | undefined {
  return JOURNEY_STEPS[journeyId]?.[stepId];
}

export type MissingImplementation = { journeyId: string; stepId: string };

/** Catalog steps with no implementation, and implementations with no catalog step. */
export function missingImplementations(): MissingImplementation[] {
  const missing: MissingImplementation[] = [];
  for (const journey of JOURNEYS) {
    for (const step of journey.steps) {
      if (!stepImplementation(journey.id, step.id)) {
        missing.push({ journeyId: journey.id, stepId: step.id });
      }
    }
  }
  return missing;
}

export function orphanImplementations(): MissingImplementation[] {
  const orphans: MissingImplementation[] = [];
  for (const [journeyId, steps] of Object.entries(JOURNEY_STEPS)) {
    const journey = JOURNEYS.find(candidate => candidate.id === journeyId);
    for (const stepId of Object.keys(steps)) {
      if (!journey || !journey.steps.some(step => step.id === stepId)) {
        orphans.push({ journeyId, stepId });
      }
    }
  }
  return orphans;
}
