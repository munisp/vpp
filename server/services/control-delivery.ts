/**
 * Delivery of bounded control to hardware, and the sweeper that closes windows.
 *
 * This is the only place that turns a plan (a V2G schedule, an optimizer
 * dispatch, a DR instruction) into a protocol command, because it is where the
 * validity window and the fallback policy are attached. A caller cannot dispatch
 * a setpoint without saying when it stops applying and what happens next.
 *
 * Delivery outcomes are recorded as the device reported them: a charge point
 * that is offline yields `unconfirmed`, never a stored setpoint that was never
 * installed.
 */

import {
  clearChargingProfile,
  setChargingProfile,
  setFallbackProfile,
  GridCommandError,
  type ChargingSchedulePeriod,
} from './grid-commands';
import {
  claimForFallback,
  closeHoldLast,
  expiredAssignments,
  recordControlAssignment,
  recordFallbackOutcome,
  resolveControlWindow,
  resolveFallbackLimit,
  type ControlFallbackPolicy,
  type ControlSource,
  type FallbackOutcome,
} from './control-validity';
import type { ControlAssignment } from '../../drizzle/control-schema';

export interface DispatchChargingPlanInput {
  chargePointId: string;
  connectorId: number;
  chargingProfileId: number;
  transactionId?: number;
  /** Signed watts per period; negative discharges the vehicle (V2G). */
  periods: ChargingSchedulePeriod[];
  validFrom?: Date;
  validTo?: Date;
  validForSeconds?: number;
  fallbackPolicy: ControlFallbackPolicy;
  /** Overrides GRID_CONTROL_FALLBACK_LIMIT_W for this target. */
  fallbackLimitWatts?: number;
  source: ControlSource;
  sourceId?: number;
  assetId?: number;
  evId?: number;
  userId?: number;
}

export interface DispatchChargingPlanResult {
  delivered: boolean;
  status: string;
  assignmentId: number | null;
  validFrom: Date;
  validTo: Date;
  fallbackPolicy: ControlFallbackPolicy;
  fallbackLimitWatts: number | null;
  /** Present when the charge point did not take the profile. */
  reason?: string;
}

/**
 * Sends a charging plan bounded by its validity window and records the
 * assignment. A failure to deliver is recorded too: the audit trail must show
 * that a plan existed and that the hardware never took it.
 */
export async function dispatchChargingPlan(
  input: DispatchChargingPlanInput
): Promise<DispatchChargingPlanResult> {
  const window = resolveControlWindow({
    validFrom: input.validFrom,
    validTo: input.validTo,
    validForSeconds: input.validForSeconds,
  });
  const fallbackWatts = resolveFallbackLimit(input.fallbackPolicy, input.fallbackLimitWatts);

  const shared = {
    protocol: 'ocpp16' as const,
    targetRef: input.chargePointId,
    subTargetRef: input.connectorId,
    commandRef: String(input.chargingProfileId),
    assetId: input.assetId,
    evId: input.evId,
    userId: input.userId,
    source: input.source,
    sourceId: input.sourceId,
    setpointWatts: input.periods[0]?.limitWatts,
    window,
    fallbackPolicy: input.fallbackPolicy,
    fallbackLimitWatts: fallbackWatts,
  };

  try {
    const result = await setChargingProfile({
      chargePointId: input.chargePointId,
      connectorId: input.connectorId,
      chargingProfileId: input.chargingProfileId,
      transactionId: input.transactionId,
      purpose: input.transactionId === undefined ? 'TxDefaultProfile' : 'TxProfile',
      stackLevel: 1,
      periods: input.periods,
      startSchedule: window.validFrom,
      durationSeconds: window.seconds,
      validFrom: window.validFrom,
      validTo: window.validTo,
    });
    const assignmentId = await recordControlAssignment({
      ...shared,
      delivery: 'accepted',
      deliveryDetail: `charge point answered ${result.status}`,
    });
    return {
      delivered: true,
      status: result.status,
      assignmentId,
      validFrom: window.validFrom,
      validTo: window.validTo,
      fallbackPolicy: input.fallbackPolicy,
      fallbackLimitWatts: fallbackWatts,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // A rejection is final; a timeout or an unreachable service leaves the
    // charge point's state genuinely unknown, and is recorded as such.
    const delivery =
      error instanceof GridCommandError && error.status === 409 ? 'rejected' : 'unconfirmed';
    const assignmentId = await recordControlAssignment({
      ...shared,
      delivery,
      deliveryDetail: reason,
    });
    return {
      delivered: false,
      status: delivery,
      assignmentId,
      validFrom: window.validFrom,
      validTo: window.validTo,
      fallbackPolicy: input.fallbackPolicy,
      fallbackLimitWatts: fallbackWatts,
      reason,
    };
  }
}

/**
 * Installs the standing safe-limit profile a charge point falls back to. Run
 * this when a charge point is commissioned; the protocol service re-asserts it
 * on every reconnect.
 */
export async function installFallbackProfile(input: {
  chargePointId: string;
  connectorId: number;
  limitWatts?: number;
  chargingProfileId?: number;
}): Promise<{ status: string; limitWatts: number }> {
  const limitWatts = resolveFallbackLimit('safe_limit', input.limitWatts);
  if (limitWatts === null) {
    throw new GridCommandError(500, 'safe_limit fallback resolved to no watts');
  }
  const result = await setFallbackProfile({
    chargePointId: input.chargePointId,
    connectorId: input.connectorId,
    limitWatts,
    chargingProfileId: input.chargingProfileId ?? 1,
  });
  return { status: result.status, limitWatts };
}

/** Maps a failed fallback delivery onto what the platform actually knows. */
function classifyFallbackFailure(error: unknown): FallbackOutcome {
  if (!(error instanceof GridCommandError)) return 'unconfirmed';
  if (error.status === 503) return 'device_offline';
  if (error.status === 409) return 'rejected';
  return 'unconfirmed';
}

export interface FallbackSweepResult {
  examined: number;
  applied: number;
  held: number;
  failed: number;
  /** Rows another sweeper had already claimed; not an error. */
  skipped: number;
  details: string[];
}

/**
 * Applies the declared fallback to every control whose window has closed.
 *
 * This is the platform half of degraded-mode behaviour: the charge point also
 * enforces validTo itself, so a platform outage cannot leave a stale optimizer
 * setpoint running. The sweep exists so that the *record* matches reality and so
 * `resume_local` profiles are actually revoked.
 */
export async function sweepExpiredControls(
  now: Date = new Date()
): Promise<FallbackSweepResult> {
  const expired = await expiredAssignments(now);
  const result: FallbackSweepResult = {
    examined: expired.length,
    applied: 0,
    held: 0,
    failed: 0,
    skipped: 0,
    details: [],
  };

  for (const assignment of expired) {
    // Claim before commanding: two sweepers must not both drive the device or
    // both write a fallback event for the same expiry.
    if (!(await claimForFallback(assignment.id, now))) {
      result.skipped += 1;
      continue;
    }
    if (assignment.fallbackPolicy === 'hold_last') {
      await closeHoldLast(assignment);
      result.held += 1;
      result.details.push(
        `assignment ${assignment.id}: hold_last, setpoint still active on ${assignment.targetRef}`
      );
      continue;
    }
    try {
      const detail = await applyFallback(assignment);
      await recordFallbackOutcome(assignment.id, 'window_expired', 'applied', detail);
      result.applied += 1;
      result.details.push(`assignment ${assignment.id}: ${detail}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // 503 is a disconnected charge point; 409 is an explicit refusal; anything
      // else (timeout, unreachable service) leaves the device state genuinely
      // unknown and is recorded as unconfirmed rather than guessed at. The Go
      // supervisor re-asserts the safe profile when the charge point reconnects.
      await recordFallbackOutcome(
        assignment.id,
        'window_expired',
        classifyFallbackFailure(error),
        reason
      );
      result.failed += 1;
      result.details.push(`assignment ${assignment.id}: fallback failed: ${reason}`);
    }
  }
  return result;
}

async function applyFallback(assignment: ControlAssignment): Promise<string> {
  if (assignment.protocol !== 'ocpp16') {
    // OpenADR and 2030.5 controls expire at the VTN/utility side and Modbus
    // fallback is enforced by the poller. Claiming to have driven them from here
    // would be a fiction.
    throw new GridCommandError(
      501,
      `no platform-side fallback exists for protocol ${assignment.protocol}; it is enforced at the device`
    );
  }
  const profileId = assignment.commandRef ? Number(assignment.commandRef) : undefined;

  if (assignment.fallbackPolicy === 'resume_local') {
    const cleared = await clearChargingProfile({
      chargePointId: assignment.targetRef,
      chargingProfileId: Number.isFinite(profileId) ? profileId : undefined,
      connectorId: assignment.subTargetRef || undefined,
    });
    return `resume_local: ClearChargingProfile answered ${cleared.status}`;
  }

  const limitWatts = assignment.fallbackLimitWatts;
  if (limitWatts === null) {
    throw new GridCommandError(
      500,
      `assignment ${assignment.id} declares safe_limit but stored no fallback watts`
    );
  }
  const applied = await setFallbackProfile({
    chargePointId: assignment.targetRef,
    connectorId: assignment.subTargetRef || 0,
    limitWatts,
    chargingProfileId: 1,
  });
  return `safe_limit: ${limitWatts}W profile answered ${applied.status}`;
}

let sweepTimer: NodeJS.Timeout | null = null;

/**
 * Starts the periodic sweep. Deliberately opt-in via GRID_CONTROL_SWEEP_MS so a
 * deployment that runs the sweep from a worker does not run it twice.
 */
export function startControlFallbackSweeper(): boolean {
  const raw = process.env.GRID_CONTROL_SWEEP_MS;
  if (!raw) return false;
  const intervalMs = Number(raw);
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    throw new Error('GRID_CONTROL_SWEEP_MS must be at least 1000 milliseconds');
  }
  if (sweepTimer) return true;
  sweepTimer = setInterval(() => {
    void sweepExpiredControls().then(
      summary => {
        if (summary.examined > 0) {
          console.log(
            `[ControlFallback] swept ${summary.examined} expired controls: ` +
              `${summary.applied} fallback applied, ${summary.held} held, ${summary.failed} failed`
          );
          for (const detail of summary.details) {
            console.log(`[ControlFallback] ${detail}`);
          }
        }
      },
      error => console.error('[ControlFallback] sweep failed:', error)
    );
  }, intervalMs);
  sweepTimer.unref?.();
  return true;
}

export function stopControlFallbackSweeper(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
