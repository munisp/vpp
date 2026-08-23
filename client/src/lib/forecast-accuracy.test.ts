/**
 * The failure mode these tests exist to prevent: a forecast surface that renders
 * an unmeasured or thinly measured run as an accuracy figure, or that shows a
 * calibration percentage without saying the band was too narrow to trust.
 */

import { describe, it, expect } from 'vitest';
import {
  coverageVerdict,
  formatBias,
  formatPercent,
  measurementConfidence,
} from './forecast-accuracy';

describe('coverageVerdict', () => {
  it('calls a forecast that claimed more certainty than it earned overconfident', () => {
    const verdict = coverageVerdict(5000, 8000);

    expect(verdict.tone).toBe('danger');
    expect(verdict.label).toBe('Overconfident');
  });

  it('flags a band wide enough to always be right as too vague to bid on', () => {
    const verdict = coverageVerdict(10000, 8000);

    expect(verdict.tone).toBe('warning');
    expect(verdict.meaning).toMatch(/vague/);
  });

  it('accepts coverage close to the advertised band', () => {
    expect(coverageVerdict(7800, 8000).tone).toBe('good');
  });

  it('never renders a missing measurement as a coverage result', () => {
    const verdict = coverageVerdict(null, 8000);

    expect(verdict.tone).toBe('neutral');
    expect(verdict.label).toBe('Not measured');
  });
});

describe('measurementConfidence', () => {
  it('reports a type with no scored runs as unmeasured, not accurate', () => {
    const verdict = measurementConfidence(
      { scoredRuns: 0, unmeasuredRuns: 12, sampleCount: 0 },
      4
    );

    expect(verdict.label).toBe('Unmeasured');
    expect(verdict.meaning).toMatch(/12 runs produced no usable actuals/);
  });

  it('marks a score built on more unmeasured runs than measured ones as thin', () => {
    const verdict = measurementConfidence(
      { scoredRuns: 2, unmeasuredRuns: 40, sampleCount: 200 },
      4
    );

    expect(verdict.label).toBe('Thin evidence');
  });

  it('marks a handful of paired points as thin even with no unmeasured runs', () => {
    expect(
      measurementConfidence({ scoredRuns: 1, unmeasuredRuns: 0, sampleCount: 5 }, 4).label
    ).toBe('Thin evidence');
  });

  it('accepts a score with substantial paired evidence', () => {
    const verdict = measurementConfidence(
      { scoredRuns: 20, unmeasuredRuns: 1, sampleCount: 1920 },
      4
    );

    expect(verdict.label).toBe('Measured');
  });
});

describe('formatting', () => {
  it('says not measured instead of showing a zero', () => {
    expect(formatPercent(null)).toBe('not measured');
    expect(formatBias(null, 'W')).toBe('not measured');
  });

  it('keeps the direction of a biased forecast visible', () => {
    expect(formatBias(-250.4, 'W')).toBe('-250.4 W low');
    expect(formatBias(120, 'W')).toBe('+120.0 W high');
    expect(formatBias(0.01, 'W')).toBe('balanced');
  });
});
