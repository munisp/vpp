/**
 * IEEE 1366 customer reliability indices, computed only where the evidence to
 * compute them exists.
 *
 * The indices themselves are arithmetic; the difficulty is entirely in what
 * counts. Three ways to produce a flattering number, all refused here:
 *
 *  1. Averaging over customers whose supply nobody watches. An unmonitored
 *     connection contributes no interruptions because nothing would have
 *     noticed one, so including it in the denominator dilutes every index by
 *     however much of the fleet is unobserved. The population is therefore the
 *     *observed* customers, and the unobserved ones are reported as coverage.
 *  2. Counting an interruption still in progress as a short one. An open row is
 *     clamped at the end of the period and the result marked as a lower bound.
 *  3. Reporting an index for a period nothing was recorded in. Zero recorded
 *     interruptions over zero observed customers is not perfect supply, and
 *     comes back null with a reason.
 *
 * Momentary interruptions (shorter than `MOMENTARY_THRESHOLD_MINUTES`) are
 * counted in MAIFI and excluded from SAIFI/SAIDI, as 1366 requires — otherwise
 * a flapping meter reads as a fleet in permanent collapse.
 */

/** 1366 sustained/momentary boundary: five minutes. */
export const MOMENTARY_THRESHOLD_MINUTES = 5;

export type ReliabilityReason =
  | 'no_service_points_registered'
  | 'no_observed_service_points'
  | 'period_not_started';

/** A connection as registered, for the period being reported. */
export interface ServicePointExposure {
  servicePointId: number;
  pointClass: string;
  /** False for `unmonitored` connections: silence carries no information. */
  observed: boolean;
  /** Start of supply, clamped into the period by the caller. */
  connectedAt: Date;
  disconnectedAt: Date | null;
}

/** One recorded loss of supply. `endedAt` null means still out. */
export interface InterruptionRecord {
  id: number;
  servicePointId: number;
  startedAt: Date;
  endedAt: Date | null;
  cause: string;
  detectionSource: string;
  excludeFromIndices: boolean;
}

export interface ReliabilityPeriod {
  start: Date;
  /** Exclusive. Usually now() for an in-progress period. */
  end: Date;
}

export interface ReliabilityIndices {
  /** Sustained interruptions per observed customer. */
  saifi: number | null;
  /** Sustained interruption minutes per observed customer. */
  saidiMinutes: number | null;
  /** Average minutes per sustained interruption experienced. */
  caidiMinutes: number | null;
  /** Fraction of customer-minutes supplied, 0–1. */
  asai: number | null;
  /** Momentary interruptions per observed customer. */
  maifi: number | null;
  /** Share of observed customers that saw at least one interruption. */
  customersInterruptedFraction: number | null;
}

export interface ReliabilityAssessment {
  period: ReliabilityPeriod;
  indices: ReliabilityIndices;
  /** Null while the indices are withheld. */
  reason: ReliabilityReason | null;
  /**
   * `measured` when every observed customer was observed for the whole period
   * and every interruption is closed; `lower_bound` when an interruption is
   * still open or a connection joined mid-period, so the true figure is worse.
   */
  basis: 'measured' | 'lower_bound' | null;
  coverage: {
    registeredServicePoints: number;
    observedServicePoints: number;
    unobservedServicePoints: number;
    /** Customer-minutes of exposure the indices are averaged over. */
    observedCustomerMinutes: number;
    /** Interruptions still in progress at the end of the period. */
    openInterruptions: number;
    /** Rows excluded under 1366's exceptional-day rule, reported separately. */
    excludedInterruptions: number;
    excludedInterruptionMinutes: number;
  };
  counts: {
    sustainedInterruptions: number;
    momentaryInterruptions: number;
    customersInterrupted: number;
    sustainedMinutes: number;
  };
  byCause: Array<{ cause: string; interruptions: number; minutes: number }>;
  byDetectionSource: Array<{ detectionSource: string; interruptions: number }>;
  /** Plain statements of what the figures above do not cover. */
  limitations: string[];
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function overlapMinutes(
  fromA: Date,
  toA: Date | null,
  period: ReliabilityPeriod
): { minutes: number; clamped: boolean } {
  const start = Math.max(fromA.getTime(), period.start.getTime());
  const rawEnd = toA === null ? period.end.getTime() : toA.getTime();
  const end = Math.min(rawEnd, period.end.getTime());
  if (end <= start) return { minutes: 0, clamped: false };
  return {
    minutes: (end - start) / 60_000,
    clamped: toA === null || toA.getTime() > period.end.getTime(),
  };
}

/**
 * Computes the indices for one period from the exposure of every registered
 * connection and every interruption recorded against them.
 */
export function assessReliability(input: {
  period: ReliabilityPeriod;
  servicePoints: ServicePointExposure[];
  interruptions: InterruptionRecord[];
}): ReliabilityAssessment {
  const { period, servicePoints, interruptions } = input;
  const observed = servicePoints.filter((point) => point.observed);
  const observedIds = new Set(observed.map((point) => point.servicePointId));

  const excluded = interruptions.filter((row) => row.excludeFromIndices);
  const excludedMinutes = excluded.reduce(
    (sum, row) => sum + overlapMinutes(row.startedAt, row.endedAt, period).minutes,
    0
  );

  const empty: ReliabilityAssessment = {
    period,
    indices: {
      saifi: null,
      saidiMinutes: null,
      caidiMinutes: null,
      asai: null,
      maifi: null,
      customersInterruptedFraction: null,
    },
    reason: null,
    basis: null,
    coverage: {
      registeredServicePoints: servicePoints.length,
      observedServicePoints: observed.length,
      unobservedServicePoints: servicePoints.length - observed.length,
      observedCustomerMinutes: 0,
      openInterruptions: interruptions.filter((row) => row.endedAt === null).length,
      excludedInterruptions: excluded.length,
      excludedInterruptionMinutes: round(excludedMinutes, 1),
    },
    counts: {
      sustainedInterruptions: 0,
      momentaryInterruptions: 0,
      customersInterrupted: 0,
      sustainedMinutes: 0,
    },
    byCause: [],
    byDetectionSource: [],
    limitations: [],
  };

  if (period.end <= period.start) {
    return { ...empty, reason: 'period_not_started', limitations: [LIMITATIONS.period_not_started] };
  }
  if (servicePoints.length === 0) {
    return {
      ...empty,
      reason: 'no_service_points_registered',
      limitations: [LIMITATIONS.no_service_points_registered],
    };
  }

  // Exposure: customer-minutes an observed connection was actually connected
  // inside the period. A meter installed last week cannot carry a month.
  let observedCustomerMinutes = 0;
  let partialExposure = false;
  const periodMinutes = (period.end.getTime() - period.start.getTime()) / 60_000;
  for (const point of observed) {
    const { minutes } = overlapMinutes(point.connectedAt, point.disconnectedAt, period);
    observedCustomerMinutes += minutes;
    if (minutes < periodMinutes - 1) partialExposure = true;
  }

  if (observed.length === 0 || observedCustomerMinutes === 0) {
    return {
      ...empty,
      reason: 'no_observed_service_points',
      limitations: [
        LIMITATIONS.no_observed_service_points,
        ...(servicePoints.length > observed.length
          ? [unobservedLimitation(servicePoints.length - observed.length, servicePoints.length)]
          : []),
      ],
    };
  }

  const counted = interruptions.filter(
    (row) => !row.excludeFromIndices && observedIds.has(row.servicePointId)
  );

  let sustainedCount = 0;
  let momentaryCount = 0;
  let sustainedMinutes = 0;
  let openCount = 0;
  const interruptedCustomers = new Set<number>();
  const causeTotals = new Map<string, { interruptions: number; minutes: number }>();
  const sourceTotals = new Map<string, number>();

  for (const row of counted) {
    const { minutes, clamped } = overlapMinutes(row.startedAt, row.endedAt, period);
    if (minutes === 0) continue;
    if (row.endedAt === null || clamped) openCount += 1;

    if (minutes < MOMENTARY_THRESHOLD_MINUTES) {
      momentaryCount += 1;
    } else {
      sustainedCount += 1;
      sustainedMinutes += minutes;
      interruptedCustomers.add(row.servicePointId);
    }

    const cause = causeTotals.get(row.cause) ?? { interruptions: 0, minutes: 0 };
    causeTotals.set(row.cause, {
      interruptions: cause.interruptions + 1,
      minutes: cause.minutes + minutes,
    });
    sourceTotals.set(row.detectionSource, (sourceTotals.get(row.detectionSource) ?? 0) + 1);
  }

  const saifi = sustainedCount / observed.length;
  const saidi = sustainedMinutes / observed.length;
  const limitations: string[] = [];
  if (servicePoints.length > observed.length) {
    limitations.push(unobservedLimitation(servicePoints.length - observed.length, servicePoints.length));
  }
  if (openCount > 0) limitations.push(LIMITATIONS.open_interruptions);
  if (partialExposure) limitations.push(LIMITATIONS.partial_exposure);
  if (excluded.length > 0) limitations.push(LIMITATIONS.excluded_interruptions);
  if (sourceTotals.has('telemetry_gap')) limitations.push(LIMITATIONS.telemetry_gap_evidence);

  return {
    period,
    indices: {
      saifi: round(saifi, 4),
      saidiMinutes: round(saidi, 2),
      caidiMinutes: sustainedCount > 0 ? round(sustainedMinutes / sustainedCount, 2) : null,
      asai: round(
        Math.max(0, (observedCustomerMinutes - sustainedMinutes) / observedCustomerMinutes),
        6
      ),
      maifi: round(momentaryCount / observed.length, 4),
      customersInterruptedFraction: round(interruptedCustomers.size / observed.length, 4),
    },
    reason: null,
    basis: openCount > 0 || partialExposure ? 'lower_bound' : 'measured',
    coverage: {
      registeredServicePoints: servicePoints.length,
      observedServicePoints: observed.length,
      unobservedServicePoints: servicePoints.length - observed.length,
      observedCustomerMinutes: round(observedCustomerMinutes, 1),
      openInterruptions: openCount,
      excludedInterruptions: excluded.length,
      excludedInterruptionMinutes: round(excludedMinutes, 1),
    },
    counts: {
      sustainedInterruptions: sustainedCount,
      momentaryInterruptions: momentaryCount,
      customersInterrupted: interruptedCustomers.size,
      sustainedMinutes: round(sustainedMinutes, 1),
    },
    byCause: Array.from(causeTotals.entries())
      .map(([cause, totals]) => ({
        cause,
        interruptions: totals.interruptions,
        minutes: round(totals.minutes, 1),
      }))
      .sort((a, b) => b.minutes - a.minutes),
    byDetectionSource: Array.from(sourceTotals.entries())
      .map(([detectionSource, interruptions]) => ({ detectionSource, interruptions }))
      .sort((a, b) => b.interruptions - a.interruptions),
    limitations,
  };
}

const LIMITATIONS = {
  period_not_started: 'The reporting period has no duration, so nothing can be averaged over it',
  no_service_points_registered:
    'No customer connection is registered, so there is no population to average over — this is an empty register, not perfect supply',
  no_observed_service_points:
    'No registered connection is observed (metered or reported), so the absence of recorded interruptions carries no information about supply',
  open_interruptions:
    'An interruption was still in progress at the end of the period and is counted only up to the period end, so the reported duration is a lower bound',
  partial_exposure:
    'A connection was supplied for only part of the period, so its exposure is counted pro rata rather than as a full period',
  excluded_interruptions:
    "Interruptions marked as exceptional days under IEEE 1366 are reported separately and are not in the indices above",
  telemetry_gap_evidence:
    'Some interruptions were inferred from a gap in meter reporting: a meter that stopped communicating for another reason would look the same',
} as const;

function unobservedLimitation(unobserved: number, total: number): string {
  return `${unobserved} of ${total} registered connections are unmonitored and are excluded from the indices — they are customers whose supply nobody measures, not customers with uninterrupted supply`;
}

export const RELIABILITY_LIMITATIONS = LIMITATIONS;
