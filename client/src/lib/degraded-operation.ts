/**
 * Shared vocabulary for degraded operation in the UI.
 *
 * The failure this screen exists to prevent is a calm dashboard: green tiles for
 * dependencies nobody has called in an hour. So `unknown` is never drawn as
 * healthy, and it is never drawn as an outage either — an operator has to be able
 * to tell "we know it is broken" from "we have no idea", because the second one
 * is also what a stalled worker looks like.
 *
 * Used by the web PWA and the React Native app so both say the same thing about
 * the same state.
 */

export type DependencyState = 'up' | 'down' | 'unknown';
export type Observation = 'reachable' | 'unreachable' | 'faulted';
export type CapabilityPosture = 'available' | 'degraded' | 'refused';
export type StateTone = 'good' | 'warning' | 'danger' | 'neutral';

export interface DependencyPosture {
  dependency: string;
  state: DependencyState;
  lastObservation: {
    observation: Observation;
    observedBy: string;
    operation: string;
    observedAt: string | Date;
    detail: string | null;
  } | null;
  outage: {
    startedAt: string | Date;
    failureCount: number;
    lastDetail: string | null;
  } | null;
  stalenessSeconds: number;
  reason: string;
}

export interface CapabilityStatus {
  capability: string;
  requires: string[];
  missing: string[];
  posture: CapabilityPosture;
  evidenceLimit: string | null;
  reason: string;
}

export interface DegradedAction {
  id: number;
  capability: string;
  subject: string;
  missingDependencies: string[];
  evidenceLimit: string;
  actedAt: string | Date;
  reconciledAt: string | Date | null;
  reconciliationNote: string | null;
}

export const DEPENDENCY_LABELS: Record<string, string> = {
  optimizer: 'Dispatch optimizer',
  mqtt_broker: 'MQTT broker',
  grid_protocols: 'Grid protocol service',
  matter_controller: 'Matter controller',
  payment_gateway: 'Payment gateway',
  market_broker: 'Market broker',
  meter_telemetry: 'Meter telemetry',
};

export function dependencyLabel(dependency: string): string {
  return DEPENDENCY_LABELS[dependency] ?? dependency;
}

export const CAPABILITY_LABELS: Record<string, string> = {
  market_bid: 'Place a market bid',
  settlement_payout: 'Pay a member out',
  flexibility_settlement: 'Settle flexibility delivery',
  metered_settlement: 'Settle metered delivery',
  optimizer_dispatch: 'Optimize a dispatch plan',
  price_signal_publish: 'Publish a price signal',
  control_dispatch: 'Dispatch a control',
  matter_command: 'Command a smart-home load',
};

export function capabilityLabel(capability: string): string {
  return CAPABILITY_LABELS[capability] ?? capability;
}

export const STATE_COPY: Record<DependencyState, { label: string; tone: StateTone; meaning: string }> =
  {
    up: {
      label: 'Answering',
      tone: 'good',
      meaning: 'A real call to this dependency succeeded recently. Not a health probe: actual work.',
    },
    down: {
      label: 'Outage open',
      tone: 'danger',
      meaning:
        'Consecutive calls failed, so an outage is open. It closes when a call to it succeeds, not on a timer.',
    },
    unknown: {
      label: 'Unobserved',
      tone: 'warning',
      meaning:
        'Nothing recent was recorded, so the platform does not know whether this works. Unobserved blocks the same paths an outage does — silence is not health.',
    },
  };

export const POSTURE_COPY: Record<
  CapabilityPosture,
  { label: string; tone: StateTone; meaning: string }
> = {
  available: {
    label: 'Available',
    tone: 'good',
    meaning: 'Every dependency this needs was observed working.',
  },
  degraded: {
    label: 'Degraded',
    tone: 'warning',
    meaning:
      'Allowed to run without its usual evidence because stopping is less safe than continuing. Each such action is filed for reconciliation.',
  },
  refused: {
    label: 'Refused',
    tone: 'danger',
    meaning:
      'Blocked until the evidence is back. A result produced now would look like the real thing without being it.',
  },
};

export const OBSERVATION_COPY: Record<Observation, { label: string; meaning: string }> = {
  reachable: { label: 'Answered', meaning: 'The dependency completed the call.' },
  unreachable: {
    label: 'Unreachable',
    meaning: 'The call never got an answer: transport failure, timeout or no endpoint.',
  },
  faulted: {
    label: 'Faulted',
    meaning: 'The dependency answered and refused or returned something unusable.',
  },
};

/** Seconds since a timestamp, or null when there is none. */
export function ageSeconds(at: string | Date | null | undefined, now: Date = new Date()): number | null {
  if (!at) return null;
  const when = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(when.getTime())) return null;
  return Math.max(0, Math.round((now.getTime() - when.getTime()) / 1000));
}

/** A duration an operator reads at a glance. Never rounds a stale age down to "now". */
export function formatAge(seconds: number | null): string {
  if (seconds === null) return 'never';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * How long past its staleness bound an observation is, as a fraction. Above 1 the
 * observation no longer supports an `up` reading.
 */
export function stalenessRatio(
  posture: DependencyPosture,
  now: Date = new Date()
): number | null {
  const age = ageSeconds(posture.lastObservation?.observedAt ?? null, now);
  if (age === null || posture.stalenessSeconds <= 0) return null;
  return age / posture.stalenessSeconds;
}

export interface PostureSummary {
  dependencies: number;
  up: number;
  down: number;
  unknown: number;
  /** Capabilities the platform is currently refusing outright. */
  refused: number;
  degraded: number;
  /** True when anything money- or market-facing is refused. */
  moneyPathsBlocked: boolean;
}

/** Capabilities that move money or commit the platform to an outside party. */
export const BINDING_CAPABILITIES = [
  'market_bid',
  'settlement_payout',
  'flexibility_settlement',
  'metered_settlement',
  'price_signal_publish',
];

export function summarisePosture(
  dependencies: DependencyPosture[],
  capabilities: CapabilityStatus[]
): PostureSummary {
  const summary: PostureSummary = {
    dependencies: dependencies.length,
    up: 0,
    down: 0,
    unknown: 0,
    refused: 0,
    degraded: 0,
    moneyPathsBlocked: false,
  };

  for (const posture of dependencies) {
    if (posture.state === 'up') summary.up += 1;
    else if (posture.state === 'down') summary.down += 1;
    else summary.unknown += 1;
  }

  for (const capability of capabilities) {
    if (capability.posture === 'refused') {
      summary.refused += 1;
      if (BINDING_CAPABILITIES.includes(capability.capability)) summary.moneyPathsBlocked = true;
    } else if (capability.posture === 'degraded') {
      summary.degraded += 1;
    }
  }

  return summary;
}

/**
 * One line for the top of the screen.
 *
 * Deliberately leads with what the platform will not do, rather than a count of
 * what is healthy: the refusals are the operational consequence.
 */
export function postureHeadline(summary: PostureSummary): { text: string; tone: StateTone } {
  if (summary.refused > 0) {
    return {
      text: summary.moneyPathsBlocked
        ? `${summary.refused} capabilities refused, including money movement`
        : `${summary.refused} capabilities refused`,
      tone: 'danger',
    };
  }
  if (summary.degraded > 0) {
    return {
      text: `${summary.degraded} capabilities running without their usual evidence`,
      tone: 'warning',
    };
  }
  if (summary.unknown > 0) {
    return {
      text: `${summary.unknown} dependencies unobserved, nothing refused yet`,
      tone: 'warning',
    };
  }
  return { text: 'Every dependency answered a real call recently', tone: 'good' };
}

/**
 * Member-facing sentence for a capability that touches what someone gets paid or
 * whether their asset is being controlled. Says what the platform cannot
 * currently tell them, instead of a reassuring blank.
 */
export function memberNotice(
  posture: CapabilityPosture,
  limitation: string | null
): string | null {
  if (posture === 'available') return null;
  if (posture === 'refused') {
    return `Paused: ${limitation ?? 'the platform cannot verify this right now, so it is not being recorded.'}`;
  }
  return `Unverified: ${limitation ?? 'this ran without the usual confirmation and is being followed up.'}`;
}
