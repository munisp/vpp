/**
 * Degraded operation: what the platform may still do when a dependency is gone,
 * and what it must refuse.
 *
 * The failure this file exists to prevent is not the outage — outages are normal
 * — it is the outage that nobody can see afterwards. A dispatch computed without
 * the optimizer, a settlement computed without meter telemetry, or a market bid
 * "placed" while the broker was unreachable all produce plausible-looking rows.
 * So:
 *
 *  - posture comes only from recorded observations of real calls. An observation
 *    older than the dependency's staleness bound reads `unknown`, never `up`:
 *    silence is not health;
 *  - each guarded capability declares the dependencies it needs. `unknown` is
 *    treated exactly like `down` for anything that moves money or makes an
 *    external commitment, because "we have not checked" is not a basis for
 *    paying someone;
 *  - a capability that may run degraded (local safe control, in particular) must
 *    record what it could not prove via `recordDegradedAction`, and that record
 *    is only cleared by `reconcileDegradedAction` once the evidence arrives.
 *
 * Physical safety is the reason the control path is allowed to run degraded at
 * all: refusing to issue a bounded fallback because the optimizer is down would
 * leave the last setpoint running on the hardware, which is worse than issuing a
 * conservative one and labelling it as unverified.
 */

import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { getDb } from '../db';
import {
  degradedActions,
  dependencyObservations,
  dependencyOutages,
  type DegradedAction,
  type DependencyObservation,
} from '../../drizzle/degraded-schema';

export type DependencyName =
  | 'optimizer'
  | 'mqtt_broker'
  | 'grid_protocols'
  | 'matter_controller'
  | 'payment_gateway'
  | 'market_broker'
  | 'meter_telemetry';

export type Observation = 'reachable' | 'unreachable' | 'faulted';

/** `unknown` is not a third kind of healthy; it is "nobody has looked lately". */
export type DependencyState = 'up' | 'down' | 'unknown';

/**
 * `enforce` refuses guarded capabilities; `observe` allows them and records a
 * `degraded_actions` row instead.
 *
 * Production defaults to `enforce`: a deployment that pays out while it cannot
 * see its own dependencies is the failure mode this layer exists for. Elsewhere
 * the default is `observe`, so a developer without a broker or optimizer running
 * is not locked out of the app, and every allowance is written down.
 *
 * `observe` never applies to a capability marked `alwaysEnforced`. A development
 * switch that can be flipped into paying money or placing bids without evidence
 * would be the same hole with a config flag in front of it.
 */
export type GuardMode = 'enforce' | 'observe';

export function guardMode(): GuardMode {
  const raw = process.env.DEGRADED_GUARD?.trim();
  if (raw === 'enforce' || raw === 'observe') return raw;
  if (raw !== undefined && raw !== '') {
    throw new Error(`DEGRADED_GUARD must be 'enforce' or 'observe', got '${raw}'`);
  }
  return process.env.NODE_ENV === 'production' ? 'enforce' : 'observe';
}

export class DegradedOperationError extends Error {
  readonly capability: string;
  readonly missing: DependencyName[];

  constructor(capability: string, missing: DependencyName[], detail: string) {
    super(detail);
    this.name = 'DegradedOperationError';
    this.capability = capability;
    this.missing = missing;
  }
}

/**
 * How long one observation of a dependency stays meaningful.
 *
 * Chosen per dependency from how often the platform actually touches it: the
 * MQTT broker is written to on every dispatch, while a payment gateway may be
 * idle for an hour on a quiet night, and calling that an outage would refuse
 * payouts for no reason.
 */
export const STALENESS_SECONDS: Record<DependencyName, number> = {
  optimizer: 900,
  mqtt_broker: 900,
  grid_protocols: 600,
  matter_controller: 900,
  payment_gateway: 3600,
  market_broker: 3600,
  meter_telemetry: 1800,
};

/** Consecutive failures before an outage is opened. One timeout is not an outage. */
export const FAILURES_TO_OPEN = 3;

export const DEPENDENCIES: DependencyName[] = [
  'optimizer',
  'mqtt_broker',
  'grid_protocols',
  'matter_controller',
  'payment_gateway',
  'market_broker',
  'meter_telemetry',
];

/**
 * The capabilities whose dependencies are checked before they run.
 *
 * `degradedAllowed` is deliberately rare. It marks the paths where doing nothing
 * is more dangerous than acting without full evidence — issuing a bounded
 * fallback setpoint to hardware that is currently holding an expired one — and
 * every use of it writes a `degraded_actions` row.
 */
export interface CapabilityRule {
  /**
   * Must be `up`. An `unknown` here blocks, because silence is not evidence —
   * used where something other than this capability observes the dependency
   * (telemetry arriving, the protocol service reporting in), so a healthy system
   * always has a fresh observation.
   */
  requires: DependencyName[];
  /**
   * Must merely not be in an open outage. Used where the guarded call is the
   * only thing that ever observes the dependency: requiring `up` there would
   * deadlock — the first payout after a quiet night could never run, because the
   * only way to observe the gateway is to call it. The call itself still fails
   * loudly if the dependency is gone, and three such failures open the outage
   * that then blocks this capability.
   */
  requiresNotDown?: DependencyName[];
  degradedAllowed: boolean;
  /**
   * Refused regardless of `DEGRADED_GUARD`. Set on everything that moves money
   * or commits the platform to an outside party, where there is no such thing as
   * a harmless unverified attempt.
   */
  alwaysEnforced?: boolean;
  /** What a reader must not conclude from a result produced while degraded. */
  evidenceLimit: string;
}

export const CAPABILITIES: Record<string, CapabilityRule> = {
  /** Publishing a market bid or accepting an award: an external commitment. */
  market_bid: {
    requires: [],
    requiresNotDown: ['market_broker'],
    degradedAllowed: false,
    alwaysEnforced: true,
    evidenceLimit: 'a bid cannot be placed without the broker acknowledging it',
  },
  /** Disbursing money to a member through a mobile-money gateway. */
  settlement_payout: {
    requires: [],
    requiresNotDown: ['payment_gateway'],
    degradedAllowed: false,
    alwaysEnforced: true,
    evidenceLimit: 'a payout cannot be confirmed without the gateway acknowledging it',
  },
  /**
   * Paying a flexibility award from measured delivery. The ledger write is local,
   * but the measurement is not: without the telemetry path the platform cannot
   * know what was delivered, and paying an unmeasured award is paying a guess.
   */
  flexibility_settlement: {
    requires: ['meter_telemetry'],
    degradedAllowed: false,
    alwaysEnforced: true,
    evidenceLimit:
      'delivered energy is measured from telemetry; with that path down, a settlement amount is not a measurement',
  },
  /**
   * Writing a settlement event whose amount comes from metered delivery
   * (dispatch completion, DR response). The money is owed for energy that was
   * measured; with the telemetry path unobservable the figure is arithmetic on
   * whatever rows happen to be there.
   */
  metered_settlement: {
    requires: ['meter_telemetry'],
    degradedAllowed: false,
    alwaysEnforced: true,
    evidenceLimit:
      'a settlement amount computed while the meter path was unobservable is not a measurement of delivery',
  },
  /** Asking the optimizer for a dispatch plan. */
  optimizer_dispatch: {
    requires: [],
    requiresNotDown: ['optimizer'],
    degradedAllowed: false,
    evidenceLimit: 'a plan produced without the optimizer is not an optimized plan',
  },
  /** Publishing a price signal for sites to plan against. */
  price_signal_publish: {
    requires: [],
    requiresNotDown: ['optimizer', 'mqtt_broker'],
    degradedAllowed: false,
    evidenceLimit: 'a price signal nobody received cannot be settled against',
  },
  /**
   * Issuing a bounded control (including a fallback at window expiry). Allowed
   * degraded: hardware left on an expired setpoint is the worse outcome.
   */
  control_dispatch: {
    requires: ['mqtt_broker', 'grid_protocols'],
    degradedAllowed: true,
    evidenceLimit:
      'issued while the delivery path was unavailable: this is not evidence the asset received or followed the control',
  },
  /** Commanding a Matter smart-home load. */
  matter_command: {
    requires: ['matter_controller'],
    degradedAllowed: false,
    evidenceLimit: 'a load cannot be commanded without its controller',
  },
} as const;

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new DegradedOperationError(
      'degraded_operation',
      [],
      'no database is configured; dependency posture cannot be recorded, so no capability can be authorized'
    );
  }
  return db;
}

export interface DependencyPosture {
  dependency: DependencyName;
  state: DependencyState;
  /** The observation the state came from, or null when nothing was ever recorded. */
  lastObservation: {
    observation: Observation;
    observedBy: string;
    operation: string;
    observedAt: Date;
    detail: string | null;
  } | null;
  /** Set while an outage is open. */
  outage: { startedAt: Date; failureCount: number; lastDetail: string | null } | null;
  stalenessSeconds: number;
  /** Why the state reads as it does, in words an operator can act on. */
  reason: string;
}

/**
 * Records one observation and maintains the dependency's outage row.
 *
 * Call this from the code that actually talked to the dependency, on both the
 * success and the failure path — a separate prober would let a dependency answer
 * a health check while every real request to it fails.
 */
export async function recordObservation(input: {
  dependency: DependencyName;
  observation: Observation;
  observedBy: string;
  operation: string;
  latencyMs?: number | null;
  detail?: string | null;
  observedAt?: Date;
}): Promise<{ observationId: number; outageOpened: boolean; outageClosed: boolean }> {
  const db = await requireDb();
  const observedAt = input.observedAt ?? new Date();
  const detail = input.detail ? input.detail.slice(0, 512) : null;

  const [recorded] = await db
    .insert(dependencyObservations)
    .values({
      dependency: input.dependency,
      observation: input.observation,
      observedBy: input.observedBy.slice(0, 64),
      operation: input.operation.slice(0, 128),
      latencyMs: input.latencyMs ?? null,
      detail,
      observedAt,
    })
    .returning({ id: dependencyObservations.id });

  const [open] = await db
    .select()
    .from(dependencyOutages)
    .where(
      and(eq(dependencyOutages.dependency, input.dependency), isNull(dependencyOutages.restoredAt))
    )
    .limit(1);

  if (input.observation === 'reachable') {
    if (!open) return { observationId: recorded.id, outageOpened: false, outageClosed: false };
    // Close by id and only while still open: a concurrent restore must not
    // produce two closing writes with different observations.
    const closed = await db
      .update(dependencyOutages)
      .set({ restoredAt: observedAt, closedBy: recorded.id, updatedAt: observedAt })
      .where(and(eq(dependencyOutages.id, open.id), isNull(dependencyOutages.restoredAt)))
      .returning({ id: dependencyOutages.id });
    return {
      observationId: recorded.id,
      outageOpened: false,
      outageClosed: closed.length > 0,
    };
  }

  if (open) {
    await db
      .update(dependencyOutages)
      .set({
        failureCount: sql`${dependencyOutages.failureCount} + 1`,
        lastDetail: detail,
        updatedAt: observedAt,
      })
      .where(eq(dependencyOutages.id, open.id));
    return { observationId: recorded.id, outageOpened: false, outageClosed: false };
  }

  const recentFailures = await consecutiveFailures(db, input.dependency);
  if (recentFailures < FAILURES_TO_OPEN) {
    return { observationId: recorded.id, outageOpened: false, outageClosed: false };
  }

  // The partial unique index makes this the arbiter: a concurrent reporter that
  // also reached the threshold gets a conflict rather than a second outage.
  const opened = await db
    .insert(dependencyOutages)
    .values({
      dependency: input.dependency,
      startedAt: observedAt,
      openedBy: recorded.id,
      failureCount: recentFailures,
      lastDetail: detail,
    })
    .onConflictDoNothing()
    .returning({ id: dependencyOutages.id });

  return {
    observationId: recorded.id,
    outageOpened: opened.length > 0,
    outageClosed: false,
  };
}

/** Counts the trailing run of failures in the dependency's recent observations. */
async function consecutiveFailures(
  db: Awaited<ReturnType<typeof requireDb>>,
  dependency: DependencyName
): Promise<number> {
  const recent = await db
    .select({ observation: dependencyObservations.observation })
    .from(dependencyObservations)
    .where(eq(dependencyObservations.dependency, dependency))
    .orderBy(desc(dependencyObservations.observedAt), desc(dependencyObservations.id))
    .limit(FAILURES_TO_OPEN);

  let failures = 0;
  for (const row of recent) {
    if (row.observation === 'reachable') break;
    failures += 1;
  }
  return failures;
}

/**
 * Wraps a call to a dependency so its outcome is recorded whether it worked or
 * not, and the caller still sees the original error.
 *
 * Recording is best effort on purpose: a database that cannot store observations
 * must not turn a working optimizer call into a failure. Unrecorded observations
 * decay to `unknown`, which blocks money and market paths rather than opening
 * them, so losing them fails safe.
 */
export async function observing<T>(
  input: {
    dependency: DependencyName;
    observedBy: string;
    operation: string;
    /** Classifies an error that came back from a dependency that did answer. */
    faultedWhen?: (error: unknown) => boolean;
    /**
     * Classifies a returned value, for clients that report a refusal as data
     * rather than by throwing. Returning `faulted` records the call as one
     * failure, so a run of refusals opens an outage the way a run of timeouts
     * does; recording a success and a fault separately would not.
     */
    resultObservation?: (result: T) => Observation;
  },
  call: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await call();
    const observed = input.resultObservation?.(result) ?? 'reachable';
    await tryRecord({
      dependency: input.dependency,
      observation: observed,
      observedBy: input.observedBy,
      operation: input.operation,
      latencyMs: Date.now() - startedAt,
      detail: observed === 'reachable' ? null : 'dependency answered but refused the request',
    });
    return result;
  } catch (error) {
    const observation: Observation = input.faultedWhen?.(error) ? 'faulted' : 'unreachable';
    await tryRecord({
      dependency: input.dependency,
      observation,
      observedBy: input.observedBy,
      operation: input.operation,
      latencyMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function tryRecord(input: Parameters<typeof recordObservation>[0]): Promise<void> {
  try {
    await recordObservation(input);
  } catch (error) {
    console.error(
      `[DegradedOperation] could not record ${input.observation} observation of ${input.dependency}:`,
      error
    );
  }
}

/** Current posture of every dependency, from recorded observations only. */
export async function dependencyPostures(now = new Date()): Promise<DependencyPosture[]> {
  const db = await requireDb();

  const latest = new Map<DependencyName, DependencyObservation>();
  // The most recent observation per dependency, whatever it said. Ordered by
  // observation time rather than id: a caller may record an observation with the
  // timestamp of the call it wrapped, so insertion order is not event order.
  const rows = await Promise.all(
    DEPENDENCIES.map(dependency =>
      db
        .select()
        .from(dependencyObservations)
        .where(eq(dependencyObservations.dependency, dependency))
        .orderBy(desc(dependencyObservations.observedAt), desc(dependencyObservations.id))
        .limit(1)
    )
  );
  for (const [row] of rows) {
    if (row) latest.set(row.dependency as DependencyName, row);
  }

  const openOutages = new Map<DependencyName, (typeof dependencyOutages.$inferSelect)[]>();
  const outages = await db
    .select()
    .from(dependencyOutages)
    .where(isNull(dependencyOutages.restoredAt));
  for (const outage of outages) {
    const key = outage.dependency as DependencyName;
    openOutages.set(key, [...(openOutages.get(key) ?? []), outage]);
  }

  return DEPENDENCIES.map(dependency =>
    derivePosture(
      dependency,
      latest.get(dependency) ?? null,
      openOutages.get(dependency)?.[0] ?? null,
      now
    )
  );
}

/**
 * Turns the last observation and any open outage into a posture.
 *
 * Exported for its own tests: this is the function that decides whether the
 * platform believes a dependency is there, and every refusal downstream rests on
 * it. Note the two ways to reach `unknown` — nothing recorded, and something
 * recorded too long ago — and that neither can produce `up`.
 */
export function derivePosture(
  dependency: DependencyName,
  observation: Pick<
    DependencyObservation,
    'observation' | 'observedBy' | 'operation' | 'observedAt' | 'detail'
  > | null,
  outage: Pick<
    typeof dependencyOutages.$inferSelect,
    'startedAt' | 'failureCount' | 'lastDetail'
  > | null,
  now = new Date()
): DependencyPosture {
  const stalenessSeconds = STALENESS_SECONDS[dependency];

  let state: DependencyState;
  let reason: string;
  if (outage) {
    state = 'down';
    reason = `outage open since ${outage.startedAt.toISOString()} after ${outage.failureCount} consecutive failures`;
  } else if (!observation) {
    state = 'unknown';
    reason = 'never observed: no call to this dependency has been recorded';
  } else {
    const ageSeconds = (now.getTime() - observation.observedAt.getTime()) / 1000;
    if (ageSeconds > stalenessSeconds) {
      state = 'unknown';
      reason = `last observed ${Math.round(ageSeconds)}s ago, beyond the ${stalenessSeconds}s bound: silence is not health`;
    } else if (observation.observation === 'reachable') {
      state = 'up';
      reason = `answered ${observation.operation} ${Math.round(ageSeconds)}s ago`;
    } else {
      // Failing, but not yet enough failures to call it an outage.
      state = 'unknown';
      reason = `last call ${observation.observation} (${observation.detail ?? 'no detail'}), below the ${FAILURES_TO_OPEN}-failure threshold`;
    }
  }

  return {
    dependency,
    state,
    lastObservation: observation
      ? {
          observation: observation.observation as Observation,
          observedBy: observation.observedBy,
          operation: observation.operation,
          observedAt: observation.observedAt,
          detail: observation.detail,
        }
      : null,
    outage: outage
      ? {
          startedAt: outage.startedAt,
          failureCount: outage.failureCount,
          lastDetail: outage.lastDetail,
        }
      : null,
    stalenessSeconds,
    reason,
  };
}

export interface CapabilityStatus {
  capability: string;
  requires: DependencyName[];
  /** Dependencies that are down or unknown; both block, for the same reason. */
  missing: DependencyName[];
  /**
   * Dependencies this capability only needs to be *not down*, which have not
   * answered a real call recently. They do not block — the next call is what
   * establishes the evidence, and it fails rather than fabricating a result —
   * but the capability is not proven either, so it must not read as healthy.
   */
  unproven: DependencyName[];
  posture: 'available' | 'degraded' | 'refused';
  evidenceLimit: string | null;
  reason: string;
}

/** Exported for tests: the rule that turns postures into a capability verdict. */
export function statusFor(
  capability: string,
  rule: CapabilityRule,
  states: Map<DependencyName, DependencyPosture>
): CapabilityStatus {
  const notDown = rule.requiresNotDown ?? [];
  const missing = [
    ...rule.requires.filter(dep => states.get(dep)?.state !== 'up'),
    ...notDown.filter(dep => states.get(dep)?.state === 'down'),
  ];
  const declared = [...rule.requires, ...notDown];
  const unproven = notDown.filter(dep => states.get(dep)?.state !== 'up');
  if (missing.length === 0) {
    return {
      capability,
      requires: declared,
      missing,
      unproven,
      posture: 'available',
      evidenceLimit: unproven.length === 0 ? null : rule.evidenceLimit,
      reason:
        unproven.length === 0
          ? 'every dependency answered a real call within its staleness bound'
          : `no required dependency is in an open outage, but ${unproven.join(', ')} has not answered a real call recently: the next call is what establishes that, and it will fail rather than report a result it did not get`,
    };
  }

  const detail = missing
    .map(dep => `${dep} is ${states.get(dep)?.state ?? 'unknown'} (${states.get(dep)?.reason ?? 'no posture'})`)
    .join('; ');

  return {
    capability,
    requires: declared,
    missing,
    unproven,
    posture: rule.degradedAllowed ? 'degraded' : 'refused',
    evidenceLimit: rule.evidenceLimit,
    reason: detail,
  };
}

/** Posture of every guarded capability, for operators and the UI. */
export async function capabilityStatuses(now = new Date()): Promise<CapabilityStatus[]> {
  const postures = await dependencyPostures(now);
  const states = new Map(postures.map(posture => [posture.dependency, posture]));
  return Object.entries(CAPABILITIES).map(([capability, rule]) =>
    statusFor(capability, rule, states)
  );
}

/**
 * Authorizes a guarded capability.
 *
 * Refuses when a required dependency is down or unknown and the capability may
 * not run degraded. When it may, returns the missing dependencies so the caller
 * can record the action with `recordDegradedAction`; the caller is not trusted to
 * decide that on its own, which is why `missing` is returned rather than a boolean.
 */
export async function requireCapability(
  capability: keyof typeof CAPABILITIES | string,
  now = new Date()
): Promise<{ posture: 'available' | 'degraded'; missing: DependencyName[]; evidenceLimit: string | null }> {
  const rule = CAPABILITIES[capability];
  if (!rule) {
    throw new DegradedOperationError(
      String(capability),
      [],
      `no dependency rule is declared for capability ${capability}; refusing rather than assuming it needs nothing`
    );
  }

  const postures = await dependencyPostures(now);
  const states = new Map(postures.map(posture => [posture.dependency, posture]));
  const status = statusFor(String(capability), rule, states);

  if (status.posture === 'refused') {
    if (rule.alwaysEnforced || guardMode() === 'enforce') {
      throw new DegradedOperationError(
        String(capability),
        status.missing,
        `${capability} is refused: ${status.reason}. ${rule.evidenceLimit}`
      );
    }
    console.warn(
      `[DegradedOperation] DEGRADED_GUARD=observe: allowing ${capability} with ${status.missing.join(', ')} unavailable. ${rule.evidenceLimit}`
    );
    return {
      posture: 'degraded',
      missing: status.missing,
      evidenceLimit: rule.evidenceLimit,
    };
  }

  return {
    posture: status.posture,
    missing: status.missing,
    evidenceLimit: status.missing.length > 0 ? rule.evidenceLimit : null,
  };
}

/**
 * Records that a capability ran without its usual evidence.
 *
 * The row is the whole point: it is what stops a degraded dispatch from reading,
 * a week later, like a confirmed one.
 */
export async function recordDegradedAction(input: {
  capability: string;
  subject: string;
  missingDependencies: DependencyName[];
  evidenceLimit: string;
  actedAt?: Date;
}): Promise<{ id: number }> {
  const db = await requireDb();
  const [row] = await db
    .insert(degradedActions)
    .values({
      capability: input.capability.slice(0, 64),
      subject: input.subject.slice(0, 128),
      missingDependencies: input.missingDependencies,
      evidenceLimit: input.evidenceLimit.slice(0, 512),
      actedAt: input.actedAt ?? new Date(),
    })
    .returning({ id: degradedActions.id });
  return { id: row.id };
}

/**
 * Marks a degraded action as reconciled once the missing evidence arrived, e.g.
 * the asset reported the telemetry that shows it did follow the fallback.
 *
 * Only an open action can be reconciled, and the note is required: "reconciled"
 * with nothing behind it would be the same silent claim this layer prevents.
 */
export async function reconcileDegradedAction(input: {
  id: number;
  note: string;
  reconciledAt?: Date;
}): Promise<{ reconciled: boolean }> {
  const db = await requireDb();
  const note = input.note.trim();
  if (note === '') {
    throw new DegradedOperationError(
      'degraded_operation',
      [],
      'reconciling a degraded action requires the evidence that resolved it'
    );
  }
  const reconciled = await db
    .update(degradedActions)
    .set({
      reconciledAt: input.reconciledAt ?? new Date(),
      reconciliationNote: note.slice(0, 512),
    })
    .where(and(eq(degradedActions.id, input.id), isNull(degradedActions.reconciledAt)))
    .returning({ id: degradedActions.id });
  return { reconciled: reconciled.length > 0 };
}

/** Degraded actions still missing their evidence, newest first. */
export async function listOpenDegradedActions(limit = 100): Promise<DegradedAction[]> {
  const db = await requireDb();
  return db
    .select()
    .from(degradedActions)
    .where(isNull(degradedActions.reconciledAt))
    .orderBy(desc(degradedActions.actedAt))
    .limit(limit);
}

/** Recent observations for one dependency, so an operator can see the run of failures. */
export async function listObservations(
  dependency: DependencyName,
  since: Date,
  limit = 200
): Promise<DependencyObservation[]> {
  const db = await requireDb();
  return db
    .select()
    .from(dependencyObservations)
    .where(
      and(
        eq(dependencyObservations.dependency, dependency),
        gte(dependencyObservations.observedAt, since)
      )
    )
    .orderBy(desc(dependencyObservations.observedAt))
    .limit(limit);
}
