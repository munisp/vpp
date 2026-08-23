/**
 * The lakehouse status surface exists so an unrun ingestion job cannot read as a
 * healthy one. These tests pin the three ways that could quietly break: a failing
 * dataset described by its last success, a dataset with no runs treated as
 * up-to-date, and an uncountable backlog rendered as zero.
 */

import { describe as suite, expect, it } from 'vitest';
import {
  LAKEHOUSE_DATASETS,
  classify,
  describe as describeDataset,
  freshnessSeconds,
} from './services/lakehouse/status';
import { DATASET_STATE_COPY, backlogLabel, bytesLabel } from '../shared/lakehouse-state';

const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);

suite('lakehouse dataset state', () => {
  it('calls a dataset with no run "never_run", not fresh, however new the database is', () => {
    expect(classify(null, null, 3_600, NOW)).toBe('never_run');
  });

  it('reports a failing dataset as failing even when an older run succeeded inside the budget', () => {
    const lastSuccess = new Date(NOW - 60_000);
    expect(classify('failed', lastSuccess, 3_600, NOW)).toBe('failing');
  });

  it('goes stale when the newest success falls outside the freshness budget', () => {
    expect(classify('succeeded', new Date(NOW - 7_200_000), 3_600, NOW)).toBe('stale');
    expect(classify('succeeded', new Date(NOW - 600_000), 3_600, NOW)).toBe('fresh');
  });

  it('treats an empty run as a completed run: nothing to ingest is not staleness', () => {
    expect(classify('empty', new Date(NOW - 60_000), 3_600, NOW)).toBe('fresh');
  });

  it('reports a run still in flight with no completion as never ingested rather than fresh', () => {
    expect(classify('running', null, 3_600, NOW)).toBe('never_run');
  });
});

suite('lakehouse status wording', () => {
  const base = {
    ...LAKEHOUSE_DATASETS[0],
    lastRunState: 'failed' as string | null,
    lastRunAt: null,
    lastSuccessAt: null,
    lastError: 'S3 refused the object: AccessDenied',
    lastObjectKey: null,
    rowsIngested: 0,
    watermarkAt: null,
    rowsBehind: 12,
  };

  it('surfaces the job\'s own error rather than a generic failure', () => {
    const detail = describeDataset({ ...base, state: 'failing' }, 3_600);
    expect(detail).toContain('AccessDenied');
    expect(detail).toContain('watermark did not move');
  });

  it('names the source table when a dataset has never been ingested', () => {
    const detail = describeDataset({ ...base, state: 'never_run' }, 3_600);
    expect(detail).toContain(LAKEHOUSE_DATASETS[0].table);
  });

  it('does not claim a backlog figure when the source could not be counted', () => {
    const detail = describeDataset({ ...base, state: 'stale', rowsBehind: null }, 3_600);
    expect(detail).not.toContain('0 source row');
    expect(backlogLabel(null)).toBe('unknown');
    expect(backlogLabel(0)).toBe('0');
  });
});

suite('lakehouse presentation', () => {
  it('gives every dataset state a tone and a meaning, so no state renders bare', () => {
    for (const copy of Object.values(DATASET_STATE_COPY)) {
      expect(copy.label.length).toBeGreaterThan(0);
      expect(copy.meaning.length).toBeGreaterThan(0);
    }
    expect(DATASET_STATE_COPY.never_run.tone).toBe('danger');
    expect(DATASET_STATE_COPY.fresh.tone).toBe('good');
  });

  it('shows no size for an object that was never written', () => {
    expect(bytesLabel(0)).toBe('—');
    expect(bytesLabel(2_048)).toBe('2.0 KiB');
  });

  it('defaults the freshness budget rather than treating an unset value as instant staleness', () => {
    const previous = process.env.LAKEHOUSE_FRESHNESS_SECONDS;
    delete process.env.LAKEHOUSE_FRESHNESS_SECONDS;
    expect(freshnessSeconds()).toBe(3_600);
    process.env.LAKEHOUSE_FRESHNESS_SECONDS = '90';
    expect(freshnessSeconds()).toBe(90);
    process.env.LAKEHOUSE_FRESHNESS_SECONDS = 'not-a-number';
    expect(freshnessSeconds()).toBe(3_600);
    if (previous === undefined) delete process.env.LAKEHOUSE_FRESHNESS_SECONDS;
    else process.env.LAKEHOUSE_FRESHNESS_SECONDS = previous;
  });
});

suite('lakehouse dataset registry', () => {
  it('matches the Python job on dataset names, so the console cannot describe datasets it never ingests', () => {
    expect(LAKEHOUSE_DATASETS.map(dataset => dataset.dataset)).toEqual([
      'telemetry',
      'payments',
      'trades',
      'p2p_settlements',
      'settlement_events',
      'event_inbox',
    ]);
  });
});
