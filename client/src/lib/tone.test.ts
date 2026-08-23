import { describe, expect, it } from 'vitest';

import {
  TONE_ACCENT,
  TONE_BADGE,
  TONE_DOT,
  TONE_STROKE,
  TONE_TEXT,
  formatAge,
  freshness,
  worstTone,
  type StateTone,
} from './tone';

const TONES: StateTone[] = ['live', 'good', 'warning', 'danger', 'neutral'];

describe('tone maps', () => {
  it('render every tone, so a new tone cannot fall back to nothing', () => {
    for (const map of [TONE_BADGE, TONE_DOT, TONE_TEXT, TONE_ACCENT, TONE_STROKE]) {
      for (const tone of TONES) {
        expect(map[tone]).toBeTruthy();
      }
    }
  });

  it('does not let a summary read better than its worst part', () => {
    expect(worstTone(['live', 'good', 'warning'])).toBe('warning');
    expect(worstTone(['warning', 'danger'])).toBe('danger');
    expect(worstTone(['live', 'neutral'])).toBe('neutral');
    expect(worstTone([])).toBe('neutral');
  });
});

describe('freshness', () => {
  const now = new Date('2026-08-22T12:00:00Z');

  it('treats a missing observation as absent, never as zero', () => {
    for (const missing of [null, undefined, '']) {
      const result = freshness(missing, 300, now);
      expect(result.stale).toBe(true);
      expect(result.ageSeconds).toBeNull();
      expect(result.tone).toBe('neutral');
      expect(result.label).toBe('never observed');
    }
  });

  it('grades an observation inside its bound as live', () => {
    const result = freshness(new Date(now.getTime() - 4_000), 300, now);
    expect(result.tone).toBe('live');
    expect(result.stale).toBe(false);
    expect(result.label).toContain('4s ago');
  });

  it('keeps showing a stale reading, labelled with its age', () => {
    const result = freshness(new Date(now.getTime() - 600_000), 300, now);
    expect(result.tone).toBe('warning');
    expect(result.stale).toBe(true);
    expect(result.label).toContain('10m ago');
  });

  it('escalates a reading more than three bounds old', () => {
    expect(freshness(new Date(now.getTime() - 1_200_000), 300, now).tone).toBe('danger');
  });

  it('reports a future timestamp as clock skew rather than the freshest reading', () => {
    const result = freshness(new Date(now.getTime() + 600_000), 300, now);
    expect(result.tone).not.toBe('live');
    expect(result.stale).toBe(true);
    expect(result.label).toBe('clock skew');
  });

  it('accepts the string and epoch forms an API returns', () => {
    expect(freshness('2026-08-22T11:59:30Z', 300, now).tone).toBe('live');
    expect(freshness(now.getTime() - 1_000, 300, now).tone).toBe('live');
    expect(freshness('not a date', 300, now).label).toBe('never observed');
  });
});

describe('formatAge', () => {
  it('reads at the scale of the age', () => {
    expect(formatAge(0.4)).toBe('just now');
    expect(formatAge(45)).toBe('45s ago');
    expect(formatAge(600)).toBe('10m ago');
    expect(formatAge(7_200)).toBe('2h ago');
    expect(formatAge(172_800)).toBe('2d ago');
  });
});
