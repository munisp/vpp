/**
 * How a resilience state reads to an operator, a resident and an inspector.
 *
 * The figures this describes replaced two invented ones — autonomy from "assume
 * a 2-hour battery", critical service from "generation exceeds half of load" —
 * so the interesting part of every screen is the *reason a number is absent*.
 * Those reasons are survey and registration tasks with names, and they live here
 * once so the web app and the mobile app cannot describe them differently.
 */

export type Tone = 'live' | 'good' | 'warning' | 'danger' | 'neutral';

export interface StateCopy {
  label: string;
  tone: Tone;
  meaning: string;
}

/** Why no ride-through figure could be produced. */
export const AUTONOMY_REASON_COPY: Record<string, StateCopy> = {
  no_storage_registered: {
    label: 'no storage',
    tone: 'neutral',
    meaning:
      'No battery is registered against this community, so there is nothing to ride through an outage on.',
  },
  storage_capacity_unregistered: {
    label: 'capacity unregistered',
    tone: 'warning',
    meaning:
      'A battery exists but its energy capacity (Wh) has never been registered. Autonomy cannot be computed from an unknown pack size, and is not guessed.',
  },
  storage_state_of_charge_unavailable: {
    label: 'state of charge stale',
    tone: 'warning',
    meaning:
      'No battery has reported a state of charge recently, so how full the pack is right now is unknown.',
  },
  storage_usable_floor_unregistered: {
    label: 'usable floor unregistered',
    tone: 'warning',
    meaning:
      'No minimum state of charge has been registered for the battery, so how much of the pack may actually be drawn down is unknown. Treating the whole pack as usable would overstate ride-through by whatever the real reserve is.',
  },
  load_unmeasured: {
    label: 'demand unmeasured',
    tone: 'warning',
    meaning:
      'Community demand is not being measured, so the drain storage would have to cover is unknown.',
  },
  load_covered_by_generation: {
    label: 'generation covers demand',
    tone: 'good',
    meaning:
      'Local generation currently exceeds demand, so storage is not discharging and a ride-through duration would be meaningless.',
  },
};

/** Why critical-load coverage could not be judged. */
export const CRITICAL_SERVICE_REASON_COPY: Record<string, StateCopy> = {
  no_critical_loads_registered: {
    label: 'register empty',
    tone: 'warning',
    meaning:
      'Nothing has been declared critical for this community. Coverage is unknown, not satisfied — an empty register is a survey that has not happened.',
  },
  critical_load_demand_unknown: {
    label: 'demand unknown',
    tone: 'warning',
    meaning:
      'The declared loads carry no usable rating or reading, so their combined demand is unknown.',
  },
  storage_discharge_limit_unregistered: {
    label: 'discharge limit unregistered',
    tone: 'warning',
    meaning:
      "A battery's maximum discharge power has never been registered, so how much of the critical demand it could carry is unknown.",
  },
  storage_supply_unassessable: {
    label: 'storage unassessable',
    tone: 'warning',
    meaning:
      'A registered battery could not be assessed, so the supply counted here is a lower bound and whether critical loads fall short is unknown rather than known to be false.',
  },
  generation_unmeasured: {
    label: 'generation unmeasured',
    tone: 'warning',
    meaning:
      'No asset has reported generation recently, so the supply available to critical loads is unknown.',
  },
};

/** What a critical-service verdict means, including the withheld one. */
export function criticalServiceCopy(served: boolean | null, reason: string | null): StateCopy {
  if (served === true) {
    return {
      label: 'critical loads covered',
      tone: 'good',
      meaning:
        'Measured generation plus registered discharge capability covers every active declared critical load.',
    };
  }
  if (served === false) {
    return {
      label: 'critical loads not covered',
      tone: 'danger',
      meaning:
        'Declared critical demand exceeds the supply available. Islanding is refused in this state.',
    };
  }
  const withheld = reason ? CRITICAL_SERVICE_REASON_COPY[reason] : undefined;
  return {
    label: withheld ? `unknown — ${withheld.label}` : 'unknown',
    tone: 'warning',
    meaning:
      withheld?.meaning ??
      'Critical-load coverage could not be assessed from the evidence available.',
  };
}

/** What a demand figure is actually based on. */
export const DEMAND_SOURCE_COPY: Record<string, StateCopy> = {
  metered: {
    label: 'metered',
    tone: 'live',
    meaning: 'Every declared load has a recent reading from its own asset.',
  },
  declared: {
    label: 'declared',
    tone: 'warning',
    meaning:
      'No declared load is metered; demand is the sum of registered ratings, which is a design figure rather than a measurement.',
  },
  mixed: {
    label: 'part metered',
    tone: 'warning',
    meaning: 'Some declared loads are metered and the rest contribute their registered rating.',
  },
};

/** How a rated power was arrived at, which is how far it can be trusted. */
export const RATING_SOURCE_COPY: Record<string, StateCopy> = {
  nameplate: {
    label: 'nameplate',
    tone: 'good',
    meaning: "Taken from the equipment's own rating plate.",
  },
  commissioning_measurement: {
    label: 'measured at commissioning',
    tone: 'live',
    meaning: 'Measured on site when the load was commissioned.',
  },
  operator_estimate: {
    label: 'operator estimate',
    tone: 'warning',
    meaning:
      'An operator estimated this load: it was not read off a plate or measured, so the resilience figures built on it are provisional.',
  },
};

export const CRITICAL_LOAD_CATEGORY_LABEL: Record<string, string> = {
  health: 'Health',
  water: 'Water',
  education: 'Education',
  communications: 'Communications',
  security: 'Security',
  cold_chain: 'Cold chain',
  agriculture: 'Agriculture',
  residential: 'Residential',
  commercial: 'Commercial',
  other: 'Other',
};

/** Autonomy as a state, never as a bare number that hides its basis. */
export function autonomyCopy(
  hours: number | null,
  basis: 'measured' | 'partial' | null,
  reason: string | null
): StateCopy {
  if (hours === null) {
    const withheld = reason ? AUTONOMY_REASON_COPY[reason] : undefined;
    return {
      label: withheld?.label ?? 'unknown',
      tone: withheld?.tone ?? 'warning',
      meaning:
        withheld?.meaning ?? 'Ride-through could not be computed from the evidence available.',
    };
  }
  if (basis === 'partial') {
    return {
      label: 'lower bound',
      tone: 'warning',
      meaning:
        'Some registered batteries could not be assessed, so the real ride-through is at least this long and possibly longer.',
    };
  }
  return {
    label: 'measured',
    tone: 'good',
    meaning:
      'Computed from registered pack energy, the usable floor and the last reported state of charge, against measured net drain.',
  };
}

/** Hours to one decimal, or null so the caller renders it as unknown. */
export function hoursLabel(hours: number | null): string | null {
  return hours === null ? null : hours.toFixed(1);
}

/** Watts as kW, or null so the caller renders it as unknown. */
export function wattsAsKwLabel(watts: number | null): string | null {
  return watts === null ? null : (watts / 1000).toFixed(2);
}
