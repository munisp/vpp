/**
 * Protocol conformance evidence.
 *
 * `der_capabilities.protocols` is a list of strings somebody typed. It says a
 * battery "speaks IEEE 2030.5"; it is not evidence that this platform's adapter
 * and that device ever agreed on a single frame. Dispatching money-bearing or
 * grid-bearing instructions over an unverified protocol claim is the same class
 * of defect as a settlement with no ledger movement behind it: the surface reads
 * available, and nothing proved it.
 *
 * A run here is an executed test-vector set: every case, its outcome, who ran
 * it, against what (a simulator or a named device), and the checksum of the
 * artifact the runner produced. A protocol is only `proven` while a run exists
 * whose every case passed. Anything else — no run, a failed run, a run whose
 * cases were skipped — reads `claimed_unproven`, and a dispatch that leaves the
 * platform over such a protocol is labelled as such on the control record, so a
 * later audit of an incident can tell whether the wire was ever tested.
 *
 * Certifications are not free text either: a row in `der_protocol_certifications`
 * must point at a passing run, so "certified" cannot be asserted by typing it.
 */

import {
  check,
  index,
  integer as int,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * The adapters this platform can prove. One value per wire protocol
 * implementation, not per device: the thing under test is our adapter plus the
 * peer's behaviour.
 */
export const conformanceAdapterEnum = pgEnum('conformance_adapter', [
  'ocpp16',
  'ocpp201',
  'openadr2b',
  'ieee2030_5',
  'modbus_sunspec',
  'matter',
]);

export const conformanceAdapters = [
  'ocpp16',
  'ocpp201',
  'openadr2b',
  'ieee2030_5',
  'modbus_sunspec',
  'matter',
] as const;

/**
 * What the run talked to. A simulator proves the adapter is correct against the
 * specification's own vectors; only `device` proves a particular product
 * interoperates. Both are real evidence and they are never conflated.
 */
export const conformanceTargetEnum = pgEnum('conformance_target', ['simulator', 'device']);

/**
 * `refused` is a run the runner would not stand behind: the peer was
 * unreachable, the vector set could not be loaded, the artifact could not be
 * checksummed. It is recorded so an operator sees the attempt, and it never
 * proves anything.
 */
export const conformanceRunOutcomeEnum = pgEnum('conformance_run_outcome', [
  'passed',
  'failed',
  'refused',
]);

/**
 * `skipped` is deliberately not a pass. A vector set with a skipped case cannot
 * produce a `passed` run (see the check constraint below), because "we did not
 * test that" must never be summarised as "conformant".
 */
export const conformanceCaseOutcomeEnum = pgEnum('conformance_case_outcome', [
  'pass',
  'fail',
  'skipped',
]);

export const conformanceRuns = pgTable(
  'conformance_runs',
  {
    id: serial('id').primaryKey(),
    adapter: conformanceAdapterEnum('adapter').notNull(),
    /** Version of our adapter under test, e.g. the grid-protocols build. */
    adapterVersion: varchar('adapter_version', { length: 64 }).notNull(),
    /** Protocol revision exercised, e.g. `1.6J`, `2.0.1`, `2.0b`. */
    protocolVersion: varchar('protocol_version', { length: 32 }).notNull(),
    /**
     * The peer. For a simulator this names the simulator and its version; for a
     * device it is the vendor/model, so a claim of interoperability can be
     * traced to hardware somebody actually had.
     */
    deviceModel: varchar('device_model', { length: 191 }).notNull(),
    /** Serial, charge point id or LFDI when the peer was a real device. */
    deviceIdentifier: varchar('device_identifier', { length: 191 }),
    target: conformanceTargetEnum('target').notNull(),
    /** Stable id of the vector set, so two runs of the same suite compare. */
    vectorSetId: varchar('vector_set_id', { length: 128 }).notNull(),
    vectorSetVersion: varchar('vector_set_version', { length: 32 }).notNull(),
    totalCases: int('total_cases').notNull(),
    passedCases: int('passed_cases').notNull(),
    failedCases: int('failed_cases').notNull(),
    skippedCases: int('skipped_cases').notNull(),
    outcome: conformanceRunOutcomeEnum('outcome').notNull(),
    /**
     * Who ran it. A signed service account (`service:grid-protocols`) or a
     * platform user id; never blank, because an unattributed conformance claim
     * is not evidence.
     */
    operator: varchar('operator', { length: 191 }).notNull(),
    startedAt: timestamp('started_at').notNull(),
    completedAt: timestamp('completed_at').notNull(),
    /** SHA-256 of the artifact the runner emitted, lowercase hex. */
    artifactChecksum: varchar('artifact_checksum', { length: 64 }).notNull(),
    /** Where the artifact was stored, when it was stored anywhere. */
    artifactUri: text('artifact_uri'),
    detail: text('detail'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  table => ({
    adapterIdx: index('conformance_runs_adapter_idx').on(
      table.adapter,
      table.outcome,
      table.completedAt
    ),
    countsAgree: check(
      'conformance_runs_counts_agree',
      sql`${table.passedCases} + ${table.failedCases} + ${table.skippedCases} = ${table.totalCases}
        AND ${table.passedCases} >= 0 AND ${table.failedCases} >= 0 AND ${table.skippedCases} >= 0`
    ),
    // A passing run is every case passing, and at least one case existing. An
    // empty suite reporting `passed` would prove a protocol by testing nothing.
    passedIsComplete: check(
      'conformance_runs_passed_is_complete',
      sql`${table.outcome} <> 'passed'
        OR (${table.totalCases} > 0
            AND ${table.passedCases} = ${table.totalCases}
            AND ${table.failedCases} = 0
            AND ${table.skippedCases} = 0)`
    ),
    checksumIsSha256: check(
      'conformance_runs_checksum_sha256',
      sql`${table.artifactChecksum} ~ '^[0-9a-f]{64}$'`
    ),
    windowOrdered: check(
      'conformance_runs_window_ordered',
      sql`${table.completedAt} >= ${table.startedAt}`
    ),
  })
);

export type ConformanceRun = typeof conformanceRuns.$inferSelect;
export type InsertConformanceRun = typeof conformanceRuns.$inferInsert;

/**
 * Per-case results. Stored individually rather than as a summary count so that a
 * reviewer can see *which* requirement failed — "17/18 passed" hides whether the
 * missing one was an optional profile or transaction identity.
 */
export const conformanceCases = pgTable(
  'conformance_cases',
  {
    id: serial('id').primaryKey(),
    runId: int('run_id')
      .notNull()
      .references(() => conformanceRuns.id, { onDelete: 'cascade' }),
    /** Stable case id within the vector set, e.g. `ocpp16.boot.accepted`. */
    caseId: varchar('case_id', { length: 128 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    /** The clause or behaviour the case exercises, in words. */
    requirement: text('requirement').notNull(),
    outcome: conformanceCaseOutcomeEnum('outcome').notNull(),
    detail: text('detail'),
    /** Frames exchanged, or the reason a case was skipped. */
    evidence: jsonb('evidence'),
  },
  table => ({
    runIdx: index('conformance_cases_run_idx').on(table.runId),
    uniqueCase: unique('conformance_cases_run_case_unique').on(table.runId, table.caseId),
  })
);

export type ConformanceCase = typeof conformanceCases.$inferSelect;
export type InsertConformanceCase = typeof conformanceCases.$inferInsert;

/**
 * A certification recorded against an asset. `conformanceRunId` is NOT NULL and
 * a foreign key: there is no way to store "this battery is 2030.5 certified"
 * without naming the run that showed it, and the service refuses a run whose
 * outcome is not `passed` or whose adapter differs.
 */
export const derProtocolCertifications = pgTable(
  'der_protocol_certifications',
  {
    id: serial('id').primaryKey(),
    assetId: int('asset_id').notNull(),
    adapter: conformanceAdapterEnum('adapter').notNull(),
    conformanceRunId: int('conformance_run_id')
      .notNull()
      .references(() => conformanceRuns.id, { onDelete: 'restrict' }),
    /** Platform user id or accredited body that signed the certification off. */
    certifiedBy: varchar('certified_by', { length: 191 }).notNull(),
    certifiedAt: timestamp('certified_at').defaultNow().notNull(),
    /** Null means it does not expire on a date; staleness is judged on the run. */
    expiresAt: timestamp('expires_at'),
    note: text('note'),
  },
  table => ({
    assetIdx: index('der_protocol_certifications_asset_idx').on(table.assetId, table.adapter),
    uniquePerRun: unique('der_protocol_certifications_asset_adapter_run_unique').on(
      table.assetId,
      table.adapter,
      table.conformanceRunId
    ),
  })
);

export type DerProtocolCertification = typeof derProtocolCertifications.$inferSelect;
export type InsertDerProtocolCertification = typeof derProtocolCertifications.$inferInsert;
