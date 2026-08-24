/**
 * Microgrid resilience: how long a community can run islanded, and whether the
 * loads that matter stay energised while it does.
 *
 * Every number here is derived from something registered or measured:
 *
 *   - usable stored energy comes from each battery's registered capacity (Wh),
 *     its last measured state of charge and its registered minimum state of
 *     charge — not from a power rating multiplied by an assumed duration;
 *   - critical demand comes from the community's critical-load register, using
 *     the metered draw where the load is metered and the declared rating where
 *     it is not, and saying which;
 *   - discharge headroom comes from each battery's registered export limit.
 *
 * When an input is missing the result is `null` with a reason, never a default.
 * An unknown autonomy is a survey task; an autonomy of "4.0 hours" invented from
 * a nameplate the platform never saw is a false promise to whoever is relying on
 * that clinic staying lit.
 */

/** Telemetry older than this is not evidence of the present state. */
export const RESILIENCE_TELEMETRY_STALENESS_MINUTES = 15;

/** State of charge is stored as percentage × 100. */
const SOC_SCALE = 100;

export type StorageReason =
  | 'no_storage_registered'
  | 'storage_capacity_unregistered'
  | 'storage_state_of_charge_unavailable'
  | 'storage_usable_floor_unregistered';

export type AutonomyReason =
  | StorageReason
  | 'load_unmeasured'
  | 'load_covered_by_generation';

export type CriticalServiceReason =
  | 'no_critical_loads_registered'
  | 'critical_load_demand_unknown'
  | 'storage_discharge_limit_unregistered'
  | 'storage_supply_unassessable'
  | 'generation_unmeasured';

/** A battery as the platform has it registered plus its last reading. */
export interface StorageAssetState {
  assetId: number;
  name: string;
  /** Registered nameplate energy in watt-hours (`assets.capacity`). */
  energyCapacityWh: number | null;
  /** Last measured state of charge, percentage × 100. */
  stateOfChargeRaw: number | null;
  /** Registered usable floor, percentage × 100 (`der_capabilities.min_soc`). */
  minStateOfChargeRaw: number | null;
  /** Registered discharge limit in watts (`der_capabilities.max_power_export`). */
  maxDischargePowerW: number | null;
  observedAt: Date | null;
}

/** A declared critical load, with its metered draw when it has one. */
export interface CriticalLoadState {
  id: number;
  label: string;
  category: string;
  priority: number;
  ratedPowerW: number;
  ratingSource: string;
  autonomyTargetHours: number | null;
  assetId: number | null;
  /** Metered draw in watts, when the load's asset reported recently. */
  measuredPowerW: number | null;
  measuredAt: Date | null;
}

export interface ResilienceInput {
  /** Measured generation across the community, kW (never negative). */
  totalGenerationKw: number | null;
  /** Measured demand across the community, kW (never negative). */
  totalLoadKw: number | null;
  storage: StorageAssetState[];
  criticalLoads: CriticalLoadState[];
}

export interface StorageAssessment {
  /** Energy above the usable floor, watt-hours. Null when nothing is known. */
  usableEnergyWh: number | null;
  /** Registered energy across batteries that could be assessed, watt-hours. */
  registeredEnergyWh: number | null;
  /** True when every registered battery contributed. */
  complete: boolean;
  registeredBatteries: number;
  assessedBatteries: number;
  batteriesMissingCapacity: number[];
  batteriesMissingStateOfCharge: number[];
  batteriesMissingDischargeLimit: number[];
  /** Batteries with no registered minimum state of charge. */
  batteriesMissingUsableFloor: number[];
  reason: StorageReason | null;
}

export interface AutonomyAssessment {
  hours: number | null;
  /** `measured` when every battery contributed; `partial` when some could not. */
  basis: 'measured' | 'partial' | null;
  netDrainKw: number | null;
  reason: AutonomyReason | null;
}

export interface CriticalServiceAssessment {
  served: boolean | null;
  reason: CriticalServiceReason | null;
  demandKw: number | null;
  /** Where the demand figure came from across the register. */
  demandSource: 'metered' | 'declared' | 'mixed' | null;
  availableSupplyKw: number | null;
  unservedKw: number | null;
  registeredLoads: number;
  meteredLoads: number;
  /** Autonomy target of the load that needs the longest ride-through. */
  autonomyTargetHours: number | null;
  meetsAutonomyTarget: boolean | null;
}

export interface ResilienceAssessment {
  storage: StorageAssessment;
  autonomy: AutonomyAssessment;
  criticalService: CriticalServiceAssessment;
  /** Human-readable statements of what could not be assessed, and why. */
  limitations: string[];
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function assessStorage(storage: StorageAssetState[]): StorageAssessment {
  const missingCapacity: number[] = [];
  const missingSoc: number[] = [];
  const missingDischarge: number[] = [];
  const missingFloor: number[] = [];
  let usableWh = 0;
  let registeredWh = 0;
  let assessed = 0;

  for (const battery of storage) {
    if (battery.maxDischargePowerW === null || battery.maxDischargePowerW <= 0) {
      missingDischarge.push(battery.assetId);
    }
    if (battery.energyCapacityWh === null || battery.energyCapacityWh <= 0) {
      missingCapacity.push(battery.assetId);
      continue;
    }
    if (battery.stateOfChargeRaw === null) {
      missingSoc.push(battery.assetId);
      continue;
    }
    // An unregistered floor is not a floor of zero. Assuming the pack may be run
    // flat inflates autonomy by whatever the real reserve is and can report an
    // autonomy target met that the battery's own limits would never allow.
    if (battery.minStateOfChargeRaw === null) {
      missingFloor.push(battery.assetId);
      continue;
    }
    const aboveFloor = Math.max(0, battery.stateOfChargeRaw - battery.minStateOfChargeRaw);
    usableWh += (battery.energyCapacityWh * aboveFloor) / (100 * SOC_SCALE);
    registeredWh += battery.energyCapacityWh;
    assessed += 1;
  }

  let reason: StorageReason | null = null;
  if (storage.length === 0) {
    reason = 'no_storage_registered';
  } else if (assessed === 0) {
    if (missingCapacity.length > 0) {
      reason = 'storage_capacity_unregistered';
    } else if (missingSoc.length > 0) {
      reason = 'storage_state_of_charge_unavailable';
    } else {
      reason = 'storage_usable_floor_unregistered';
    }
  }

  return {
    usableEnergyWh: assessed > 0 ? Math.round(usableWh) : null,
    registeredEnergyWh: assessed > 0 ? registeredWh : null,
    complete: storage.length > 0 && assessed === storage.length,
    registeredBatteries: storage.length,
    assessedBatteries: assessed,
    batteriesMissingCapacity: missingCapacity,
    batteriesMissingStateOfCharge: missingSoc,
    batteriesMissingDischargeLimit: missingDischarge,
    batteriesMissingUsableFloor: missingFloor,
    reason,
  };
}

function assessAutonomy(
  input: ResilienceInput,
  storage: StorageAssessment
): AutonomyAssessment {
  if (input.totalLoadKw === null || input.totalGenerationKw === null) {
    return { hours: null, basis: null, netDrainKw: null, reason: 'load_unmeasured' };
  }
  const netDrainKw = round(input.totalLoadKw - input.totalGenerationKw, 3);
  if (storage.usableEnergyWh === null) {
    return { hours: null, basis: null, netDrainKw, reason: storage.reason };
  }
  if (netDrainKw <= 0) {
    // Generation is covering demand. How long that lasts depends on the
    // resource, not on the battery, so no ride-through figure is reported.
    return { hours: null, basis: null, netDrainKw, reason: 'load_covered_by_generation' };
  }
  return {
    hours: round(storage.usableEnergyWh / 1000 / netDrainKw, 2),
    basis: storage.complete ? 'measured' : 'partial',
    netDrainKw,
    reason: null,
  };
}

function assessCriticalService(
  input: ResilienceInput,
  storage: StorageAssessment,
  autonomyHours: number | null
): CriticalServiceAssessment {
  const active = input.criticalLoads;
  const metered = active.filter((load) => load.measuredPowerW !== null);
  const targets = active
    .map((load) => load.autonomyTargetHours)
    .filter((hours): hours is number => hours !== null && hours > 0);
  const autonomyTargetHours = targets.length > 0 ? Math.max(...targets) : null;

  const base: CriticalServiceAssessment = {
    served: null,
    reason: null,
    demandKw: null,
    demandSource: null,
    availableSupplyKw: null,
    unservedKw: null,
    registeredLoads: active.length,
    meteredLoads: metered.length,
    autonomyTargetHours,
    meetsAutonomyTarget:
      autonomyTargetHours === null || autonomyHours === null
        ? null
        : autonomyHours >= autonomyTargetHours,
  };

  if (active.length === 0) {
    return { ...base, reason: 'no_critical_loads_registered' };
  }

  // A load's draw is a magnitude: consumption is signed negative on some
  // telemetry paths, and a negative demand would subtract a clinic from the
  // total it is supposed to add to.
  const demandW = active.reduce(
    (sum, load) => sum + Math.abs(load.measuredPowerW ?? load.ratedPowerW),
    0
  );
  const demandKw = round(demandW / 1000, 3);
  const demandSource: CriticalServiceAssessment['demandSource'] =
    metered.length === active.length ? 'metered' : metered.length === 0 ? 'declared' : 'mixed';

  if (input.totalGenerationKw === null) {
    return { ...base, demandKw, demandSource, reason: 'generation_unmeasured' };
  }

  // Discharge headroom counts only where a battery holds usable energy and has a
  // registered export limit. Batteries missing either are simply not counted,
  // which makes the supply total a lower bound.
  const countableStorage =
    storage.usableEnergyWh !== null && storage.usableEnergyWh > 0
      ? input.storage.filter(
          (battery) =>
            !storage.batteriesMissingDischargeLimit.includes(battery.assetId) &&
            !storage.batteriesMissingUsableFloor.includes(battery.assetId) &&
            !storage.batteriesMissingCapacity.includes(battery.assetId) &&
            !storage.batteriesMissingStateOfCharge.includes(battery.assetId)
        )
      : [];
  const dischargeKw =
    countableStorage.reduce((sum, battery) => sum + (battery.maxDischargePowerW ?? 0), 0) / 1000;
  const availableSupplyKw = round(input.totalGenerationKw + dischargeKw, 3);
  const uncountedBatteries = input.storage.length - countableStorage.length;

  // Measured generation alone covering the register is a fact regardless of what
  // is known about storage. Short of that, an uncountable battery means the
  // shortfall is unknown rather than real, so coverage is withheld with the
  // registration task named instead of a failure the site may not have.
  if (availableSupplyKw < demandKw && uncountedBatteries > 0) {
    return {
      ...base,
      demandKw,
      demandSource,
      reason:
        storage.batteriesMissingDischargeLimit.length === uncountedBatteries
          ? 'storage_discharge_limit_unregistered'
          : 'storage_supply_unassessable',
    };
  }

  return {
    ...base,
    demandKw,
    demandSource,
    availableSupplyKw,
    unservedKw: round(Math.max(0, demandKw - availableSupplyKw), 3),
    served: availableSupplyKw >= demandKw,
  };
}

const STORAGE_LIMITATIONS: Record<StorageReason, string> = {
  no_storage_registered: 'No battery is registered to this community, so no ride-through can be assessed',
  storage_capacity_unregistered: 'No registered battery has an energy capacity (Wh) on record',
  storage_state_of_charge_unavailable: 'No registered battery has reported a state of charge recently',
  storage_usable_floor_unregistered: 'No registered battery has a minimum state of charge (usable floor) on record, so usable energy cannot be totalled',
};

const CRITICAL_LIMITATIONS: Record<CriticalServiceReason, string> = {
  no_critical_loads_registered: 'No critical load has been declared for this community',
  critical_load_demand_unknown: 'Critical demand cannot be totalled from the register',
  storage_discharge_limit_unregistered: 'A registered battery has no discharge limit (W) on record, so supply cannot be totalled',
  storage_supply_unassessable: 'A registered battery could not be assessed, so the supply available to critical loads is a lower bound and the shortfall is unknown',
  generation_unmeasured: 'No generation reading is available for the community',
};

/**
 * Assess resilience from registered and measured inputs only.
 *
 * Pure: no I/O, so the edge cases (nothing registered, a battery with no
 * capacity, a load with no meter, generation covering demand) are testable
 * without a database.
 */
export function assessResilience(input: ResilienceInput): ResilienceAssessment {
  const storage = assessStorage(input.storage);
  const autonomy = assessAutonomy(input, storage);
  const criticalService = assessCriticalService(input, storage, autonomy.hours);

  const limitations: string[] = [];
  if (autonomy.hours === null && autonomy.reason !== null) {
    if (autonomy.reason === 'load_unmeasured') {
      limitations.push('Community load or generation is unmeasured, so autonomy cannot be computed');
    } else if (autonomy.reason === 'load_covered_by_generation') {
      limitations.push('Generation currently covers demand; ride-through applies only while it does not');
    } else {
      limitations.push(STORAGE_LIMITATIONS[autonomy.reason]);
    }
  } else if (autonomy.basis === 'partial') {
    limitations.push(
      `Autonomy is a lower bound: ${storage.registeredBatteries - storage.assessedBatteries} of ` +
        `${storage.registeredBatteries} registered batteries could not be assessed`
    );
  }
  if (criticalService.served === null && criticalService.reason !== null) {
    limitations.push(CRITICAL_LIMITATIONS[criticalService.reason]);
  } else if (criticalService.demandSource === 'declared') {
    limitations.push('Critical demand is the declared rating; none of these loads is metered');
  } else if (criticalService.demandSource === 'mixed') {
    limitations.push(
      `Critical demand mixes metered draw (${criticalService.meteredLoads}) with declared ratings ` +
        `(${criticalService.registeredLoads - criticalService.meteredLoads})`
    );
  }

  return { storage, autonomy, criticalService, limitations };
}
