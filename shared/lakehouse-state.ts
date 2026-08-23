/**
 * One copy map for lakehouse ingestion state, shared by the web console and the
 * mobile app, so neither surface can quietly describe a dataset more favourably
 * than the other. A dataset that has never been ingested must read the same in
 * both places: not empty, not healthy — absent.
 */

export type Tone = 'good' | 'warning' | 'danger' | 'neutral';

export type DatasetState = 'fresh' | 'stale' | 'failing' | 'never_run';

export const DATASET_STATE_COPY: Record<DatasetState, { label: string; tone: Tone; meaning: string }> =
  {
    fresh: {
      label: 'ingesting',
      tone: 'good',
      meaning: 'A run finished inside the freshness budget, and its object read back with the digest it was written with.',
    },
    stale: {
      label: 'stale',
      tone: 'warning',
      meaning: 'No successful run inside the freshness budget: anything reading this dataset is reading older data than the platform holds.',
    },
    failing: {
      label: 'failing',
      tone: 'danger',
      meaning: 'The last run failed. The watermark did not move, so no rows were skipped — but nothing new landed either.',
    },
    never_run: {
      label: 'never ingested',
      tone: 'danger',
      meaning: 'This dataset has never been written to the lake, so a query over it answers from nothing rather than from the platform.',
    },
  };

export const RUN_STATE_COPY: Record<string, { label: string; tone: Tone; meaning: string }> = {
  succeeded: {
    label: 'succeeded',
    tone: 'good',
    meaning: 'Rows were written and the stored object was read back and verified.',
  },
  empty: {
    label: 'empty',
    tone: 'neutral',
    meaning: 'The run found no new rows. Nothing was stored, and that is not a load.',
  },
  running: {
    label: 'running',
    tone: 'warning',
    meaning: 'Claimed and in progress, or abandoned by a job that died before recording an outcome.',
  },
  failed: {
    label: 'failed',
    tone: 'danger',
    meaning: 'The run recorded the error it hit; the watermark was left where it was.',
  },
};

export function runStateCopy(state: string): { label: string; tone: Tone; meaning: string } {
  return (
    RUN_STATE_COPY[state] ?? {
      label: state,
      tone: 'neutral',
      meaning: 'A run state this build does not recognise.',
    }
  );
}

export function bytesLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** `null` is "we could not count", which must never render as zero backlog. */
export function backlogLabel(rowsBehind: number | null): string {
  return rowsBehind === null ? 'unknown' : String(rowsBehind);
}

export function whenLabel(value: string | Date | null): string {
  if (!value) return 'never';
  const at = value instanceof Date ? value : new Date(value);
  return Number.isFinite(at.getTime()) ? at.toLocaleString() : 'unknown';
}
