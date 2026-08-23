/**
 * One copy map for model state, shared by the web console and the mobile app, so
 * neither surface can describe a model more favourably than the other.
 *
 * The distinctions that matter here are the ones a registry row cannot make on its
 * own: weights that were re-hashed against what was evaluated versus weights that
 * were merely recorded; data that came off the platform versus data a generator
 * produced; accuracy measured against actuals versus no actuals at all.
 */

export type Tone = 'good' | 'warning' | 'danger' | 'neutral';

export type ArtifactState =
  | 'verified'
  | 'digest_mismatch'
  | 'missing'
  | 'not_recorded'
  | 'not_readable_here';

export type DataOrigin = 'platform' | 'lakehouse' | 'synthetic' | 'unknown';

export type UsageState = 'serving' | 'idle' | 'never_used';

export interface StateCopy {
  label: string;
  tone: Tone;
  meaning: string;
}

export const ARTIFACT_STATE_COPY: Record<ArtifactState, StateCopy> = {
  verified: {
    label: 'weights verified',
    tone: 'good',
    meaning:
      'The checkpoint was re-read and its SHA-256 matches the digest the training run recorded, so this is the model that was evaluated.',
  },
  digest_mismatch: {
    label: 'weights altered',
    tone: 'danger',
    meaning:
      'The file no longer hashes to what the run recorded. Whatever is on disk was not evaluated and must not be served.',
  },
  missing: {
    label: 'weights gone',
    tone: 'danger',
    meaning:
      'The recorded path holds no file. The registry describes a model that cannot be loaded.',
  },
  not_recorded: {
    label: 'no artifact',
    tone: 'danger',
    meaning:
      'No path or digest was ever recorded for this version, so there is no evidence that training produced weights.',
  },
  not_readable_here: {
    label: 'not verifiable here',
    tone: 'warning',
    meaning:
      'The artifact store is not reachable from the process answering this page, so the trainer’s digest stands unchecked. This is not a claim that the weights are wrong — or that they are right.',
  },
};

export const ORIGIN_COPY: Record<DataOrigin, StateCopy> = {
  platform: {
    label: 'platform data',
    tone: 'good',
    meaning: 'Trained on the operational tables: real telemetry from real assets.',
  },
  lakehouse: {
    label: 'lakehouse data',
    tone: 'good',
    meaning:
      'Trained on lake objects, each re-hashed against the digest its ingestion run recorded before a single row was read.',
  },
  synthetic: {
    label: 'synthetic data',
    tone: 'warning',
    meaning:
      'Trained on generated series, reproducible from a named generator and seed. Its outputs are not evidence about the real fleet.',
  },
  unknown: {
    label: 'origin unknown',
    tone: 'danger',
    meaning: 'No dataset is linked to this version, so what it learned from cannot be established.',
  },
};

export const USAGE_COPY: Record<UsageState, StateCopy> = {
  serving: {
    label: 'in use',
    tone: 'good',
    meaning: 'Predictions have been recorded against this version recently.',
  },
  idle: {
    label: 'idle',
    tone: 'warning',
    meaning:
      'Registered, but no prediction has been recorded in the last day — the inference path may not be running.',
  },
  never_used: {
    label: 'never used',
    tone: 'neutral',
    meaning: 'No prediction has ever been recorded against this version.',
  },
};

export const TRAINING_RUN_STATE_COPY: Record<string, StateCopy> = {
  succeeded: {
    label: 'succeeded',
    tone: 'good',
    meaning:
      'The loop ran, validation improved on a held-out split, and the best epoch was written to a checkpoint.',
  },
  running: {
    label: 'running',
    tone: 'warning',
    meaning: 'Claimed and training, or abandoned by a worker that died before recording an outcome.',
  },
  failed: {
    label: 'failed',
    tone: 'danger',
    meaning: 'The run recorded the error it hit. No model version came from it.',
  },
  refused: {
    label: 'refused',
    tone: 'neutral',
    meaning:
      'The run declined to train — too little data, a gap it would have had to invent, or infrastructure that was not there. Nothing was trained and nothing was promoted.',
  },
};

export const JOB_STATUS_COPY: Record<string, StateCopy> = {
  queued: { label: 'queued', tone: 'neutral', meaning: 'Waiting for a worker to claim it.' },
  running: { label: 'running', tone: 'warning', meaning: 'Claimed by a worker and training now.' },
  completed: {
    label: 'completed',
    tone: 'good',
    meaning: 'Training finished; whether the candidate was promoted is a separate judgement.',
  },
  failed: {
    label: 'failed',
    tone: 'danger',
    meaning: 'The job recorded the error it hit; the live model was left alone.',
  },
  cancelled: {
    label: 'refused',
    tone: 'neutral',
    meaning:
      'The job stopped without training — refused for lack of usable data or unavailable compute. The live model was left alone.',
  },
};

export function copyFor(map: Record<string, StateCopy>, state: string): StateCopy {
  return (
    map[state] ?? {
      label: state || 'unknown',
      tone: 'neutral',
      meaning: 'A state this build does not recognise.',
    }
  );
}

/** `null` is "not measured", which must never render as a number. */
export function metricLabel(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? 'not measured'
    : value.toFixed(digits);
}

export function whenLabel(value: Date | string | null | undefined): string {
  if (!value) return 'never';
  const at = value instanceof Date ? value : new Date(value);
  return Number.isFinite(at.getTime()) ? at.toLocaleString() : 'never';
}

/** How a version's data origin should be summarised in one line. */
export function provenanceLine(
  origin: DataOrigin,
  detail: {
    sourceObjects?: readonly string[];
    generator?: string | null;
    generatorVersion?: string | null;
    seed?: number | null;
  }
): string {
  switch (origin) {
    case 'synthetic':
      return `${detail.generator ?? 'unnamed generator'} v${
        detail.generatorVersion ?? '?'
      }, seed ${detail.seed ?? '?'}`;
    case 'lakehouse':
      return `${detail.sourceObjects?.length ?? 0} verified lake object(s)`;
    case 'platform':
      return 'operational tables';
    default:
      return 'no dataset recorded';
  }
}
