/**
 * The model health surface exists so a registry row cannot read as a trained
 * model. These tests pin the substitutions that would quietly break that: an
 * unreadable artifact rendered as verified, altered weights rendered as servable,
 * synthetic training data described as fleet data, and a live MAE computed from
 * predictions that have no actual.
 */

import { createHash } from 'crypto';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe as suite, expect, it } from 'vitest';
import { describeArtifact, describeDataset, verifyArtifact } from './services/ml/model-health';
import {
  ARTIFACT_STATE_COPY,
  ORIGIN_COPY,
  copyFor,
  metricLabel,
  provenanceLine,
  TRAINING_RUN_STATE_COPY,
} from '../shared/model-health-state';

let dir: string;
let artifact: string;
let digest: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'model-health-'));
  artifact = join(dir, 'asset_forecaster.pt');
  const bytes = Buffer.from('not a real checkpoint, but a real file');
  await writeFile(artifact, bytes);
  digest = createHash('sha256').update(bytes).digest('hex');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

suite('artifact verification', () => {
  it('verifies weights only by re-hashing them', async () => {
    const check = await verifyArtifact(artifact, digest, null);
    expect(check.state).toBe('verified');
    expect(check.observedDigest).toBe(digest);
    expect(check.bytes).toBeGreaterThan(0);
  });

  it('refuses altered weights instead of serving them', async () => {
    const check = await verifyArtifact(artifact, 'f'.repeat(64), null);
    expect(check.state).toBe('digest_mismatch');
    expect(check.detail).toContain('must not be served');
  });

  it('calls a vanished artifact missing, not unverifiable', async () => {
    const check = await verifyArtifact(join(dir, 'gone.pt'), digest, 4);
    expect(check.state).toBe('missing');
  });

  it('does not claim verification for a row with no artifact recorded', async () => {
    const check = await verifyArtifact(null, null, null);
    expect(check.state).toBe('not_recorded');
    expect(check.detail).toContain('no evidence');
  });

  it('says so when the artifact store is not readable here', () => {
    const detail = describeArtifact({
      state: 'not_readable_here',
      path: '/mnt/models/asset.pt',
      recordedDigest: digest,
      observedDigest: null,
      bytes: null,
    });
    expect(detail).toContain('stands unchecked');
    expect(ARTIFACT_STATE_COPY.not_readable_here.tone).toBe('warning');
  });
});

suite('dataset provenance wording', () => {
  const base = {
    id: 1,
    name: 'asset_power_2026',
    task: 'asset_power_forecast',
    windowStart: new Date('2026-08-01T00:00:00Z'),
    windowEnd: new Date('2026-08-21T00:00:00Z'),
    rows: 5_000,
    sequences: 400,
    entities: 12,
    featureSpecDigest: 'a'.repeat(64),
    sourceObjects: [] as string[],
    sourceDigests: [] as string[],
    generator: null as string | null,
    generatorVersion: null as string | null,
    seed: null as number | null,
    createdAt: null,
    createdBy: 'vppml',
  };

  it('names the generator and seed for synthetic data, and denies it is fleet evidence', () => {
    const detail = describeDataset({
      ...base,
      origin: 'synthetic',
      generator: 'vppml.synthetic.fleet',
      generatorVersion: '1',
      seed: 7,
    });
    expect(detail).toContain('vppml.synthetic.fleet');
    expect(detail).toContain('seed 7');
    expect(detail).toContain('not fleet measurements');
    expect(ORIGIN_COPY.synthetic.tone).toBe('warning');
  });

  it('says lake objects were re-hashed rather than merely listed', () => {
    const detail = describeDataset({
      ...base,
      origin: 'lakehouse',
      sourceObjects: ['raw/telemetry/000123.parquet'],
      sourceDigests: ['b'.repeat(64)],
    });
    expect(detail).toContain('re-hashed');
    expect(provenanceLine('lakehouse', { sourceObjects: ['one'] })).toContain('1 verified');
  });

  it('reports an unlinked dataset as unknown origin, not platform data', () => {
    const detail = describeDataset({ ...base, origin: 'unknown' });
    expect(detail).toContain('unknown');
    expect(ORIGIN_COPY.unknown.tone).toBe('danger');
    expect(provenanceLine('unknown', {})).toBe('no dataset recorded');
  });
});

suite('shared model copy', () => {
  it('describes a refused run as having trained and promoted nothing', () => {
    const copy = copyFor(TRAINING_RUN_STATE_COPY, 'refused');
    expect(copy.meaning).toContain('Nothing was trained');
  });

  it('never renders an unmeasured metric as a number', () => {
    expect(metricLabel(null)).toBe('not measured');
    expect(metricLabel(undefined)).toBe('not measured');
    expect(metricLabel(Number.NaN)).toBe('not measured');
    expect(metricLabel(12.345, 1)).toBe('12.3');
  });

  it('falls back to a neutral, explicitly unrecognised state rather than a good one', () => {
    const copy = copyFor(TRAINING_RUN_STATE_COPY, 'something_new');
    expect(copy.tone).toBe('neutral');
    expect(copy.meaning).toContain('does not recognise');
  });
});
