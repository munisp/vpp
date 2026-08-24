/**
 * One vocabulary for network feasibility, shared by the PWA and the mobile app.
 *
 * The distinction that matters here is between "the network was checked and it
 * holds" and "the network was not checked". Only the first is `feasible`; the
 * rest are reasons nobody has been told the answer yet, and they must never be
 * rendered as an all-clear, because a dispatch or an award that rode out on an
 * unchecked network is a promise made on a feeder nobody studied.
 */

export type FeasibilityStatus =
  | 'feasible'
  | 'violations'
  | 'model_unavailable'
  | 'not_converged'
  | 'service_unavailable';

export type Tone = 'good' | 'warning' | 'bad' | 'neutral';

export interface StatusCopy {
  label: string;
  tone: Tone;
  /** What a reader may conclude — and, when unchecked, what they may not. */
  meaning: string;
}

export const FEASIBILITY_STATUS_COPY: Record<FeasibilityStatus, StatusCopy> = {
  feasible: {
    label: 'Within limits',
    tone: 'good',
    meaning:
      'The solver ran on the recorded electrical model and every bus voltage and element loading stayed inside its limit.',
  },
  violations: {
    label: 'Over a limit',
    tone: 'bad',
    meaning:
      'The solver ran and at least one element is past its own rating. Dispatch is refused and awards that cause it are refused, naming the element.',
  },
  model_unavailable: {
    label: 'Not modelled',
    tone: 'warning',
    meaning:
      'There is no usable electrical model for this node — no nominal voltage, no source, no branch, or no fresh measurement to build a base case from. Nothing was checked.',
  },
  not_converged: {
    label: 'No solution',
    tone: 'warning',
    meaning:
      'The power flow did not converge, so the network state is unknown. This is not a pass.',
  },
  service_unavailable: {
    label: 'Engine unreachable',
    tone: 'warning',
    meaning:
      'The feasibility engine could not be reached or refused the request, so nothing was checked. Work cleared in this state is stamped unchecked, not approved.',
  },
};

export const VIOLATION_KIND_LABEL: Record<string, string> = {
  bus_undervoltage: 'Voltage below band',
  bus_overvoltage: 'Voltage above band',
  line_loading: 'Line thermal loading',
  transformer_loading: 'Transformer loading',
};

export function violationKindLabel(kind: string): string {
  return VIOLATION_KIND_LABEL[kind] ?? kind;
}

/** True only for the one status that means the network was actually checked. */
export function isNetworkChecked(status: FeasibilityStatus | null | undefined): boolean {
  return status === 'feasible';
}

/**
 * The sentence to show beside a dispatch or an award carrying this status.
 * Deliberately never returns an empty string for an unchecked status.
 */
export function networkCheckCaveat(status: FeasibilityStatus | null | undefined): string | null {
  if (status === undefined || status === null) {
    return 'No network check was recorded for this: treat it as unchecked.';
  }
  if (status === 'feasible') return null;
  return `Network-unchecked (${FEASIBILITY_STATUS_COPY[status].label.toLowerCase()}): ${
    FEASIBILITY_STATUS_COPY[status].meaning
  }`;
}

/** kW at one decimal, or a dash — never a zero standing in for no answer. */
export function wattsLabel(watts: number | null | undefined): string {
  if (watts === null || watts === undefined || !Number.isFinite(watts)) return '—';
  return `${(watts / 1000).toFixed(1)} kW`;
}
