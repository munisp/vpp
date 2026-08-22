/**
 * Shared vocabulary for price-signal dispatch in the UI.
 *
 * Three separate facts have to stay separate on screen: the price we published,
 * the plan a site returned under it, and what the site's meter actually did.
 * Collapsing them into one "responded" tick would let a broker publish read as
 * a delivered kilowatt-hour, which is the failure this subsystem exists to
 * avoid — sites are paid against the measured column, never the planned one.
 */

export type SignalStatus = 'draft' | 'published' | 'scored' | 'not_converged';
export type SignalDelivery = 'pending' | 'broker_queued' | 'failed';
export type SignalResponse = 'unmeasured' | 'followed' | 'deviated' | 'no_telemetry';
export type SignalTone = 'good' | 'warning' | 'danger' | 'neutral';

export interface SignalCopy {
  label: string;
  tone: SignalTone;
  /** What the reader should understand is actually true. */
  meaning: string;
}

export const SIGNAL_STATUS_COPY: Record<SignalStatus, SignalCopy> = {
  draft: {
    label: 'Solved, not sent',
    tone: 'neutral',
    meaning: 'A price that reaches the grid target exists, but no site has been offered it.',
  },
  published: {
    label: 'Offered to sites',
    tone: 'warning',
    meaning: 'Sites have been sent the price. Following it is voluntary and not yet measured.',
  },
  scored: {
    label: 'Measured',
    tone: 'good',
    meaning: 'The window has closed and each site has been compared with its meter.',
  },
  not_converged: {
    label: 'Missed its own target',
    tone: 'danger',
    meaning:
      'No price was found that moves the fleet to the requested profile, so this signal cannot be published.',
  },
};

export const SIGNAL_DELIVERY_COPY: Record<SignalDelivery, SignalCopy> = {
  pending: {
    label: 'Not sent',
    tone: 'neutral',
    meaning: 'The site has not been offered this price yet.',
  },
  broker_queued: {
    label: 'Sent, receipt unknown',
    tone: 'warning',
    meaning: 'The MQTT broker accepted the message; the site does not acknowledge price signals.',
  },
  failed: {
    label: 'Send failed',
    tone: 'danger',
    meaning: 'The broker refused the message, so this site never saw the price.',
  },
};

export const SIGNAL_RESPONSE_COPY: Record<SignalResponse, SignalCopy> = {
  unmeasured: {
    label: 'Not measured yet',
    tone: 'neutral',
    meaning: 'The window has not closed, so there is nothing to compare against.',
  },
  followed: {
    label: 'Followed',
    tone: 'good',
    meaning: 'Metered energy is within tolerance of the plan the site returned.',
  },
  deviated: {
    label: 'Deviated',
    tone: 'warning',
    meaning: 'Metered energy is outside tolerance: the site ran something other than its plan.',
  },
  no_telemetry: {
    label: 'No telemetry',
    tone: 'danger',
    meaning: 'The window closed with no meter data. This is missing evidence, not compliance.',
  },
};

/** Signed price adjustment, phrased by what it asks the site to do. */
export function describeAdjustment(centsPerKwh: number): { label: string; tone: SignalTone } {
  if (Math.abs(centsPerKwh) < 0.005) {
    return { label: 'No nudge', tone: 'neutral' };
  }
  if (centsPerKwh > 0) {
    return { label: `+${centsPerKwh.toFixed(2)}¢ — use less`, tone: 'warning' };
  }
  return { label: `${centsPerKwh.toFixed(2)}¢ — use more`, tone: 'good' };
}

/** kW with an explicit direction; net import is positive by convention. */
export function formatNetKw(watts: number | null | undefined): string {
  if (watts === null || watts === undefined) return '—';
  const kw = Math.abs(watts) / 1000;
  if (watts === 0) return '0.00 kW';
  return `${kw.toFixed(2)} kW ${watts > 0 ? 'import' : 'export'}`;
}

export function formatNetKwh(wattHours: number | null | undefined): string {
  if (wattHours === null || wattHours === undefined) return '—';
  const kwh = Math.abs(wattHours) / 1000;
  if (wattHours === 0) return '0.00 kWh';
  return `${kwh.toFixed(2)} kWh ${wattHours > 0 ? 'imported' : 'exported'}`;
}

/**
 * How far the fleet's plan sits from what the grid asked for.
 *
 * A plan is the fleet's intent, so this is never presented as delivered energy;
 * `deviated`/`no_telemetry` sites are what turn intent into a shortfall.
 */
export function planVerdict(
  targetNetW: number | null,
  plannedNetW: number
): { label: string; tone: SignalTone; meaning: string } {
  if (targetNetW === null) {
    return {
      label: 'Cap only',
      tone: 'neutral',
      meaning: 'This interval carried a limit, not a target profile.',
    };
  }
  const deviation = plannedNetW - targetNetW;
  const scale = Math.max(Math.abs(targetNetW), 1000);
  const share = Math.abs(deviation) / scale;
  if (share <= 0.02) {
    return {
      label: 'On target',
      tone: 'good',
      meaning: 'The fleet plans to land within 2% of the requested profile.',
    };
  }
  const direction = deviation > 0 ? 'above' : 'below';
  return {
    label: `${(share * 100).toFixed(0)}% ${direction}`,
    tone: share <= 0.1 ? 'warning' : 'danger',
    meaning: `The fleet plans to sit ${formatNetKw(Math.abs(deviation))} ${direction} the requested profile.`,
  };
}

/** Site-level rollup for the operator view. */
export function summariseResponses(
  sites: Array<{ response: SignalResponse; plannedNetWh: number; actualNetWh: number | null }>
): {
  followed: number;
  deviated: number;
  unmeasured: number;
  noTelemetry: number;
  /** Only sites with a meter reading; never plan energy standing in for actuals. */
  measuredPlannedWh: number;
  measuredActualWh: number;
} {
  let followed = 0;
  let deviated = 0;
  let unmeasured = 0;
  let noTelemetry = 0;
  let measuredPlannedWh = 0;
  let measuredActualWh = 0;

  for (const site of sites) {
    if (site.response === 'followed') followed += 1;
    else if (site.response === 'deviated') deviated += 1;
    else if (site.response === 'no_telemetry') noTelemetry += 1;
    else unmeasured += 1;

    if (site.actualNetWh !== null) {
      measuredPlannedWh += site.plannedNetWh;
      measuredActualWh += site.actualNetWh;
    }
  }

  return { followed, deviated, unmeasured, noTelemetry, measuredPlannedWh, measuredActualWh };
}
