/**
 * Ask a local model what is wrong, and keep it inside the evidence.
 *
 * The controls, in order of how much they matter:
 *
 *  1. No evidence, no diagnosis. If every probe failed to read its source the run
 *     is `refused` — a model shown nothing will still produce confident prose.
 *  2. No model, no diagnosis. An unreachable Ollama server, or one without the
 *     model pulled, is a refusal carrying the server's own message. There is no
 *     template fallback anywhere in this file.
 *  3. Findings must cite observation ids that were in the evidence. Anything else
 *     is dropped and counted in `rejectedCitations`, and a finding left with no
 *     surviving citation is dropped entirely. This is what makes the output
 *     checkable: every claim points at a row count an operator can re-run.
 *  4. The evidence is stored with the answer, digest included, so a past
 *     diagnosis can be re-read against what it actually saw.
 */

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '../../db';
import { collectEvidence, type EvidenceBundle, type Observation } from './evidence';
import {
  loadOllamaConfig,
  ollamaChat,
  ollamaHealth,
  type OllamaHealth,
} from './ollama';

export type Confidence = 'low' | 'medium' | 'high';

export interface Finding {
  title: string;
  hypothesis: string;
  recommendedAction: string;
  confidence: Confidence;
  observationIds: string[];
}

export interface DiagnosisRefused {
  state: 'refused';
  runId: number | null;
  reason: string;
  health: OllamaHealth;
  evidence: EvidenceBundle;
}

export interface DiagnosisSucceeded {
  state: 'succeeded';
  runId: number | null;
  model: string;
  latencyMs: number;
  answer: string;
  findings: Finding[];
  rejectedCitations: number;
  evidence: EvidenceBundle;
}

export type Diagnosis = DiagnosisRefused | DiagnosisSucceeded;

const SYSTEM_PROMPT = [
  'You are a site reliability assistant for a virtual power plant platform.',
  'You are given OBSERVATIONS: measurements taken from the platform database just now.',
  'Rules you must follow:',
  '- Use only the observations given. Do not assume any number that is not listed.',
  '- Every finding must list the ids of the observations it is based on, in observationIds.',
  '- An observation with "available": false means that source could NOT be read. It is unknown, not healthy. You may report the unreadable source itself as a finding.',
  '- If the observations show no problem, return an empty findings array. Do not invent a problem.',
  '- Recommended actions must be diagnostic or operational steps (what to inspect, which job to check). Never claim you performed anything.',
  'Answer with JSON only: {"summary": string, "findings": [{"title": string, "hypothesis": string, "recommendedAction": string, "confidence": "low"|"medium"|"high", "observationIds": [string]}]}',
].join('\n');

export function evidencePrompt(evidence: EvidenceBundle, question: string): string {
  const lines = evidence.observations.map(observation =>
    [
      `id: ${observation.id}`,
      `area: ${observation.area}`,
      `title: ${observation.title}`,
      `available: ${observation.available}`,
      `source: ${observation.source}`,
      `measures: ${JSON.stringify(observation.measures)}`,
      `detail: ${observation.detail}`,
    ].join('\n')
  );
  return [
    `QUESTION: ${question}`,
    `OBSERVATIONS (collected ${evidence.collectedAt}; ${evidence.availableCount} readable, ${evidence.unavailableCount} unreadable):`,
    lines.join('\n---\n'),
  ].join('\n\n');
}

export function digestEvidence(evidence: EvidenceBundle): string {
  return createHash('sha256')
    .update(JSON.stringify(evidence.observations.map(({ id, measures }) => ({ id, measures }))))
    .digest('hex');
}

function asConfidence(value: unknown): Confidence {
  // An unrecognised confidence becomes 'low' rather than being upgraded.
  return value === 'high' || value === 'medium' ? value : 'low';
}

function asString(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

/**
 * Parse the model's JSON and keep only what the evidence supports.
 *
 * Returns the surviving findings and how many citations were invented — that
 * count is stored and shown, because a model that keeps citing observations it was
 * never given is a signal about the model, not a detail to swallow.
 */
export function validateFindings(
  raw: string,
  observations: Observation[]
): { summary: string; findings: Finding[]; rejectedCitations: number; parseError: string | null } {
  const known = new Set(observations.map(observation => observation.id));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      summary: '',
      findings: [],
      rejectedCitations: 0,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
  // An array parses as an object but carries neither summary nor findings; taken
  // as one it would become a successful run with an empty answer.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { summary: '', findings: [], rejectedCitations: 0, parseError: 'not a JSON object' };
  }

  const body = parsed as { summary?: unknown; findings?: unknown };
  const summary = asString(body.summary, 2000);
  const candidates = Array.isArray(body.findings) ? body.findings : [];

  let rejectedCitations = 0;
  const findings: Finding[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const entry = candidate as {
      title?: unknown;
      hypothesis?: unknown;
      recommendedAction?: unknown;
      confidence?: unknown;
      observationIds?: unknown;
    };

    const cited = Array.isArray(entry.observationIds)
      ? entry.observationIds.map(value => String(value))
      : [];
    const supported = cited.filter(id => known.has(id));
    rejectedCitations += cited.length - supported.length;
    if (supported.length === 0) continue;

    const title = asString(entry.title, 300);
    const hypothesis = asString(entry.hypothesis, 4000);
    const recommendedAction = asString(entry.recommendedAction, 4000);
    if (!title || !hypothesis || !recommendedAction) continue;

    findings.push({
      title,
      hypothesis,
      recommendedAction,
      confidence: asConfidence(entry.confidence),
      observationIds: supported,
    });
  }

  return { summary, findings, rejectedCitations, parseError: null };
}

async function recordRefusal(
  question: string,
  evidence: EvidenceBundle,
  requestedBy: number,
  reason: string,
  endpoint: string | null
): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  try {
    const inserted = await db.execute<{ id: number }>(sql`
      INSERT INTO diagnostic_runs
        (state, question, endpoint, requested_by, finished_at, evidence, evidence_digest, refusal_reason)
      VALUES ('refused', ${question}, ${endpoint}, ${requestedBy}, now(),
              ${JSON.stringify(evidence)}::jsonb, ${digestEvidence(evidence)}, ${reason.slice(0, 600)})
      RETURNING id
    `);
    return inserted.rows[0] ? Number(inserted.rows[0].id) : null;
  } catch {
    // The refusal is still returned to the caller; losing the audit row must not
    // turn into a thrown error that reads like the model failed.
    return null;
  }
}

async function recordSuccess(
  question: string,
  evidence: EvidenceBundle,
  requestedBy: number,
  params: {
    model: string;
    endpoint: string;
    latencyMs: number;
    answer: string;
    rejectedCitations: number;
    findings: Finding[];
  }
): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  // Run and findings go in together: a stored answer whose findings failed to
  // write would read as a diagnosis that found nothing.
  return db.transaction(async tx => {
    const inserted = await tx.execute<{ id: number }>(sql`
      INSERT INTO diagnostic_runs
        (state, question, model, endpoint, requested_by, finished_at, latency_ms,
         evidence, evidence_digest, answer, rejected_citations)
      VALUES ('succeeded', ${question}, ${params.model}, ${params.endpoint}, ${requestedBy}, now(),
              ${params.latencyMs}, ${JSON.stringify(evidence)}::jsonb, ${digestEvidence(evidence)},
              ${params.answer}, ${params.rejectedCitations})
      RETURNING id
    `);
    const runId = inserted.rows[0] ? Number(inserted.rows[0].id) : null;
    if (runId === null) return null;

    for (const finding of params.findings) {
      await tx.execute(sql`
        INSERT INTO diagnostic_findings
          (run_id, title, hypothesis, recommended_action, confidence, observation_ids)
        VALUES (${runId}, ${finding.title}, ${finding.hypothesis}, ${finding.recommendedAction},
                ${finding.confidence}, ${sql.param(finding.observationIds)}::text[])
      `);
    }
    return runId;
  });
}

export async function diagnose(params: {
  question: string;
  requestedBy: number;
}): Promise<Diagnosis> {
  const question = params.question.trim().slice(0, 2000);
  const evidence = await collectEvidence();
  const config = loadOllamaConfig();
  const health = await ollamaHealth(config);

  if (!config || !health.reachable || !health.modelPresent) {
    const reason = health.detail;
    return {
      state: 'refused',
      runId: await recordRefusal(
        question,
        evidence,
        params.requestedBy,
        reason,
        config?.baseUrl ?? null
      ),
      reason,
      health,
      evidence,
    };
  }

  if (evidence.availableCount === 0) {
    const reason =
      'No observation could be read, so there is nothing to diagnose from. The model was not asked.';
    return {
      state: 'refused',
      runId: await recordRefusal(question, evidence, params.requestedBy, reason, config.baseUrl),
      reason,
      health,
      evidence,
    };
  }

  const chat = await ollamaChat(
    config,
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: evidencePrompt(evidence, question) },
    ],
    { json: true }
  );

  if (!chat.ok) {
    const reason = `${chat.failure.kind}: ${chat.failure.detail}`;
    return {
      state: 'refused',
      runId: await recordRefusal(question, evidence, params.requestedBy, reason, config.baseUrl),
      reason,
      health,
      evidence,
    };
  }

  const validated = validateFindings(chat.value.content, evidence.observations);
  if (validated.parseError !== null) {
    const reason = `${config.model} did not return usable JSON (${validated.parseError}); nothing is reported rather than guessing at its meaning.`;
    return {
      state: 'refused',
      runId: await recordRefusal(question, evidence, params.requestedBy, reason, config.baseUrl),
      reason,
      health,
      evidence,
    };
  }

  const answer = validated.summary || chat.value.content.slice(0, 4000);
  const runId = await recordSuccess(question, evidence, params.requestedBy, {
    model: chat.value.model,
    endpoint: config.baseUrl,
    latencyMs: chat.value.latencyMs,
    answer,
    rejectedCitations: validated.rejectedCitations,
    findings: validated.findings,
  });

  return {
    state: 'succeeded',
    runId,
    model: chat.value.model,
    latencyMs: chat.value.latencyMs,
    answer,
    findings: validated.findings,
    rejectedCitations: validated.rejectedCitations,
    evidence,
  };
}

export interface DiagnosticRunSummary {
  id: number;
  state: string;
  question: string;
  model: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  latencyMs: number | null;
  answer: string | null;
  refusalReason: string | null;
  rejectedCitations: number;
  findings: Finding[];
}

function asDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export async function recentDiagnoses(limit = 20): Promise<DiagnosticRunSummary[]> {
  const db = await getDb();
  if (!db) throw new Error('No database connection, so past diagnoses cannot be read.');
  const runs = await db.execute<Record<string, unknown>>(sql`
    SELECT id, state, question, model, started_at, finished_at, latency_ms,
           answer, refusal_reason, rejected_citations
      FROM diagnostic_runs
     ORDER BY id DESC
     LIMIT ${limit}
  `);
  if (runs.rows.length === 0) return [];

  const ids = runs.rows.map(row => Number(row.id));
  const findings = await db.execute<Record<string, unknown>>(sql`
    SELECT run_id, title, hypothesis, recommended_action, confidence, observation_ids
      FROM diagnostic_findings
     WHERE run_id = ANY(${sql.param(ids)}::int[])
     ORDER BY id
  `);
  const byRun = new Map<number, Finding[]>();
  for (const row of findings.rows) {
    const runId = Number(row.run_id);
    const list = byRun.get(runId) ?? [];
    list.push({
      title: String(row.title),
      hypothesis: String(row.hypothesis),
      recommendedAction: String(row.recommended_action),
      confidence: asConfidence(row.confidence),
      observationIds: Array.isArray(row.observation_ids)
        ? row.observation_ids.map(value => String(value))
        : [],
    });
    byRun.set(runId, list);
  }

  return runs.rows.map(row => ({
    id: Number(row.id),
    state: String(row.state),
    question: String(row.question),
    model: row.model === null || row.model === undefined ? null : String(row.model),
    startedAt: asDate(row.started_at),
    finishedAt: asDate(row.finished_at),
    latencyMs: row.latency_ms === null || row.latency_ms === undefined ? null : Number(row.latency_ms),
    answer: row.answer === null || row.answer === undefined ? null : String(row.answer),
    refusalReason:
      row.refusal_reason === null || row.refusal_reason === undefined
        ? null
        : String(row.refusal_reason),
    rejectedCitations: Number(row.rejected_citations ?? 0),
    findings: byRun.get(Number(row.id)) ?? [],
  }));
}
