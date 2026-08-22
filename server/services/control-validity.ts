/**
 * Control validity windows and degraded-mode fallback.
 *
 * A setpoint without an expiry is a latent hazard: if the platform, the network
 * or the optimizer goes away, the asset keeps executing the last instruction it
 * received — discharging a home battery through an outage, or holding an EV at
 * a V2G export limit long after the price signal that justified it expired.
 *
 * Every control this platform issues therefore carries:
 *   - a bounded window (`validFrom`/`validTo`), enforced here and expressed in
 *     the protocol message itself so the device stops obeying on its own clock;
 *   - a declared fallback policy describing what the asset does afterwards.
 *
 * The window is not advisory. `resolveControlWindow` rejects unbounded, inverted,
 * already-expired and over-long windows, and the sweeper in
 * `server/services/control-delivery.ts` delivers the fallback when a window
 * closes without a refresh.
 */

import { and, count, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { getDb } from '../db';
import {
  controlAssignments,
  controlFallbackEvents,
  type ControlAssignment,
  type InsertControlAssignment,
} from '../../drizzle/control-schema';

export type ControlProtocol = 'ocpp16' | 'sep2' | 'openadr' | 'modbus' | 'mqtt';
/**
 * `broker_queued` is a publish the MQTT broker acknowledged at QoS 1 without a
 * device answer: the setpoint is on its way and counts as in force, unlike
 * `unconfirmed`, where the platform does not know whether anything was delivered.
 */
export type ControlDelivery = 'accepted' | 'broker_queued' | 'rejected' | 'unconfirmed';
/** Deliveries that mean a setpoint is (or will be) running on the hardware. */
export const IN_FORCE_DELIVERIES = ['accepted', 'broker_queued'] as const;
export type ControlFallbackPolicy = 'safe_limit' | 'resume_local' | 'hold_last';
export type ControlSource =
  | 'optimizer'
  | 'v2g_schedule'
  | 'dr_event'
  | 'grid_instruction'
  | 'manual';

/** Longest window a control may claim unless the deployment raises it. */
export const DEFAULT_MAX_VALIDITY_SECONDS = 3600;
/**
 * Windows shorter than this cannot survive one command round trip plus a
 * refresh cycle, so accepting them would guarantee flapping into fallback.
 */
export const MIN_VALIDITY_SECONDS = 60;

export class ControlValidityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlValidityError';
  }
}

/**
 * Control assignment is an audit record of physical actuation, so an unavailable
 * database is a hard failure rather than something to shrug off: a dispatch we
 * cannot record is a setpoint nobody can prove expired.
 */
async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new ControlValidityError(
      'no database is configured; control assignments cannot be recorded and expiry cannot be tracked'
    );
  }
  return db;
}

export function maxValiditySeconds(): number {
  const raw = process.env.GRID_CONTROL_MAX_VALIDITY_SECONDS;
  if (raw === undefined || raw === '') return DEFAULT_MAX_VALIDITY_SECONDS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < MIN_VALIDITY_SECONDS) {
    throw new ControlValidityError(
      `GRID_CONTROL_MAX_VALIDITY_SECONDS must be a number of at least ${MIN_VALIDITY_SECONDS}`
    );
  }
  return Math.floor(value);
}

/**
 * The safe signed watts a `safe_limit` fallback applies. There is no default:
 * a guessed limit would either strand an asset at zero or leave it exporting.
 */
export function fallbackLimitWatts(): number {
  const raw = process.env.GRID_CONTROL_FALLBACK_LIMIT_W;
  if (raw === undefined || raw === '') {
    throw new ControlValidityError(
      'GRID_CONTROL_FALLBACK_LIMIT_W is not configured; a safe_limit fallback has no watts to apply'
    );
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ControlValidityError('GRID_CONTROL_FALLBACK_LIMIT_W must be a finite number of watts');
  }
  return Math.round(value);
}

export interface ControlWindowInput {
  validFrom?: Date;
  validTo?: Date;
  /** Convenience for callers that think in durations rather than instants. */
  validForSeconds?: number;
}

export interface ControlWindow {
  validFrom: Date;
  validTo: Date;
  seconds: number;
}

/**
 * Normalises and validates a control window. Callers must state an end; a
 * command with no expiry is refused rather than silently capped, because the
 * caller's schedule and the device's behaviour would then disagree.
 */
export function resolveControlWindow(
  input: ControlWindowInput,
  now: Date = new Date()
): ControlWindow {
  const validFrom = input.validFrom ?? now;
  if (Number.isNaN(validFrom.getTime())) {
    throw new ControlValidityError('validFrom is not a valid date');
  }

  let validTo = input.validTo;
  if (!validTo && input.validForSeconds !== undefined) {
    if (!Number.isFinite(input.validForSeconds) || input.validForSeconds <= 0) {
      throw new ControlValidityError('validForSeconds must be a positive number of seconds');
    }
    validTo = new Date(validFrom.getTime() + input.validForSeconds * 1000);
  }
  if (!validTo) {
    throw new ControlValidityError(
      'a control needs an explicit validTo or validForSeconds; unbounded setpoints are refused'
    );
  }
  if (Number.isNaN(validTo.getTime())) {
    throw new ControlValidityError('validTo is not a valid date');
  }

  const seconds = Math.round((validTo.getTime() - validFrom.getTime()) / 1000);
  if (seconds < MIN_VALIDITY_SECONDS) {
    throw new ControlValidityError(
      `control window is ${seconds}s; the minimum is ${MIN_VALIDITY_SECONDS}s so a refresh can arrive before it closes`
    );
  }
  const limit = maxValiditySeconds();
  if (seconds > limit) {
    throw new ControlValidityError(
      `control window is ${seconds}s but GRID_CONTROL_MAX_VALIDITY_SECONDS caps it at ${limit}s`
    );
  }
  if (validTo.getTime() <= now.getTime()) {
    throw new ControlValidityError(
      `control window ended at ${validTo.toISOString()}, before it was issued`
    );
  }
  return { validFrom, validTo, seconds };
}

/** Resolves the fallback watts a policy needs, or null when it needs none. */
export function resolveFallbackLimit(
  policy: ControlFallbackPolicy,
  explicitWatts?: number
): number | null {
  if (policy !== 'safe_limit') return null;
  if (explicitWatts !== undefined) {
    if (!Number.isFinite(explicitWatts)) {
      throw new ControlValidityError('fallbackLimitWatts must be a finite number of watts');
    }
    return Math.round(explicitWatts);
  }
  return fallbackLimitWatts();
}

export interface RecordAssignmentInput {
  protocol: ControlProtocol;
  targetRef: string;
  subTargetRef?: number;
  commandRef?: string;
  assetId?: number;
  evId?: number;
  userId?: number;
  source: ControlSource;
  sourceId?: number;
  setpointWatts?: number;
  window: ControlWindow;
  fallbackPolicy: ControlFallbackPolicy;
  fallbackLimitWatts: number | null;
  delivery: ControlDelivery;
  deliveryDetail?: string;
}

/**
 * Records an issued control and marks any earlier live assignment on the same
 * target as superseded, so exactly one window is authoritative per target.
 */
export async function recordControlAssignment(
  input: RecordAssignmentInput
): Promise<number | null> {
  const db = await requireDb();

  const subTargetRef = input.subTargetRef ?? 0;
  const values: InsertControlAssignment = {
    protocol: input.protocol,
    targetRef: input.targetRef,
    subTargetRef,
    commandRef: input.commandRef,
    assetId: input.assetId,
    evId: input.evId,
    userId: input.userId,
    source: input.source,
    sourceId: input.sourceId,
    setpointWatts:
      input.setpointWatts === undefined ? undefined : Math.round(input.setpointWatts),
    validFrom: input.window.validFrom,
    validTo: input.window.validTo,
    fallbackPolicy: input.fallbackPolicy,
    fallbackLimitWatts: input.fallbackLimitWatts,
    delivery: input.delivery,
    deliveryDetail: input.deliveryDetail,
  };

  // One transaction: a superseded predecessor without its successor would leave
  // the target with no authoritative window, and a successor without the
  // supersession would leave two live windows fighting over the same device.
  return db.transaction(async tx => {
    // Only a replacement that is in force supersedes: a refused or unconfirmed
    // plan did not replace anything on the device, and retiring the predecessor
    // would drop a live setpoint out of the expiry sweep and the operator health
    // counts.
    if (isInForce(input.delivery)) {
      await tx
        .update(controlAssignments)
        .set({ supersededAt: new Date() })
        .where(
          and(
            eq(controlAssignments.protocol, input.protocol),
            eq(controlAssignments.targetRef, input.targetRef),
            eq(controlAssignments.subTargetRef, subTargetRef),
            inArray(controlAssignments.delivery, [...IN_FORCE_DELIVERIES]),
            isNull(controlAssignments.supersededAt),
            isNull(controlAssignments.fallbackAppliedAt)
          )
        );
    }

    const [inserted] = await tx
      .insert(controlAssignments)
      .values(values)
      .returning({ id: controlAssignments.id });
    return inserted?.id ?? null;
  });
}

/**
 * How long a claim is honoured before another sweeper may retry it. A process
 * that dies between claiming and delivering must not strand a device outside a
 * maintained window forever.
 */
export const FALLBACK_CLAIM_TTL_SECONDS = 300;

/**
 * Assignments whose window has closed while they were still the live control and
 * whose fallback has not been delivered. Rows claimed by another sweeper within
 * the claim TTL are excluded.
 */
export async function expiredAssignments(
  now: Date = new Date(),
  limit = 200
): Promise<ControlAssignment[]> {
  const db = await requireDb();
  const claimCutoff = new Date(now.getTime() - FALLBACK_CLAIM_TTL_SECONDS * 1000);
  return db
    .select()
    .from(controlAssignments)
    .where(
      and(
        inArray(controlAssignments.delivery, [...IN_FORCE_DELIVERIES]),
        isNull(controlAssignments.supersededAt),
        isNull(controlAssignments.fallbackAppliedAt),
        lte(controlAssignments.validTo, now),
        sql`(${controlAssignments.fallbackClaimedAt} IS NULL OR ${controlAssignments.fallbackClaimedAt} <= ${claimCutoff})`
      )
    )
    .orderBy(controlAssignments.validTo)
    .limit(limit);
}

/**
 * Claims an expired assignment for fallback processing, returning false when
 * another sweeper already took it. The claim is a conditional UPDATE on
 * `fallback_claimed_at IS NULL`, so two sweepers running concurrently cannot both
 * command the same device or write duplicate audit events.
 */
export async function claimForFallback(
  assignmentId: number,
  now: Date = new Date()
): Promise<boolean> {
  const db = await requireDb();
  const claimCutoff = new Date(now.getTime() - FALLBACK_CLAIM_TTL_SECONDS * 1000);
  const result = await db
    .update(controlAssignments)
    .set({ fallbackClaimedAt: now })
    .where(
      and(
        eq(controlAssignments.id, assignmentId),
        isNull(controlAssignments.fallbackAppliedAt),
        sql`(${controlAssignments.fallbackClaimedAt} IS NULL OR ${controlAssignments.fallbackClaimedAt} <= ${claimCutoff})`
      )
    );
  return (result.rowCount ?? 0) === 1;
}

/**
 * Releases a claim without recording an outcome, so a sweep that crashed between
 * claiming and delivering does not strand the assignment unprocessed forever.
 */
export async function releaseFallbackClaim(assignmentId: number): Promise<void> {
  const db = await requireDb();
  await db
    .update(controlAssignments)
    .set({ fallbackClaimedAt: null })
    .where(
      and(eq(controlAssignments.id, assignmentId), isNull(controlAssignments.fallbackAppliedAt))
    );
}

export type FallbackReason =
  | 'window_expired'
  | 'superseded'
  | 'device_offline'
  | 'operator_revoked';

/**
 * `unconfirmed` means the fallback command may or may not have reached the
 * device; it is never reported as applied.
 */
export type FallbackOutcome = 'applied' | 'device_offline' | 'rejected' | 'unconfirmed';

export async function recordFallbackOutcome(
  assignmentId: number,
  reason: FallbackReason,
  outcome: FallbackOutcome,
  detail: string
): Promise<void> {
  const db = await requireDb();

  // Atomic: the assignment must never report a fallback outcome that has no
  // audit event, nor an event for an outcome the assignment does not carry.
  await db.transaction(async tx => {
    await tx
      .update(controlAssignments)
      .set({
        fallbackAppliedAt: new Date(),
        fallbackOutcome: outcome,
        fallbackDetail: detail.slice(0, 2000),
      })
      .where(eq(controlAssignments.id, assignmentId));

    await tx.insert(controlFallbackEvents).values({
      assignmentId,
      reason,
      outcome,
      detail: detail.slice(0, 2000),
    });
  });
}

/**
 * `hold_last` needs no delivery, but it must still be closed out and visible:
 * an operator reading the UI has to see that an expired setpoint is still live
 * on the hardware.
 */
export async function closeHoldLast(assignment: ControlAssignment): Promise<void> {
  const db = await requireDb();
  await db
    .update(controlAssignments)
    .set({
      fallbackAppliedAt: new Date(),
      fallbackOutcome: 'not_required',
      fallbackDetail:
        'fallback_policy=hold_last: the last setpoint remains active on the device past its window',
    })
    .where(eq(controlAssignments.id, assignment.id));
}

export type ControlState =
  | 'no_control'
  | 'scheduled'
  | 'active'
  | 'expiring'
  | 'expired_awaiting_fallback'
  | 'fallback_applied'
  | 'fallback_failed'
  | 'held_past_window'
  | 'rejected';

/** Seconds before `validTo` at which a control is reported as expiring. */
export const EXPIRING_WINDOW_SECONDS = 300;

/**
 * Derives the state of a single assignment. Pure so both the API and the tests
 * agree on what "active" means.
 */
export function assignmentState(
  assignment: Pick<
    ControlAssignment,
    'validFrom' | 'validTo' | 'delivery' | 'supersededAt' | 'fallbackAppliedAt' | 'fallbackOutcome' | 'fallbackPolicy'
  >,
  now: Date = new Date()
): ControlState {
  if (assignment.delivery === 'rejected') return 'rejected';
  if (assignment.fallbackAppliedAt) {
    if (assignment.fallbackPolicy === 'hold_last') return 'held_past_window';
    if (assignment.fallbackOutcome === 'applied' || assignment.fallbackOutcome === 'not_required') {
      return 'fallback_applied';
    }
    return 'fallback_failed';
  }
  if (assignment.supersededAt && assignment.supersededAt.getTime() <= now.getTime()) {
    return 'no_control';
  }
  if (now.getTime() < assignment.validFrom.getTime()) return 'scheduled';
  if (now.getTime() >= assignment.validTo.getTime()) return 'expired_awaiting_fallback';
  if (assignment.validTo.getTime() - now.getTime() <= EXPIRING_WINDOW_SECONDS * 1000) {
    return 'expiring';
  }
  return 'active';
}

export interface ControlStatusRow {
  assignment: ControlAssignment;
  state: ControlState;
  secondsRemaining: number;
}

function withState(rows: ControlAssignment[], now: Date): ControlStatusRow[] {
  return rows.map(assignment => ({
    assignment,
    state: assignmentState(assignment, now),
    secondsRemaining: Math.round((assignment.validTo.getTime() - now.getTime()) / 1000),
  }));
}

/** Most recent assignments, newest first, for the operator view. */
export async function recentAssignments(limit = 50): Promise<ControlStatusRow[]> {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(controlAssignments)
    .orderBy(desc(controlAssignments.createdAt))
    .limit(limit);
  return withState(rows, new Date());
}

export async function assignmentsForUser(
  userId: number,
  limit = 50
): Promise<ControlStatusRow[]> {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(controlAssignments)
    .where(eq(controlAssignments.userId, userId))
    .orderBy(desc(controlAssignments.createdAt))
    .limit(limit);
  return withState(rows, new Date());
}

/**
 * The assignment currently commanding a target, if any. Revoking a control has
 * to close out the record that claims the device is under platform control, so
 * the caller needs the live row rather than the newest one.
 */
export async function liveAssignmentFor(
  protocol: ControlProtocol,
  targetRef: string,
  subTargetRef = 0
): Promise<ControlAssignment | null> {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(controlAssignments)
    .where(
      and(
        liveControl(),
        eq(controlAssignments.protocol, protocol),
        eq(controlAssignments.targetRef, targetRef),
        eq(controlAssignments.subTargetRef, subTargetRef)
      )
    )
    .orderBy(desc(controlAssignments.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export interface ControlHealth {
  live: number;
  expiring: number;
  awaitingFallback: number;
  fallbackFailed: number;
  heldPastWindow: number;
}

export function isInForce(delivery: ControlDelivery): boolean {
  return (IN_FORCE_DELIVERIES as readonly string[]).includes(delivery);
}

/** An assignment is the live control for its target while this holds. */
function liveControl() {
  return and(
    inArray(controlAssignments.delivery, [...IN_FORCE_DELIVERIES]),
    isNull(controlAssignments.supersededAt),
    isNull(controlAssignments.fallbackAppliedAt)
  );
}

/**
 * Fleet-level counts. `awaitingFallback` above zero means hardware is currently
 * outside a maintained control window — the number an operator should page on.
 */
export async function controlHealth(now: Date = new Date()): Promise<ControlHealth> {
  const db = await requireDb();
  const soon = new Date(now.getTime() + EXPIRING_WINDOW_SECONDS * 1000);

  // Counted in the database rather than by paging rows: a fleet view that only
  // examined the newest N assignments would under-report the number of devices
  // sitting outside a maintained window, which is the one number that matters.
  const [[live], [expiring], [awaitingFallback], [fallbackFailed], [heldPastWindow]] =
    await Promise.all([
      db
        .select({ value: count() })
        .from(controlAssignments)
        .where(and(liveControl(), sql`${controlAssignments.validTo} > ${now}`)),
      db
        .select({ value: count() })
        .from(controlAssignments)
        .where(
          and(
            liveControl(),
            sql`${controlAssignments.validTo} > ${now}`,
            lte(controlAssignments.validTo, soon)
          )
        ),
      db
        .select({ value: count() })
        .from(controlAssignments)
        .where(and(liveControl(), lte(controlAssignments.validTo, now))),
      db
        .select({ value: count() })
        .from(controlAssignments)
        .where(
          sql`${controlAssignments.fallbackAppliedAt} IS NOT NULL
            AND ${controlAssignments.fallbackOutcome} IN ('rejected','device_offline','unconfirmed')`
        ),
      db
        .select({ value: count() })
        .from(controlAssignments)
        .where(
          and(
            eq(controlAssignments.fallbackPolicy, 'hold_last'),
            sql`${controlAssignments.fallbackAppliedAt} IS NOT NULL`,
            isNull(controlAssignments.supersededAt)
          )
        ),
    ]);

  return {
    live: Number(live?.value ?? 0),
    expiring: Number(expiring?.value ?? 0),
    awaitingFallback: Number(awaitingFallback?.value ?? 0),
    fallbackFailed: Number(fallbackFailed?.value ?? 0),
    heldPastWindow: Number(heldPastWindow?.value ?? 0),
  };
}
