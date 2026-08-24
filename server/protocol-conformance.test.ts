/**
 * Regression tests for protocol conformance evidence:
 *  - a run's digest is computed from the run, not taken from the runner, and a
 *    submitted digest that disagrees is refused
 *  - a completed run with no cases, or with duplicate case ids, is refused
 *  - a run with a skipped case is `failed`, not `passed`
 *  - only a recent, complete pass reads as `proven`; failed, stale, never-tested
 *    and no-vector-set are distinct states and none of them is proof
 *  - a certification cannot be created without a passing run for that adapter
 *  - a control over a protocol with no passing run is labelled unproven
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

import {
  CONFORMANCE_ADAPTERS,
  CONFORMANCE_ADAPTER_LABELS,
  PROTOCOL_PROOF_COPY,
  isProven,
  type ProtocolProofState,
} from '../shared/protocol-conformance-copy';

const ORIGINAL_ENV = { ...process.env };
const NOW = new Date('2026-06-01T12:00:00.000Z');

interface FakeRunRow {
  id: number;
  adapter: string;
  outcome: 'passed' | 'failed' | 'refused';
  completedAt: Date;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  skippedCases: number;
  adapterVersion: string;
  protocolVersion: string;
  deviceModel: string;
  deviceIdentifier: string | null;
  target: 'simulator' | 'device';
  vectorSetId: string;
  vectorSetVersion: string;
  operator: string;
  startedAt: Date;
  artifactChecksum: string;
  artifactUri: string | null;
  detail: string | null;
}

function runRow(overrides: Partial<FakeRunRow>): FakeRunRow {
  return {
    id: 1,
    adapter: 'ocpp16',
    outcome: 'passed',
    completedAt: new Date(NOW.getTime() - 86_400_000),
    totalCases: 10,
    passedCases: 10,
    failedCases: 0,
    skippedCases: 0,
    adapterVersion: 'test',
    protocolVersion: '1.6',
    deviceModel: 'simulator',
    deviceIdentifier: null,
    target: 'simulator',
    vectorSetId: 'vpp-ocpp16',
    vectorSetVersion: '1',
    operator: 'go-test',
    startedAt: new Date(NOW.getTime() - 86_400_000 - 60_000),
    artifactChecksum: 'a'.repeat(64),
    artifactUri: null,
    detail: null,
    ...overrides,
  };
}

/**
 * A query stub shaped like the drizzle builder chain the service uses. Each
 * queued result answers one terminal call in order, so a test that adds a query
 * to the service sees an explicit failure rather than a stale answer.
 */
function fakeDb(results: unknown[][]) {
  const queue = [...results];
  const next = () => queue.shift() ?? [];
  const builder: Record<string, unknown> = {};
  for (const method of [
    'select',
    'from',
    'where',
    'orderBy',
    'limit',
    'groupBy',
    'innerJoin',
    'leftJoin',
  ]) {
    builder[method] = () => builder;
  }
  builder.then = (resolve: (value: unknown[]) => unknown) => Promise.resolve(next()).then(resolve);
  const db = {
    select: () => builder,
    execute: async () => ({ rows: next() }),
    insert: () => ({
      values: (rows: unknown) => {
        const inserted = { returning: async () => next() };
        // A values() call with no returning() (the case rows) still has to be
        // awaitable, exactly as drizzle's is.
        return Object.assign(Promise.resolve(rows), inserted);
      },
    }),
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  return db;
}

async function loadService(results: unknown[][] = []) {
  vi.doMock('./db', () => ({ getDb: async () => fakeDb(results) }));
  return import('./services/protocol-conformance');
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('./db');
});

function caseInput(caseId: string, outcome: 'pass' | 'fail' | 'skipped' = 'pass') {
  return { caseId, name: caseId, requirement: 'clause 1', outcome };
}

function runInput(overrides: Record<string, unknown> = {}) {
  return {
    adapter: 'ocpp16' as const,
    adapterVersion: 'abc123',
    protocolVersion: '1.6',
    deviceModel: 'vpp-ocpp16-station-simulator',
    target: 'simulator' as const,
    vectorSetId: 'vpp-ocpp16-central-system',
    vectorSetVersion: '1',
    operator: 'operator@example.test',
    startedAt: new Date('2026-06-01T11:00:00.000Z'),
    completedAt: new Date('2026-06-01T11:01:00.000Z'),
    cases: [caseInput('ocpp16-001'), caseInput('ocpp16-002')],
    ...overrides,
  };
}

describe('artifactChecksum', () => {
  it('is stable across case ordering but changes with an outcome', async () => {
    const { artifactChecksum } = await loadService();
    const forward = artifactChecksum(runInput());
    const reversed = artifactChecksum(
      runInput({ cases: [caseInput('ocpp16-002'), caseInput('ocpp16-001')] })
    );
    expect(reversed).toBe(forward);

    const withFailure = artifactChecksum(
      runInput({ cases: [caseInput('ocpp16-001'), caseInput('ocpp16-002', 'fail')] })
    );
    expect(withFailure).not.toBe(forward);
  });

  it('distinguishes a simulator run from a device run', async () => {
    const { artifactChecksum } = await loadService();
    expect(artifactChecksum(runInput({ target: 'device' }))).not.toBe(
      artifactChecksum(runInput())
    );
  });
});

describe('recordRun', () => {
  it('refuses a checksum that does not match the run as submitted', async () => {
    const { recordRun } = await loadService();
    await expect(recordRun(runInput({ artifactChecksum: 'f'.repeat(64) }))).rejects.toThrow(
      /evidence and its digest disagree/
    );
  });

  it('refuses a completed run with no cases', async () => {
    const { recordRun } = await loadService();
    await expect(recordRun(runInput({ cases: [] }))).rejects.toThrow(/at least one case/);
  });

  it('refuses duplicate case ids', async () => {
    const { recordRun } = await loadService();
    await expect(
      recordRun(runInput({ cases: [caseInput('ocpp16-001'), caseInput('ocpp16-001')] }))
    ).rejects.toThrow(/duplicate case id/);
  });

  it('refuses a run that completed before it started', async () => {
    const { recordRun } = await loadService();
    await expect(
      recordRun(runInput({ completedAt: new Date('2026-06-01T10:00:00.000Z') }))
    ).rejects.toThrow(/cannot complete before it started/);
  });

  it('records a run with a skipped case as failed', async () => {
    const { recordRun } = await loadService([[{ id: 7 }]]);
    const recorded = await recordRun(
      runInput({ cases: [caseInput('ocpp16-001'), caseInput('ocpp16-002', 'skipped')] })
    );
    expect(recorded.outcome).toBe('failed');
    expect(recorded.skippedCases).toBe(1);
    expect(recorded.artifactChecksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores a refused run so the attempt stays visible', async () => {
    const { recordRun } = await loadService([[{ id: 8 }]]);
    const recorded = await recordRun(
      runInput({ cases: [], refused: { reason: 'the simulated peer never opened a session' } })
    );
    expect(recorded.outcome).toBe('refused');
    expect(recorded.totalCases).toBe(0);
  });
});

describe('adapterForProtocolLabel', () => {
  it('resolves the spellings operators actually type, and nothing else', async () => {
    const { adapterForProtocolLabel } = await loadService();
    expect(adapterForProtocolLabel('OCPP 1.6J')).toBe('ocpp16');
    expect(adapterForProtocolLabel('ocpp2.0.1')).toBe('ocpp201');
    expect(adapterForProtocolLabel('OpenADR 2.0b')).toBe('openadr2b');
    expect(adapterForProtocolLabel('IEEE 2030.5')).toBe('ieee2030_5');
    expect(adapterForProtocolLabel('SunSpec')).toBe('modbus_sunspec');
    expect(adapterForProtocolLabel('Matter')).toBe('matter');
    // MQTT setpoints have no vector set here, so there is nothing to resolve and
    // the caller must report an absence rather than a failure.
    expect(adapterForProtocolLabel('mqtt')).toBeNull();
  });
});

describe('proof states', () => {
  it('reads a recent complete pass as proven', async () => {
    const { adapterProof } = await loadService([[runRow({})], [runRow({})]]);
    const proof = await adapterProof('ocpp16', NOW);
    expect(proof.state).toBe<ProtocolProofState>('proven');
  });

  it('reads an expired pass as stale rather than proven', async () => {
    const stale = runRow({ completedAt: new Date(NOW.getTime() - 400 * 86_400_000) });
    const { adapterProof } = await loadService([[stale], [stale]]);
    const proof = await adapterProof('ocpp16', NOW);
    expect(proof.state).toBe<ProtocolProofState>('proof_stale');
  });

  it('reads a failed latest run as failed conformance, not merely unproven', async () => {
    const failed = runRow({ outcome: 'failed', passedCases: 9, failedCases: 1 });
    const { adapterProof } = await loadService([[], [failed]]);
    const proof = await adapterProof('ocpp16', NOW);
    expect(proof.state).toBe<ProtocolProofState>('suite_failed');
  });

  it('stops reading proven once a newer run has failed', async () => {
    // An older pass is still inside the evidence window, but last night's run
    // failed: a regression must not hide behind the run it regressed from.
    const passed = runRow({ id: 1, completedAt: new Date(NOW.getTime() - 10 * 86_400_000) });
    const failed = runRow({
      id: 2,
      outcome: 'failed',
      passedCases: 9,
      failedCases: 1,
      completedAt: new Date(NOW.getTime() - 86_400_000),
    });
    const { adapterProof } = await loadService([[passed], [failed]]);
    const proof = await adapterProof('ocpp16', NOW);
    expect(proof.state).toBe<ProtocolProofState>('suite_failed');
    expect(proof.run?.id).toBe(2);
  });

  it('reads no runs at all as claimed but unproven', async () => {
    const { adapterProof } = await loadService([[], []]);
    const proof = await adapterProof('ocpp16', NOW);
    expect(proof.state).toBe<ProtocolProofState>('claimed_unproven');
    expect(proof.run).toBeNull();
  });

  it('honours a shortened evidence window and refuses a nonsense one', async () => {
    process.env.CONFORMANCE_PROOF_VALIDITY_DAYS = '7';
    const run = runRow({ completedAt: new Date(NOW.getTime() - 30 * 86_400_000) });
    const { adapterProof, proofValidityDays } = await loadService([[run], [run]]);
    expect(proofValidityDays()).toBe(7);
    expect((await adapterProof('ocpp16', NOW)).state).toBe('proof_stale');

    process.env.CONFORMANCE_PROOF_VALIDITY_DAYS = 'soon';
    expect(() => proofValidityDays()).toThrow(/must be a number of days/);
  });
});

describe('certifyAsset', () => {
  it('refuses a certification with no run behind it', async () => {
    const { certifyAsset } = await loadService([[]]);
    await expect(
      certifyAsset({
        assetId: 1,
        adapter: 'ocpp16',
        conformanceRunId: 999,
        certifiedBy: 'user:1',
      })
    ).rejects.toThrow(/conformance run 999/i);
  });

  it('refuses a certification whose run did not pass', async () => {
    const { certifyAsset } = await loadService([
      [{ id: 5, adapter: 'ocpp16', outcome: 'failed', completedAt: NOW }],
    ]);
    await expect(
      certifyAsset({
        assetId: 1,
        adapter: 'ocpp16',
        conformanceRunId: 5,
        certifiedBy: 'user:1',
      })
    ).rejects.toThrow(/only a passing run can certify/i);
  });

  it('refuses a certification for a different adapter than the run tested', async () => {
    const { certifyAsset } = await loadService([
      [{ id: 6, adapter: 'matter', outcome: 'passed', completedAt: NOW }],
    ]);
    await expect(
      certifyAsset({
        assetId: 1,
        adapter: 'ocpp16',
        conformanceRunId: 6,
        certifiedBy: 'user:1',
      })
    ).rejects.toThrow(/matter/i);
  });
});

describe('controlProtocolProof', () => {
  it('labels a dispatch over an untested protocol as unproven and cites no run', async () => {
    const { controlProtocolProof, clearProofCache } = await loadService([[], []]);
    clearProofCache();
    const proof = await controlProtocolProof('ocpp', NOW);
    expect(proof.state).toBe('claimed_unproven');
    expect(proof.conformanceRunId).toBeNull();
  });

  it('says a protocol with no vector set has none, rather than implying a failure', async () => {
    const { controlProtocolProof, clearProofCache } = await loadService([[], []]);
    clearProofCache();
    const proof = await controlProtocolProof('mqtt', NOW);
    expect(proof.state).toBe('no_suite');
    expect(proof.conformanceRunId).toBeNull();
  });
});

describe('shared proof vocabulary', () => {
  it('treats only `proven` as proof', () => {
    const states = Object.keys(PROTOCOL_PROOF_COPY) as ProtocolProofState[];
    expect(states.filter(isProven)).toEqual(['proven']);
  });

  it('labels every adapter the platform can record', () => {
    for (const adapter of CONFORMANCE_ADAPTERS) {
      expect(CONFORMANCE_ADAPTER_LABELS[adapter]).toBeTruthy();
    }
  });
});
