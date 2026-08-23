/**
 * What the platform can honestly say about its models.
 *
 * Training itself is Python (`services/ml/`). This module reads only its
 * bookkeeping — `model_registry`, `training_runs`, `training_datasets`,
 * `model_feature_baselines`, `model_predictions`, `retraining_jobs` — and refuses
 * to turn a row into a claim the row does not support:
 *
 * - **Provenance is never inferred.** A dataset says `platform`, `lakehouse` or
 *   `synthetic`, and a synthetic dataset is reported with its generator, version
 *   and seed so nobody reads generated series as fleet telemetry. A model with no
 *   recorded dataset reads `unknown`, not `platform`.
 * - **Artifacts are verified, not assumed.** A registry row is not evidence that
 *   weights exist. Where this process can read the artifact directory the file is
 *   re-hashed against the digest the run recorded; where it cannot, the state is
 *   `not_readable_here` rather than `verified`.
 * - **Live accuracy comes from actuals only.** Predictions whose actual has not
 *   arrived are excluded; a model with none reads `no_actuals`, and one scored too
 *   few times to mean anything reads `too_few_scored` rather than borrowing either
 *   verdict.
 * - **Staleness is measured.** A production model whose newest prediction is older
 *   than the budget reads `idle`; one that has never predicted reads `never_used`.
 */

import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { sql } from 'drizzle-orm';
import { getDb } from '../../db';

export type DataOrigin = 'platform' | 'lakehouse' | 'synthetic' | 'unknown';

export type ArtifactState =
  /** Re-hashed here and identical to the digest the training run recorded. */
  | 'verified'
  /** Readable, but the bytes are not the bytes that were evaluated. */
  | 'digest_mismatch'
  /** The path is recorded and this process can look, but nothing is there. */
  | 'missing'
  /** The registry row has no artifact path or digest at all. */
  | 'not_recorded'
  /** The artifact lives where this process cannot read it; the trainer's digest stands unchecked. */
  | 'not_readable_here';

export type UsageState = 'serving' | 'idle' | 'never_used';

export type LiveAccuracyState =
  /** Enough predictions carry an actual for the live error to mean something. */
  | 'measured'
  /** Not one prediction has an actual yet. */
  | 'no_actuals'
  /** Some predictions are scored, but too few to report a live error from. */
  | 'too_few_scored';

/** Newest predictions older than this and a production model is not really serving. */
export const USAGE_BUDGET_SECONDS = 24 * 3600;

/** Live MAE at or above this multiple of held-out MAE is a degradation, per `vppml.drift`. */
export const DEGRADATION_RATIO = 1.5;

/** Below this many scored predictions a live MAE says more about the sample than the model. */
export const MIN_SCORED_PREDICTIONS = 20;

export interface DatasetProvenance {
  id: number;
  name: string;
  origin: DataOrigin;
  task: string;
  windowStart: Date | null;
  windowEnd: Date | null;
  rows: number;
  sequences: number;
  entities: number;
  featureSpecDigest: string | null;
  /** Lake objects the dataset was built from, each re-hashed by the trainer. */
  sourceObjects: string[];
  sourceDigests: string[];
  generator: string | null;
  generatorVersion: string | null
  seed: number | null;
  createdAt: Date | null;
  createdBy: string | null;
  detail: string;
}

export interface TrainingRunSummary {
  id: number;
  state: string;
  framework: string;
  frameworkVersion: string;
  /** 'local' or the Ray cluster that actually ran it — never inferred from config. */
  compute: string;
  epochsRequested: number;
  epochsRan: number;
  bestEpoch: number | null;
  trainSequences: number;
  valSequences: number;
  trainLoss: number | null;
  valLoss: number | null;
  metrics: Record<string, number>;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationSeconds: number | null;
  runner: string;
  trigger: string;
  refusalReason: string | null;
  error: string | null;
}

export interface ArtifactCheck {
  state: ArtifactState;
  path: string | null;
  recordedDigest: string | null;
  observedDigest: string | null;
  bytes: number | null;
  detail: string;
}

export interface LiveAccuracy {
  state: LiveAccuracyState;
  scoredPredictions: number;
  unscoredPredictions: number;
  liveMae: number | null;
  heldOutMae: number | null;
  ratio: number | null;
  degraded: boolean;
  detail: string;
}

export interface ModelHealth {
  id: number;
  modelName: string;
  version: string;
  modelType: string;
  status: string;
  deployedAt: Date | null;
  createdAt: Date | null;
  /** Set when this version was installed by a rollback, with the version it replaced. */
  rolledBackFrom: { id: number; version: string } | null;
  dataset: DatasetProvenance | null;
  run: TrainingRunSummary | null;
  artifact: ArtifactCheck;
  heldOutMetrics: Record<string, number>;
  baselineFeatures: number;
  usage: UsageState;
  lastPredictionAt: Date | null;
  accuracy: LiveAccuracy;
  detail: string;
}

export interface RetrainingJobSummary {
  jobId: string;
  modelId: number;
  modelName: string | null;
  triggerType: string;
  triggeredBy: string | null;
  status: string;
  createdAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  newModelVersion: string | null;
  errorMessage: string | null;
  promoted: boolean | null;
  promotionNote: string | null;
}

export interface ModelHealthOverview {
  models: ModelHealth[];
  /** Production versions whose artifact could not be verified as the trained bytes. */
  unverifiedProduction: number;
  syntheticInProduction: number;
  jobs: RetrainingJobSummary[];
  artifactDirConfigured: boolean;
  detail: string;
}

function asDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asJson(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === 'object') return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function numericMetrics(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(asJson(value))) {
    const parsed = asNumber(raw);
    if (parsed !== null) out[key] = parsed;
  }
  return out;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => String(item)) : [];
}

function asOrigin(value: unknown): DataOrigin {
  const origin = value === null || value === undefined ? '' : String(value);
  return origin === 'platform' || origin === 'lakehouse' || origin === 'synthetic'
    ? origin
    : 'unknown';
}

export function describeDataset(dataset: Omit<DatasetProvenance, 'detail'>): string {
  const window =
    dataset.windowStart && dataset.windowEnd
      ? `${dataset.windowStart.toISOString()} to ${dataset.windowEnd.toISOString()}`
      : 'an unrecorded window';
  switch (dataset.origin) {
    case 'synthetic':
      return `Generated by ${dataset.generator ?? 'an unnamed generator'} v${
        dataset.generatorVersion ?? '?'
      } from seed ${dataset.seed ?? '?'} over ${window}. These are not fleet measurements: a figure this model produces about the real fleet is not evidence about the real fleet.`;
    case 'lakehouse':
      return `${dataset.rows} row(s) read from ${dataset.sourceObjects.length} lake object(s) over ${window}; every object was re-hashed against the digest its ingestion run recorded.`;
    case 'platform':
      return `${dataset.rows} row(s) read from the operational tables over ${window}, giving ${dataset.sequences} training sequence(s) across ${dataset.entities} asset(s).`;
    default:
      return 'The origin of this training data was not recorded, so what the model learned from is unknown.';
  }
}

export function describeArtifact(check: Omit<ArtifactCheck, 'detail'>): string {
  switch (check.state) {
    case 'verified':
      return `The stored weights re-hash to the digest the training run recorded${
        check.bytes === null ? '' : ` (${check.bytes} bytes)`
      }, so this version can be served as evaluated.`;
    case 'digest_mismatch':
      return `${check.path} hashes to ${check.observedDigest} but the run recorded ${check.recordedDigest}. These are not the weights that were evaluated and must not be served.`;
    case 'missing':
      return `${check.path} does not exist. The registry row describes a model whose weights are gone.`;
    case 'not_recorded':
      return 'No artifact path or digest is recorded, so there is no evidence any weights were ever produced.';
    default:
      return `${check.path} is not readable from this process, so the trainer's digest stands unchecked here. Verification happens where the file lives.`;
  }
}

export function describeAccuracy(accuracy: Omit<LiveAccuracy, 'detail'>): string {
  if (accuracy.state === 'too_few_scored') {
    return `Only ${accuracy.scoredPredictions} prediction(s) carry an actual, below the ${MIN_SCORED_PREDICTIONS} needed for a live error to say more about the model than the sample, so live accuracy is unknown — not good.`;
  }
  if (accuracy.state === 'no_actuals') {
    return accuracy.unscoredPredictions > 0
      ? `${accuracy.unscoredPredictions} prediction(s) have no actual recorded yet and none has been scored, so live accuracy is unknown — not good.`
      : 'No prediction has been scored against an actual, so live accuracy is unknown.';
  }
  const live = accuracy.liveMae === null ? '?' : accuracy.liveMae.toFixed(1);
  if (accuracy.heldOutMae === null) {
    return `Live MAE ${live} over ${accuracy.scoredPredictions} scored prediction(s); the version records no held-out MAE, so there is nothing comparable to judge it against.`;
  }
  const ratio = accuracy.ratio === null ? '?' : accuracy.ratio.toFixed(2);
  return accuracy.degraded
    ? `Live MAE ${live} is ${ratio}x the held-out ${accuracy.heldOutMae.toFixed(
        1
      )} over ${accuracy.scoredPredictions} scored prediction(s) — measured degradation, which is a retraining trigger.`
    : `Live MAE ${live} against a held-out ${accuracy.heldOutMae.toFixed(
        1
      )} over ${accuracy.scoredPredictions} scored prediction(s).`;
}

function describeModel(model: Omit<ModelHealth, 'detail'>): string {
  if (model.status === 'production' && model.artifact.state === 'digest_mismatch') {
    return 'Serving is unsafe: this is the live version and its weights are not the bytes that were evaluated.';
  }
  if (model.status === 'production' && model.artifact.state === 'missing') {
    return 'This is the live version and its weights are gone, so any inference path depending on it cannot load a model.';
  }
  if (model.run === null) {
    return 'No training run is linked to this version, so how it was produced is unrecorded.';
  }
  if (model.usage === 'never_used' && model.status === 'production') {
    return 'Deployed but no prediction has ever been recorded against it, so nothing on this platform is actually using it.';
  }
  if (model.usage === 'idle' && model.status === 'production') {
    return `Deployed, but the newest prediction is older than ${
      USAGE_BUDGET_SECONDS / 3600
    }h — the inference path may not be running.`;
  }
  return model.accuracy.detail;
}

/**
 * Re-hash a checkpoint. `not_readable_here` is deliberate: the API process may
 * legitimately not share a filesystem with the trainer, and saying "verified"
 * because a row exists is exactly the substitution this surface exists to prevent.
 */
export async function verifyArtifact(
  path: string | null,
  recordedDigest: string | null,
  recordedBytes: number | null
): Promise<ArtifactCheck> {
  if (!path || !recordedDigest) {
    const partial = {
      state: 'not_recorded' as ArtifactState,
      path: path ?? null,
      recordedDigest,
      observedDigest: null,
      bytes: recordedBytes,
    };
    return { ...partial, detail: describeArtifact(partial) };
  }

  let bytes = recordedBytes;
  try {
    const info = await stat(path);
    bytes = info.size;
  } catch (error) {
    const code = (error as { code?: string }).code;
    const state: ArtifactState = code === 'ENOENT' ? 'missing' : 'not_readable_here';
    const partial = { state, path, recordedDigest, observedDigest: null, bytes: recordedBytes };
    return { ...partial, detail: describeArtifact(partial) };
  }

  let observedDigest: string | null = null;
  try {
    observedDigest = await new Promise<string>((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = createReadStream(path);
      stream.on('error', reject);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  } catch {
    const partial = {
      state: 'not_readable_here' as ArtifactState,
      path,
      recordedDigest,
      observedDigest: null,
      bytes,
    };
    return { ...partial, detail: describeArtifact(partial) };
  }

  const state: ArtifactState = observedDigest === recordedDigest ? 'verified' : 'digest_mismatch';
  const partial = { state, path, recordedDigest, observedDigest, bytes };
  return { ...partial, detail: describeArtifact(partial) };
}

export async function modelHealth(limit = 50): Promise<ModelHealthOverview> {
  const db = await getDb();
  if (!db) throw new Error('No database connection, so model health cannot be read.');

  const versions = await db.execute<Record<string, unknown>>(sql`
    SELECT m.id, m.model_name, m.model_version, m.model_type, m.status, m.deployed_at,
           m.created_at, m.validation_metrics, m.artifact_path, m.artifact_hash,
           m.training_dataset_id, m.training_run_id, m.rolled_back_from_id,
           prev.model_version AS rolled_back_from_version,
           d.name AS dataset_name, d.origin, d.task, d.window_start, d.window_end,
           d.rows, d.sequences, d.entities, d.feature_spec_digest, d.source_objects,
           d.source_digests, d.generator, d.generator_version, d.seed,
           d.created_at AS dataset_created_at, d.created_by,
           r.id AS run_id, r.state AS run_state, r.framework, r.framework_version, r.compute,
           r.epochs_requested, r.epochs_ran, r.best_epoch, r.train_sequences, r.val_sequences,
           r.train_loss, r.val_loss, r.metrics AS run_metrics, r.started_at, r.finished_at,
           r.duration_seconds, r.runner, r.trigger, r.refusal_reason, r.error,
           r.checkpoint_path, r.checkpoint_digest, r.checkpoint_bytes,
           (SELECT COUNT(*) FROM model_feature_baselines b WHERE b.model_id = m.id)
             AS baseline_features,
           (SELECT MAX(p.created_at) FROM model_predictions p WHERE p.model_id = m.id)
             AS last_prediction_at,
           (SELECT COUNT(*) FROM model_predictions p
             WHERE p.model_id = m.id AND p.actual_value IS NOT NULL) AS scored,
           (SELECT COUNT(*) FROM model_predictions p
             WHERE p.model_id = m.id AND p.actual_value IS NULL) AS unscored,
           (SELECT AVG(ABS(p.predicted_value - p.actual_value)) FROM model_predictions p
             WHERE p.model_id = m.id AND p.actual_value IS NOT NULL) AS live_mae
      FROM model_registry m
      LEFT JOIN training_datasets d ON d.id = m.training_dataset_id
      LEFT JOIN training_runs r ON r.id = m.training_run_id
      LEFT JOIN model_registry prev ON prev.id = m.rolled_back_from_id
     ORDER BY m.model_name, m.id DESC
     LIMIT ${limit}
  `);

  const now = Date.now();
  const models: ModelHealth[] = [];
  for (const row of versions.rows) {
    const datasetId = asNumber(row.training_dataset_id);
    let dataset: DatasetProvenance | null = null;
    if (datasetId !== null) {
      const partial: Omit<DatasetProvenance, 'detail'> = {
        id: datasetId,
        name: String(row.dataset_name ?? ''),
        origin: asOrigin(row.origin),
        task: String(row.task ?? ''),
        windowStart: asDate(row.window_start),
        windowEnd: asDate(row.window_end),
        rows: asNumber(row.rows) ?? 0,
        sequences: asNumber(row.sequences) ?? 0,
        entities: asNumber(row.entities) ?? 0,
        featureSpecDigest: row.feature_spec_digest ? String(row.feature_spec_digest) : null,
        sourceObjects: asStringArray(row.source_objects),
        sourceDigests: asStringArray(row.source_digests),
        generator: row.generator ? String(row.generator) : null,
        generatorVersion: row.generator_version ? String(row.generator_version) : null,
        seed: asNumber(row.seed),
        createdAt: asDate(row.dataset_created_at),
        createdBy: row.created_by ? String(row.created_by) : null,
      };
      dataset = { ...partial, detail: describeDataset(partial) };
    }

    const runId = asNumber(row.run_id);
    const run: TrainingRunSummary | null =
      runId === null
        ? null
        : {
            id: runId,
            state: String(row.run_state ?? ''),
            framework: String(row.framework ?? ''),
            frameworkVersion: String(row.framework_version ?? ''),
            compute: String(row.compute ?? ''),
            epochsRequested: asNumber(row.epochs_requested) ?? 0,
            epochsRan: asNumber(row.epochs_ran) ?? 0,
            bestEpoch: asNumber(row.best_epoch),
            trainSequences: asNumber(row.train_sequences) ?? 0,
            valSequences: asNumber(row.val_sequences) ?? 0,
            trainLoss: asNumber(row.train_loss),
            valLoss: asNumber(row.val_loss),
            metrics: numericMetrics(row.run_metrics),
            startedAt: asDate(row.started_at),
            finishedAt: asDate(row.finished_at),
            durationSeconds: asNumber(row.duration_seconds),
            runner: String(row.runner ?? ''),
            trigger: String(row.trigger ?? ''),
            refusalReason: row.refusal_reason ? String(row.refusal_reason) : null,
            error: row.error ? String(row.error) : null,
          };

    // The run's own record of what it wrote is preferred; the registry columns are
    // a copy, and a disagreement between them is itself worth surfacing.
    const artifactPath = (row.checkpoint_path ?? row.artifact_path) as string | null;
    const artifactDigest = (row.checkpoint_digest ?? row.artifact_hash) as string | null;
    const artifact = await verifyArtifact(
      artifactPath ? String(artifactPath) : null,
      artifactDigest ? String(artifactDigest) : null,
      asNumber(row.checkpoint_bytes)
    );

    const heldOutMetrics = numericMetrics(row.validation_metrics);
    const heldOutMae = heldOutMetrics.val_mae_w ?? null;
    const scored = asNumber(row.scored) ?? 0;
    const unscored = asNumber(row.unscored) ?? 0;
    const liveMae = asNumber(row.live_mae);
    const measurable = scored >= MIN_SCORED_PREDICTIONS && liveMae !== null;
    const ratio = measurable && heldOutMae !== null && heldOutMae > 0 ? liveMae / heldOutMae : null;
    const accuracyPartial: Omit<LiveAccuracy, 'detail'> = {
      state: measurable ? 'measured' : scored > 0 ? 'too_few_scored' : 'no_actuals',
      scoredPredictions: scored,
      unscoredPredictions: unscored,
      liveMae: measurable ? liveMae : null,
      heldOutMae,
      ratio,
      degraded: ratio !== null && ratio >= DEGRADATION_RATIO,
    };
    const accuracy: LiveAccuracy = {
      ...accuracyPartial,
      detail: describeAccuracy(accuracyPartial),
    };

    const lastPredictionAt = asDate(row.last_prediction_at);
    const usage: UsageState =
      lastPredictionAt === null
        ? 'never_used'
        : now - lastPredictionAt.getTime() <= USAGE_BUDGET_SECONDS * 1_000
          ? 'serving'
          : 'idle';

    const rolledBackFromId = asNumber(row.rolled_back_from_id);
    const partial: Omit<ModelHealth, 'detail'> = {
      id: asNumber(row.id) ?? 0,
      modelName: String(row.model_name ?? ''),
      version: String(row.model_version ?? ''),
      modelType: String(row.model_type ?? ''),
      status: String(row.status ?? ''),
      deployedAt: asDate(row.deployed_at),
      createdAt: asDate(row.created_at),
      rolledBackFrom:
        rolledBackFromId === null
          ? null
          : {
              id: rolledBackFromId,
              version: String(row.rolled_back_from_version ?? ''),
            },
      dataset,
      run,
      artifact,
      heldOutMetrics,
      baselineFeatures: asNumber(row.baseline_features) ?? 0,
      usage,
      lastPredictionAt,
      accuracy,
    };
    models.push({ ...partial, detail: describeModel(partial) });
  }

  const jobRows = await db.execute<Record<string, unknown>>(sql`
    SELECT j.job_id, j.model_id, m.model_name, j.trigger_type, j.triggered_by, j.status,
           j.created_at, j.started_at, j.completed_at, j.new_model_version, j.error_message,
           j.metrics
      FROM retraining_jobs j
      LEFT JOIN model_registry m ON m.id = j.model_id
     ORDER BY j.id DESC
     LIMIT 25
  `);

  const jobs: RetrainingJobSummary[] = jobRows.rows.map(row => {
    const metrics = asJson(row.metrics);
    const promoted = metrics.promoted;
    return {
      jobId: String(row.job_id ?? ''),
      modelId: asNumber(row.model_id) ?? 0,
      modelName: row.model_name ? String(row.model_name) : null,
      triggerType: String(row.trigger_type ?? ''),
      triggeredBy: row.triggered_by ? String(row.triggered_by) : null,
      status: String(row.status ?? ''),
      createdAt: asDate(row.created_at),
      startedAt: asDate(row.started_at),
      completedAt: asDate(row.completed_at),
      newModelVersion: row.new_model_version ? String(row.new_model_version) : null,
      errorMessage: row.error_message ? String(row.error_message) : null,
      promoted: typeof promoted === 'boolean' ? promoted : null,
      promotionNote: metrics.promotion_note ? String(metrics.promotion_note) : null,
    };
  });

  const production = models.filter(model => model.status === 'production');
  const unverifiedProduction = production.filter(model => model.artifact.state !== 'verified').length;
  const syntheticInProduction = production.filter(
    model => model.dataset?.origin === 'synthetic'
  ).length;

  return {
    models,
    unverifiedProduction,
    syntheticInProduction,
    jobs,
    artifactDirConfigured: Boolean(process.env.ML_ARTIFACT_DIR),
    detail:
      models.length === 0
        ? 'No model version has ever been registered, so nothing on this platform is serving a trained model.'
        : `${production.length} production version(s) of ${models.length} registered; ${unverifiedProduction} whose weights could not be verified here, ${syntheticInProduction} trained on synthetic data.`,
  };
}
