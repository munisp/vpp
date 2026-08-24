/**
 * Protocol conformance evidence: proving the wire, not asserting it.
 *
 * `der_capabilities.protocols` holds strings a human typed. This service is what
 * turns one of those strings into a claim with something behind it: an executed
 * vector set, every case's outcome, the peer it ran against, the operator who
 * ran it and the checksum of the artifact. Runs arrive from the protocol
 * services themselves (`services/grid-protocols` for OCPP/OpenADR/2030.5/Matter,
 * `services/modbus-poller` for Modbus/SunSpec) over the signed ingest route, so
 * the evidence is produced by the same code that talks to devices.
 *
 * The rules this service enforces:
 *  - a run whose counts disagree with its cases is refused, not stored;
 *  - a protocol is `proven` only while a passing run exists inside the evidence
 *    window — never tested, failed, partially skipped and gone stale are all
 *    distinct, and none of them is proof;
 *  - a certification cannot be created without a passing run for that adapter;
 *  - every control the platform issues is labelled with the proof state of the
 *    protocol that carried it, at the moment it was issued.
 */

import { createHash } from 'node:crypto';

import { desc, eq, sql } from 'drizzle-orm';

import { getDb } from '../db';
import {
  conformanceCases,
  conformanceRuns,
  derProtocolCertifications,
  type ConformanceCase,
  type ConformanceRun,
} from '../../drizzle/conformance-schema';
import {
  CONFORMANCE_ADAPTERS,
  type ConformanceAdapter,
  type ProtocolProofState,
} from '../../shared/protocol-conformance-copy';
import type { SqlRow } from '../sql-row';

export type { ConformanceAdapter, ProtocolProofState };
export type ConformanceTarget = 'simulator' | 'device';
export type ConformanceRunOutcome = 'passed' | 'failed' | 'refused';
export type ConformanceCaseOutcome = 'pass' | 'fail' | 'skipped';

export class ConformanceError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ConformanceError';
    this.status = status;
  }
}

/**
 * How long a passing run keeps proving anything. A run proves the adapter and
 * the peer as they were on the day it ran; firmware and our own code move, so
 * evidence expires rather than standing forever. Overridable per deployment
 * because a fleet under change control may legitimately want it shorter.
 */
export const DEFAULT_PROOF_VALIDITY_DAYS = 365;

export function proofValidityDays(): number {
  const raw = process.env.CONFORMANCE_PROOF_VALIDITY_DAYS;
  if (raw === undefined || raw === '') return DEFAULT_PROOF_VALIDITY_DAYS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) {
    throw new ConformanceError(
      'CONFORMANCE_PROOF_VALIDITY_DAYS must be a number of days of at least 1',
      500
    );
  }
  return Math.floor(value);
}

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new ConformanceError(
      'no database is configured; conformance evidence cannot be recorded or read',
      503
    );
  }
  return db;
}

/* --------------------------------------------------------------- recording */

export interface ConformanceCaseInput {
  caseId: string;
  name: string;
  requirement: string;
  outcome: ConformanceCaseOutcome;
  detail?: string;
  evidence?: unknown;
}

export interface RecordRunInput {
  adapter: ConformanceAdapter;
  adapterVersion: string;
  protocolVersion: string;
  deviceModel: string;
  deviceIdentifier?: string;
  target: ConformanceTarget;
  vectorSetId: string;
  vectorSetVersion: string;
  operator: string;
  startedAt: Date;
  completedAt: Date;
  /** Present unless the run was refused before it could produce one. */
  artifactChecksum?: string;
  artifactUri?: string;
  detail?: string;
  cases: ConformanceCaseInput[];
  /**
   * Set by a runner that could not complete: the peer was unreachable, the
   * vector set would not load. A refused run is stored and proves nothing.
   */
  refused?: { reason: string };
}

export interface RecordedRun {
  runId: number;
  outcome: ConformanceRunOutcome;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  skippedCases: number;
  artifactChecksum: string;
}

/**
 * Canonical artifact digest, computed here rather than trusted from the runner.
 * A checksum the caller supplies is compared against this one and a mismatch is
 * refused: a checksum nobody can recompute is decoration.
 */
export function artifactChecksum(input: RecordRunInput): string {
  const canonical = JSON.stringify({
    adapter: input.adapter,
    adapterVersion: input.adapterVersion,
    protocolVersion: input.protocolVersion,
    deviceModel: input.deviceModel,
    deviceIdentifier: input.deviceIdentifier ?? null,
    target: input.target,
    vectorSetId: input.vectorSetId,
    vectorSetVersion: input.vectorSetVersion,
    cases: [...input.cases]
      .sort((a, b) => (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0))
      .map(one => ({
        caseId: one.caseId,
        outcome: one.outcome,
        requirement: one.requirement,
      })),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export async function recordRun(input: RecordRunInput): Promise<RecordedRun> {
  const db = await requireDb();

  if (input.completedAt.getTime() < input.startedAt.getTime()) {
    throw new ConformanceError('a run cannot complete before it started');
  }

  const caseIds = new Set<string>();
  for (const one of input.cases) {
    if (caseIds.has(one.caseId)) {
      throw new ConformanceError(`duplicate case id in the run: ${one.caseId}`);
    }
    caseIds.add(one.caseId);
  }

  const passedCases = input.cases.filter(one => one.outcome === 'pass').length;
  const failedCases = input.cases.filter(one => one.outcome === 'fail').length;
  const skippedCases = input.cases.filter(one => one.outcome === 'skipped').length;
  const totalCases = input.cases.length;

  // A refused run overrides the case tally: whatever cases ran, the runner is
  // saying it cannot vouch for the result.
  let outcome: ConformanceRunOutcome;
  if (input.refused) {
    outcome = 'refused';
  } else if (totalCases === 0) {
    // An empty suite is not a pass. It is a runner that tested nothing.
    throw new ConformanceError(
      'a completed run must carry at least one case; an empty vector set proves nothing'
    );
  } else if (failedCases === 0 && skippedCases === 0) {
    outcome = 'passed';
  } else {
    outcome = 'failed';
  }

  const computed = artifactChecksum(input);
  if (input.artifactChecksum && input.artifactChecksum.toLowerCase() !== computed) {
    throw new ConformanceError(
      'the artifact checksum does not match the run as submitted; the evidence and its digest disagree'
    );
  }

  const detail = input.refused
    ? `refused: ${input.refused.reason}${input.detail ? ` — ${input.detail}` : ''}`
    : input.detail;

  return db.transaction(async tx => {
    const [run] = await tx
      .insert(conformanceRuns)
      .values({
        adapter: input.adapter,
        adapterVersion: input.adapterVersion,
        protocolVersion: input.protocolVersion,
        deviceModel: input.deviceModel,
        deviceIdentifier: input.deviceIdentifier,
        target: input.target,
        vectorSetId: input.vectorSetId,
        vectorSetVersion: input.vectorSetVersion,
        totalCases,
        passedCases,
        failedCases,
        skippedCases,
        outcome,
        operator: input.operator,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
        artifactChecksum: computed,
        artifactUri: input.artifactUri,
        detail: detail?.slice(0, 4000),
      })
      .returning({ id: conformanceRuns.id });

    if (!run) {
      throw new ConformanceError('the conformance run could not be stored', 500);
    }

    if (totalCases > 0) {
      await tx.insert(conformanceCases).values(
        input.cases.map(one => ({
          runId: run.id,
          caseId: one.caseId,
          name: one.name,
          requirement: one.requirement,
          outcome: one.outcome,
          detail: one.detail?.slice(0, 4000),
          evidence: one.evidence === undefined ? null : one.evidence,
        }))
      );
    }

    return {
      runId: run.id,
      outcome,
      totalCases,
      passedCases,
      failedCases,
      skippedCases,
      artifactChecksum: computed,
    };
  });
}

/* ------------------------------------------------------------------- proofs */

export interface ProtocolProof {
  adapter: ConformanceAdapter;
  state: ProtocolProofState;
  /** The run the state is based on, when there is one. */
  run: {
    id: number;
    outcome: ConformanceRunOutcome;
    target: ConformanceTarget;
    deviceModel: string;
    protocolVersion: string;
    completedAt: Date;
    passedCases: number;
    totalCases: number;
    artifactChecksum: string;
  } | null;
}

/** Just the columns proof state is derived from. */
interface ProofRun {
  id: number;
  adapter: string;
  outcome: string;
  target: string;
  deviceModel: string;
  protocolVersion: string;
  completedAt: Date;
  passedCases: number;
  totalCases: number;
  artifactChecksum: string;
}

function proofFromRuns(
  adapter: ConformanceAdapter,
  latestPassed: ProofRun | undefined,
  latestAny: ProofRun | undefined,
  now: Date,
  validityDays: number
): ProtocolProof {
  const summarise = (run: ProofRun) => ({
    id: run.id,
    outcome: run.outcome as ConformanceRunOutcome,
    target: run.target as ConformanceTarget,
    deviceModel: run.deviceModel,
    protocolVersion: run.protocolVersion,
    completedAt: run.completedAt,
    passedCases: run.passedCases,
    totalCases: run.totalCases,
    artifactChecksum: run.artifactChecksum,
  });

  // The most recent attempt decides, so a regression cannot hide behind an older
  // pass: an adapter that passed in March and failed last night is not proven.
  if (latestAny && latestAny.outcome === 'failed') {
    return { adapter, state: 'suite_failed', run: summarise(latestAny) };
  }

  if (latestPassed) {
    const ageDays = (now.getTime() - latestPassed.completedAt.getTime()) / 86_400_000;
    if (ageDays <= validityDays) {
      return { adapter, state: 'proven', run: summarise(latestPassed) };
    }
    return { adapter, state: 'proof_stale', run: summarise(latestPassed) };
  }

  return {
    adapter,
    state: 'claimed_unproven',
    run: latestAny ? summarise(latestAny) : null,
  };
}

/**
 * The newest run per adapter, one row each. `DISTINCT ON` does the reduction in
 * PostgreSQL so history length does not cost the caller anything.
 */
async function latestRunPerAdapter(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  passedOnly: boolean
): Promise<Map<string, ProofRun>> {
  const rows = await db.execute<SqlRow>(sql`
    SELECT DISTINCT ON (adapter)
           id, adapter, outcome, target,
           device_model AS "deviceModel", protocol_version AS "protocolVersion",
           completed_at AS "completedAt", passed_cases AS "passedCases",
           total_cases AS "totalCases", artifact_checksum AS "artifactChecksum"
    FROM conformance_runs
    WHERE completed_at IS NOT NULL
      ${passedOnly ? sql`AND outcome = 'passed'` : sql``}
    ORDER BY adapter, completed_at DESC, id DESC
  `);

  const latest = new Map<string, ProofRun>();
  for (const row of rows.rows ?? []) {
    latest.set(String(row.adapter), {
      id: Number(row.id),
      adapter: String(row.adapter),
      outcome: String(row.outcome),
      target: String(row.target),
      deviceModel: String(row.deviceModel),
      protocolVersion: String(row.protocolVersion),
      completedAt: new Date(String(row.completedAt)),
      passedCases: Number(row.passedCases),
      totalCases: Number(row.totalCases),
      artifactChecksum: String(row.artifactChecksum),
    });
  }
  return latest;
}

/**
 * Proof state for every adapter the platform has a vector set for. Two queries,
 * each returning at most one row per adapter, so the cost does not grow with run
 * history and this stays cheap enough to call on a dispatch path.
 */
export async function adapterProofs(now: Date = new Date()): Promise<ProtocolProof[]> {
  const db = await requireDb();
  const validityDays = proofValidityDays();

  const firstPassed = await latestRunPerAdapter(db, true);
  const firstAny = await latestRunPerAdapter(db, false);

  return CONFORMANCE_ADAPTERS.map(adapter =>
    proofFromRuns(adapter, firstPassed.get(adapter), firstAny.get(adapter), now, validityDays)
  );
}

export async function adapterProof(
  adapter: ConformanceAdapter,
  now: Date = new Date()
): Promise<ProtocolProof> {
  const all = await adapterProofs(now);
  const found = all.find(one => one.adapter === adapter);
  if (!found) {
    throw new ConformanceError(`unknown conformance adapter: ${adapter}`);
  }
  return found;
}

/**
 * Maps the free text in `der_capabilities.protocols` — and the control
 * protocols in `control_assignments` — onto the adapters that can be proven.
 * Unrecognised strings return null and are reported as having no vector set
 * rather than being quietly dropped, because an asset claiming "IEC 61850" is
 * making a claim the platform cannot check.
 */
export function adapterForProtocolLabel(label: string): ConformanceAdapter | null {
  const key = label.trim().toLowerCase().replace(/[\s_-]/g, '');
  switch (key) {
    case 'ocpp':
    case 'ocpp16':
    case 'ocpp16j':
    case 'ocpp1.6':
    case 'ocpp1.6j':
      return 'ocpp16';
    case 'ocpp201':
    case 'ocpp2.0.1':
    case 'ocpp2':
    case 'ocpp20':
      return 'ocpp201';
    case 'openadr':
    case 'openadr2b':
    case 'openadr2.0b':
      return 'openadr2b';
    case 'sep2':
    case 'ieee2030.5':
    case 'ieee20305':
    case '2030.5':
      return 'ieee2030_5';
    case 'modbus':
    case 'modbustcp':
    case 'sunspec':
    case 'modbussunspec':
      return 'modbus_sunspec';
    case 'matter':
      return 'matter';
    default:
      return null;
  }
}

export interface ClaimedProtocolStatus {
  /** As written on the asset. */
  claimed: string;
  adapter: ConformanceAdapter | null;
  state: ProtocolProofState;
  proof: ProtocolProof | null;
}

export interface AssetProtocolEvidence {
  assetId: number;
  protocols: ClaimedProtocolStatus[];
  certifications: AssetCertification[];
  /** True only when every claimed protocol has a live passing run behind it. */
  allClaimsProven: boolean;
}

export interface AssetCertification {
  id: number;
  adapter: ConformanceAdapter;
  conformanceRunId: number;
  certifiedBy: string;
  certifiedAt: Date;
  expiresAt: Date | null;
  note: string | null;
  /** The evidence the certification rests on, resolved for the reader. */
  runOutcome: ConformanceRunOutcome;
  runTarget: ConformanceTarget;
  runDeviceModel: string;
  runCompletedAt: Date;
  runArtifactChecksum: string;
  /** False once the run's proof window has closed or the row itself expired. */
  currentlyValid: boolean;
}

/**
 * Resolves an asset's claimed protocols and certifications against the evidence.
 * This is what capability surfaces read: `der_capabilities.protocols` on its own
 * is a wish list.
 */
export async function assetProtocolEvidence(
  assetId: number,
  now: Date = new Date()
): Promise<AssetProtocolEvidence> {
  const db = await requireDb();

  const capabilityRows = await db.execute<SqlRow>(sql`
    SELECT protocols FROM der_capabilities WHERE asset_id = ${assetId}
  `);
  const raw = capabilityRows.rows?.[0]?.protocols;
  let claimed: string[] = [];
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        claimed = parsed.filter((one): one is string => typeof one === 'string');
      }
    } catch {
      // A capability row whose protocol list will not parse is not evidence of
      // anything; it is reported as no claims rather than guessed at.
      claimed = [];
    }
  }

  const proofs = await adapterProofs(now);
  const byAdapter = new Map<ConformanceAdapter, ProtocolProof>(
    proofs.map(one => [one.adapter, one])
  );

  const protocols: ClaimedProtocolStatus[] = claimed.map(label => {
    const adapter = adapterForProtocolLabel(label);
    if (!adapter) {
      return { claimed: label, adapter: null, state: 'no_suite', proof: null };
    }
    const proof = byAdapter.get(adapter) ?? null;
    return {
      claimed: label,
      adapter,
      state: proof ? proof.state : 'claimed_unproven',
      proof,
    };
  });

  const certifications = await listCertifications(assetId, now);

  return {
    assetId,
    protocols,
    certifications,
    allClaimsProven:
      protocols.length > 0 && protocols.every(one => one.state === 'proven'),
  };
}

/* ---------------------------------------------------------- certifications */

export interface CertifyInput {
  assetId: number;
  adapter: ConformanceAdapter;
  conformanceRunId: number;
  certifiedBy: string;
  expiresAt?: Date;
  note?: string;
}

/**
 * Records a certification against a passing run. Every refusal here is a
 * certification somebody wanted to assert without evidence.
 */
export async function certifyAsset(input: CertifyInput): Promise<{ id: number }> {
  const db = await requireDb();

  const [run] = await db
    .select()
    .from(conformanceRuns)
    .where(eq(conformanceRuns.id, input.conformanceRunId))
    .limit(1);

  if (!run) {
    throw new ConformanceError(
      `conformance run ${input.conformanceRunId} does not exist; a certification needs a run behind it`,
      404
    );
  }
  if (run.outcome !== 'passed') {
    throw new ConformanceError(
      `conformance run ${run.id} finished ${run.outcome}; only a passing run can certify an asset`
    );
  }
  if (run.adapter !== input.adapter) {
    throw new ConformanceError(
      `conformance run ${run.id} exercised ${run.adapter}, not ${input.adapter}; a run cannot certify a protocol it never spoke`
    );
  }

  const [inserted] = await db
    .insert(derProtocolCertifications)
    .values({
      assetId: input.assetId,
      adapter: input.adapter,
      conformanceRunId: input.conformanceRunId,
      certifiedBy: input.certifiedBy,
      expiresAt: input.expiresAt,
      note: input.note?.slice(0, 2000),
    })
    .returning({ id: derProtocolCertifications.id });

  if (!inserted) {
    throw new ConformanceError('the certification could not be stored', 500);
  }
  return { id: inserted.id };
}

export async function listCertifications(
  assetId: number,
  now: Date = new Date()
): Promise<AssetCertification[]> {
  const db = await requireDb();
  const validityDays = proofValidityDays();

  const rows = await db
    .select({
      id: derProtocolCertifications.id,
      adapter: derProtocolCertifications.adapter,
      conformanceRunId: derProtocolCertifications.conformanceRunId,
      certifiedBy: derProtocolCertifications.certifiedBy,
      certifiedAt: derProtocolCertifications.certifiedAt,
      expiresAt: derProtocolCertifications.expiresAt,
      note: derProtocolCertifications.note,
      runOutcome: conformanceRuns.outcome,
      runTarget: conformanceRuns.target,
      runDeviceModel: conformanceRuns.deviceModel,
      runCompletedAt: conformanceRuns.completedAt,
      runArtifactChecksum: conformanceRuns.artifactChecksum,
    })
    .from(derProtocolCertifications)
    .innerJoin(conformanceRuns, eq(conformanceRuns.id, derProtocolCertifications.conformanceRunId))
    .where(eq(derProtocolCertifications.assetId, assetId))
    .orderBy(desc(derProtocolCertifications.certifiedAt));

  return rows.map(row => {
    const ageDays = (now.getTime() - row.runCompletedAt.getTime()) / 86_400_000;
    const expired = row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime();
    return {
      id: row.id,
      adapter: row.adapter as ConformanceAdapter,
      conformanceRunId: row.conformanceRunId,
      certifiedBy: row.certifiedBy,
      certifiedAt: row.certifiedAt,
      expiresAt: row.expiresAt,
      note: row.note,
      runOutcome: row.runOutcome as ConformanceRunOutcome,
      runTarget: row.runTarget as ConformanceTarget,
      runDeviceModel: row.runDeviceModel,
      runCompletedAt: row.runCompletedAt,
      runArtifactChecksum: row.runArtifactChecksum,
      currentlyValid: !expired && ageDays <= validityDays && row.runOutcome === 'passed',
    };
  });
}

/* -------------------------------------------------------------- run reading */

export interface ConformanceRunSummary {
  id: number;
  adapter: ConformanceAdapter;
  adapterVersion: string;
  protocolVersion: string;
  deviceModel: string;
  deviceIdentifier: string | null;
  target: ConformanceTarget;
  vectorSetId: string;
  vectorSetVersion: string;
  outcome: ConformanceRunOutcome;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  skippedCases: number;
  operator: string;
  startedAt: Date;
  completedAt: Date;
  artifactChecksum: string;
  artifactUri: string | null;
  detail: string | null;
}

function summariseRun(run: ConformanceRun): ConformanceRunSummary {
  return {
    id: run.id,
    adapter: run.adapter as ConformanceAdapter,
    adapterVersion: run.adapterVersion,
    protocolVersion: run.protocolVersion,
    deviceModel: run.deviceModel,
    deviceIdentifier: run.deviceIdentifier,
    target: run.target as ConformanceTarget,
    vectorSetId: run.vectorSetId,
    vectorSetVersion: run.vectorSetVersion,
    outcome: run.outcome as ConformanceRunOutcome,
    totalCases: run.totalCases,
    passedCases: run.passedCases,
    failedCases: run.failedCases,
    skippedCases: run.skippedCases,
    operator: run.operator,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    artifactChecksum: run.artifactChecksum,
    artifactUri: run.artifactUri,
    detail: run.detail,
  };
}

export async function listRuns(
  filter: { adapter?: ConformanceAdapter; limit?: number } = {}
): Promise<ConformanceRunSummary[]> {
  const db = await requireDb();
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const rows = filter.adapter
    ? await db
        .select()
        .from(conformanceRuns)
        .where(eq(conformanceRuns.adapter, filter.adapter))
        .orderBy(desc(conformanceRuns.completedAt))
        .limit(limit)
    : await db
        .select()
        .from(conformanceRuns)
        .orderBy(desc(conformanceRuns.completedAt))
        .limit(limit);
  return rows.map(summariseRun);
}

export interface ConformanceRunDetail extends ConformanceRunSummary {
  cases: Array<{
    caseId: string;
    name: string;
    requirement: string;
    outcome: ConformanceCaseOutcome;
    detail: string | null;
    evidence: unknown;
  }>;
}

export async function getRun(runId: number): Promise<ConformanceRunDetail | null> {
  const db = await requireDb();
  const [run] = await db
    .select()
    .from(conformanceRuns)
    .where(eq(conformanceRuns.id, runId))
    .limit(1);
  if (!run) return null;

  const cases: ConformanceCase[] = await db
    .select()
    .from(conformanceCases)
    .where(eq(conformanceCases.runId, runId))
    .orderBy(conformanceCases.caseId);

  return {
    ...summariseRun(run),
    cases: cases.map(one => ({
      caseId: one.caseId,
      name: one.name,
      requirement: one.requirement,
      outcome: one.outcome as ConformanceCaseOutcome,
      detail: one.detail,
      evidence: one.evidence,
    })),
  };
}

/* ------------------------------------------------------- dispatch labelling */

/**
 * Proof state for a control protocol, for stamping on a control record. MQTT has
 * no vector set in this platform, so it resolves to `no_suite`: honest about the
 * absence rather than implying a device failed a test that was never written.
 *
 * Cached briefly because dispatch is a hot path and conformance runs change on
 * the order of weeks; the cache is short enough that a fresh run takes effect
 * within a minute.
 */
const PROOF_CACHE_TTL_MS = 30_000;
let proofCache: { at: number; proofs: Map<ConformanceAdapter, ProtocolProof> } | null = null;

export function clearProofCache(): void {
  proofCache = null;
}

export interface ControlProtocolProof {
  state: ProtocolProofState;
  conformanceRunId: number | null;
}

export async function controlProtocolProof(
  protocol: string,
  now: Date = new Date()
): Promise<ControlProtocolProof> {
  const adapter = adapterForProtocolLabel(protocol);
  if (!adapter) {
    return { state: 'no_suite', conformanceRunId: null };
  }

  if (!proofCache || now.getTime() - proofCache.at > PROOF_CACHE_TTL_MS) {
    const proofs = await adapterProofs(now);
    proofCache = {
      at: now.getTime(),
      proofs: new Map(proofs.map(one => [one.adapter, one])),
    };
  }

  const proof = proofCache.proofs.get(adapter);
  if (!proof) return { state: 'claimed_unproven', conformanceRunId: null };
  return {
    state: proof.state,
    conformanceRunId: proof.state === 'proven' ? (proof.run?.id ?? null) : null,
  };
}

/**
 * Fleet-wide view for the operator surface: what each adapter's evidence is, and
 * how many assets are leaning on it.
 */
export interface AdapterCoverage extends ProtocolProof {
  label: ConformanceAdapter;
  /** Assets whose capability row claims a protocol mapping to this adapter. */
  claimingAssets: number;
  certifiedAssets: number;
}

export async function adapterCoverage(now: Date = new Date()): Promise<AdapterCoverage[]> {
  const db = await requireDb();
  const proofs = await adapterProofs(now);

  const capabilityRows = await db.execute<SqlRow>(sql`
    SELECT asset_id, protocols FROM der_capabilities WHERE protocols IS NOT NULL
  `);
  const claiming = new Map<ConformanceAdapter, Set<number>>();
  for (const row of capabilityRows.rows ?? []) {
    const assetId = Number(row.asset_id);
    if (!Number.isFinite(assetId)) continue;
    let labels: unknown;
    try {
      labels = JSON.parse(String(row.protocols));
    } catch {
      continue;
    }
    if (!Array.isArray(labels)) continue;
    for (const label of labels) {
      if (typeof label !== 'string') continue;
      const adapter = adapterForProtocolLabel(label);
      if (!adapter) continue;
      const set = claiming.get(adapter) ?? new Set<number>();
      set.add(assetId);
      claiming.set(adapter, set);
    }
  }

  const certifiedRows = await db
    .select({
      adapter: derProtocolCertifications.adapter,
      assets: sql<number>`count(distinct ${derProtocolCertifications.assetId})`,
    })
    .from(derProtocolCertifications)
    .groupBy(derProtocolCertifications.adapter);
  const certified = new Map<string, number>(
    certifiedRows.map(row => [row.adapter, Number(row.assets)])
  );

  return proofs.map(proof => ({
    ...proof,
    label: proof.adapter,
    claimingAssets: claiming.get(proof.adapter)?.size ?? 0,
    certifiedAssets: certified.get(proof.adapter) ?? 0,
  }));
}

/**
 * Controls issued over a protocol with no live proof. This is the audit question
 * after an incident: what did we command on a wire nobody had tested?
 */
export async function unprovenDispatches(
  limit = 50
): Promise<
  Array<{
    id: number;
    protocol: string;
    targetRef: string;
    assetId: number | null;
    setpointWatts: number | null;
    validFrom: Date;
    validTo: Date;
    delivery: string;
    protocolProof: string;
    createdAt: Date;
  }>
> {
  const db = await requireDb();
  const capped = Math.min(Math.max(limit, 1), 200);
  const rows = await db.execute<SqlRow>(sql`
    SELECT id, protocol, target_ref, asset_id, setpoint_watts, valid_from, valid_to,
           delivery, protocol_proof, created_at
    FROM control_assignments
    WHERE protocol_proof IS NOT NULL AND protocol_proof <> 'proven'
    ORDER BY created_at DESC
    LIMIT ${capped}
  `);
  return (rows.rows ?? []).map(row => ({
    id: Number(row.id),
    protocol: String(row.protocol),
    targetRef: String(row.target_ref),
    assetId: row.asset_id === null ? null : Number(row.asset_id),
    setpointWatts: row.setpoint_watts === null ? null : Number(row.setpoint_watts),
    validFrom: new Date(String(row.valid_from)),
    validTo: new Date(String(row.valid_to)),
    delivery: String(row.delivery),
    protocolProof: String(row.protocol_proof),
    createdAt: new Date(String(row.created_at)),
  }));
}

export const conformanceAdapterList = CONFORMANCE_ADAPTERS;
