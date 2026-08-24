/**
 * The claim this file defends is that the journey catalog covers the whole
 * product surface: every route in the web sidebar and every screen in the
 * mobile navigator is exercised by at least one journey. A page added to either
 * app without a journey fails here rather than being quietly untested.
 */

import { describe, it, expect } from 'vitest';
import { NAV_GROUPS } from '../client/src/lib/nav';
import { MOBILE_NAV_GROUPS } from './mobile-nav';
import {
  JOURNEYS,
  journeyStatus,
  mobileScreenCoverage,
  navCoverage,
  suiteSummary,
  type StepResult,
} from './journeys';

const webPaths = NAV_GROUPS.flatMap(group => group.items.map(item => item.path));
const mobileScreens = MOBILE_NAV_GROUPS.flatMap(group => group.items.map(item => item.screen));

function result(stepId: string, outcome: StepResult['outcome']): StepResult {
  return { stepId, outcome, detail: '', facts: {}, durationMs: 1 };
}

describe('journey catalog', () => {
  it('covers every web navigation route', () => {
    expect(navCoverage(webPaths).uncovered).toEqual([]);
  });

  it('covers every mobile navigator screen', () => {
    expect(mobileScreenCoverage(mobileScreens).uncovered).toEqual([]);
  });

  it('names no route that neither app has', () => {
    const known = new Set(webPaths);
    const claimed = new Set(JOURNEYS.flatMap(j => j.steps.flatMap(s => s.navPaths)));
    expect([...claimed].filter(path => !known.has(path))).toEqual([]);
  });

  it('names no mobile screen the navigator does not register', () => {
    const known = new Set(mobileScreens);
    const claimed = new Set(
      JOURNEYS.flatMap(j => j.steps.flatMap(s => s.mobileScreens ?? []))
    );
    expect([...claimed].filter(screen => !known.has(screen))).toEqual([]);
  });

  it('has unique journey and step ids', () => {
    const ids = JOURNEYS.map(journey => journey.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const journey of JOURNEYS) {
      const stepIds = journey.steps.map(step => step.id);
      expect(new Set(stepIds).size, journey.id).toBe(stepIds.length);
    }
  });

  it('gives every journey at least two steps and a named service per step', () => {
    for (const journey of JOURNEYS) {
      expect(journey.steps.length, journey.id).toBeGreaterThanOrEqual(2);
      for (const step of journey.steps) {
        expect(step.services.length, `${journey.id}.${step.id}`).toBeGreaterThan(0);
        expect(step.navPaths.length, `${journey.id}.${step.id}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('journeyStatus', () => {
  const expected = ['a', 'b', 'c'];

  it('is not_run with no results and running while steps are missing', () => {
    expect(journeyStatus([], expected)).toBe('not_run');
    expect(journeyStatus([result('a', 'passed')], expected)).toBe('running');
  });

  it('passes when every step passed or was refused as designed', () => {
    expect(
      journeyStatus(
        [result('a', 'passed'), result('b', 'refused'), result('c', 'passed')],
        expected
      )
    ).toBe('passed');
  });

  it('is blocked, not passed, when a dependency was unavailable', () => {
    expect(
      journeyStatus(
        [result('a', 'passed'), result('b', 'blocked'), result('c', 'passed')],
        expected
      )
    ).toBe('blocked');
  });

  it('fails on one failure even when the rest passed', () => {
    expect(
      journeyStatus(
        [result('a', 'passed'), result('b', 'failed'), result('c', 'blocked')],
        expected
      )
    ).toBe('failed');
  });
});

describe('suiteSummary', () => {
  it('reports every journey as not run before anything executes', () => {
    const summary = suiteSummary([]);
    expect(summary.journeys).toBe(JOURNEYS.length);
    expect(summary.notRun).toBe(JOURNEYS.length);
    expect(summary.exercisableScorePct).toBeNull();
  });

  it('excludes blocked steps from the score instead of counting them as passes', () => {
    const journey = JOURNEYS[0];
    const summary = suiteSummary([
      {
        journeyId: journey.id,
        steps: journey.steps.map((step, index) =>
          result(step.id, index === 0 ? 'blocked' : 'passed')
        ),
      },
    ]);
    expect(summary.stepsBlocked).toBe(1);
    expect(summary.exercisableScorePct).toBe(100);
    expect(summary.blocked).toBe(1);
    expect(summary.passed).toBe(0);
  });

  it('drops the score below 100 as soon as one step fails', () => {
    const journey = JOURNEYS[0];
    const summary = suiteSummary([
      {
        journeyId: journey.id,
        steps: journey.steps.map((step, index) =>
          result(step.id, index === 0 ? 'failed' : 'passed')
        ),
      },
    ]);
    expect(summary.failed).toBe(1);
    expect(summary.exercisableScorePct).toBeLessThan(100);
  });
});
