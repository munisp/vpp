/**
 * How a reliability figure reads to an operator, a customer and a regulator.
 *
 * These indices used to be absent entirely, with the compliance report standing
 * in `health_checks` uptime for "availability" — an API that answers while every
 * customer sits in the dark scores 100%. So the interesting content here is what
 * a figure does *not* cover: who was measured, who was not, and whether the
 * duration is closed or still running. Defined once so the web and mobile apps
 * cannot word it differently.
 */

export type ReliabilityTone = 'live' | 'good' | 'warning' | 'danger' | 'neutral';

export interface ReliabilityStateCopy {
  label: string;
  tone: ReliabilityTone;
  meaning: string;
}

/** Why the indices are withheld entirely. */
export const RELIABILITY_REASON_COPY: Record<string, ReliabilityStateCopy> = {
  no_service_points_registered: {
    label: 'no connections registered',
    tone: 'warning',
    meaning:
      'No customer connection is registered, so there is no population to average over. This is an empty register, not perfect supply.',
  },
  no_observed_service_points: {
    label: 'nobody observed',
    tone: 'warning',
    meaning:
      'Every registered connection is unmonitored, so no interruption would have been noticed. Silence here carries no information about supply.',
  },
  period_not_started: {
    label: 'period has no duration',
    tone: 'neutral',
    meaning: 'The reporting period is empty, so there are no customer-minutes to average over.',
  },
};

/** How firm the reported figures are. */
export const RELIABILITY_BASIS_COPY: Record<string, ReliabilityStateCopy> = {
  measured: {
    label: 'measured',
    tone: 'good',
    meaning:
      'Every observed connection was supplied for the whole period and every interruption counted is closed with restoration evidence.',
  },
  lower_bound: {
    label: 'lower bound',
    tone: 'warning',
    meaning:
      'An interruption is still in progress, or a connection was supplied for only part of the period. The real outage duration is at least this — never less.',
  },
};

export const MONITORING_COPY: Record<string, ReliabilityStateCopy> = {
  metered_telemetry: {
    label: 'metered',
    tone: 'good',
    meaning: 'A meter reports on a declared interval, so a loss of supply shows up as a gap or a meter event.',
  },
  reported_only: {
    label: 'reported',
    tone: 'live',
    meaning:
      'Outages are recorded when an operator or the customer reports them. Nothing detects an outage nobody reports.',
  },
  unmonitored: {
    label: 'unmonitored',
    tone: 'warning',
    meaning:
      "Nobody measures this connection's supply. It is excluded from the indices rather than counted as a customer with no interruptions.",
  },
};

export const INTERRUPTION_CAUSE_LABEL: Record<string, string> = {
  utility_grid_outage: 'Utility grid outage',
  generation_shortfall: 'Generation shortfall',
  storage_depleted: 'Storage depleted',
  equipment_fault: 'Equipment fault',
  planned_maintenance: 'Planned maintenance',
  load_shedding: 'Load shedding',
  payment_disconnection: 'Payment disconnection',
  unknown: 'Cause not established',
};

export const DETECTION_SOURCE_COPY: Record<string, ReliabilityStateCopy> = {
  meter_event: {
    label: 'meter event',
    tone: 'good',
    meaning: 'The meter itself reported the loss and the return of supply.',
  },
  telemetry_gap: {
    label: 'meter went silent',
    tone: 'warning',
    meaning:
      'Inferred from the meter missing several reporting intervals. A communications failure looks identical from here, so this is evidence of silence rather than a measured outage.',
  },
  device_offline_event: {
    label: 'device offline',
    tone: 'warning',
    meaning: 'A device on the connection announced that it had lost supply.',
  },
  operator_declared: {
    label: 'operator declared',
    tone: 'live',
    meaning: 'An operator recorded the interruption against named evidence.',
  },
  customer_reported: {
    label: 'customer reported',
    tone: 'live',
    meaning: 'The customer reported the outage; its start and end are as reported, not as metered.',
  },
};

export const INDEX_MEANING: Record<string, string> = {
  saifi: 'Sustained interruptions the average observed customer experienced in the period (IEEE 1366 SAIFI).',
  saidi: 'Minutes the average observed customer spent without supply (SAIDI).',
  caidi: 'Average length of one sustained interruption, for the customers that had one (CAIDI).',
  asai: 'Share of customer-minutes actually supplied (ASAI). This is customer power, not platform uptime.',
  maifi: 'Momentary interruptions — shorter than five minutes — per observed customer (MAIFI).',
  interrupted: 'Share of observed customers that lost supply at least once.',
};

export function reliabilityBasisCopy(basis: string | null): ReliabilityStateCopy {
  if (basis === null) {
    return {
      label: 'withheld',
      tone: 'neutral',
      meaning: 'No index is reported, because the evidence to compute one is not there.',
    };
  }
  return (
    RELIABILITY_BASIS_COPY[basis] ?? {
      label: basis,
      tone: 'neutral',
      meaning: 'Unrecognised basis.',
    }
  );
}

export function reliabilityReasonCopy(reason: string | null): ReliabilityStateCopy | null {
  if (reason === null) return null;
  return (
    RELIABILITY_REASON_COPY[reason] ?? {
      label: reason,
      tone: 'warning',
      meaning: 'The indices are withheld for a reason this app does not have wording for.',
    }
  );
}

/** A number, or the em dash that means "not reported" — never a zero standing in. */
export function indexValue(value: number | null, places = 2): string | null {
  return value === null ? null : value.toFixed(places);
}

export function percentValue(fraction: number | null, places = 3): string | null {
  return fraction === null ? null : (fraction * 100).toFixed(places);
}

export function coverageSummary(coverage: {
  registeredServicePoints: number;
  observedServicePoints: number;
}): string {
  return `${coverage.observedServicePoints} of ${coverage.registeredServicePoints} registered connections observed`;
}
