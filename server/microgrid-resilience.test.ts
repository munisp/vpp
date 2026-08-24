/**
 * Resilience is mostly a test of what the platform refuses to claim: a battery
 * with no registered energy, a battery that has not reported, a clinic nobody
 * declared, a discharge limit nobody recorded. Each of those has to come back
 * null with a reason, because the number these tests replace was invented from
 * "assume a 2-hour battery".
 */

import { describe, expect, it } from 'vitest';

import {
  assessResilience,
  type CriticalLoadState,
  type ResilienceInput,
  type StorageAssetState,
} from './services/microgrid-resilience';

function battery(overrides: Partial<StorageAssetState> = {}): StorageAssetState {
  return {
    assetId: 1,
    name: 'Community battery',
    energyCapacityWh: 20_000,
    stateOfChargeRaw: 8000, // 80.00%
    minStateOfChargeRaw: 2000, // 20.00%
    maxDischargePowerW: 5000,
    observedAt: new Date('2026-08-22T12:00:00Z'),
    ...overrides,
  };
}

function criticalLoad(overrides: Partial<CriticalLoadState> = {}): CriticalLoadState {
  return {
    id: 1,
    label: 'Clinic cold chain',
    category: 'health',
    priority: 1,
    ratedPowerW: 1500,
    ratingSource: 'nameplate',
    autonomyTargetHours: 8,
    assetId: null,
    measuredPowerW: null,
    measuredAt: null,
    ...overrides,
  };
}

function input(overrides: Partial<ResilienceInput> = {}): ResilienceInput {
  return {
    totalGenerationKw: 2,
    totalLoadKw: 5,
    storage: [battery()],
    criticalLoads: [criticalLoad()],
    ...overrides,
  };
}

describe('assessResilience storage', () => {
  it('counts only the energy above the registered usable floor', () => {
    const { storage } = assessResilience(input());
    // 20 kWh x (80% - 20%) = 12 kWh
    expect(storage.usableEnergyWh).toBe(12_000);
    expect(storage.complete).toBe(true);
    expect(storage.reason).toBeNull();
  });

  it('withholds usable energy when the floor is unregistered instead of assuming the pack runs flat', () => {
    const { storage, autonomy } = assessResilience(
      input({ storage: [battery({ minStateOfChargeRaw: null })] })
    );
    // Assuming a floor of zero would have claimed 16 kWh usable out of a pack
    // whose real reserve nobody registered.
    expect(storage.usableEnergyWh).toBeNull();
    expect(storage.batteriesMissingUsableFloor).toEqual([1]);
    expect(storage.reason).toBe('storage_usable_floor_unregistered');
    expect(autonomy.hours).toBeNull();
    expect(autonomy.reason).toBe('storage_usable_floor_unregistered');
  });

  it('assesses the batteries that are registered and marks the total a lower bound', () => {
    const { storage, autonomy } = assessResilience(
      input({
        storage: [battery(), battery({ assetId: 2, minStateOfChargeRaw: null })],
      })
    );
    expect(storage.usableEnergyWh).toBe(12_000);
    expect(storage.complete).toBe(false);
    expect(storage.batteriesMissingUsableFloor).toEqual([2]);
    expect(autonomy.basis).toBe('partial');
  });

  it('withholds stored energy when no battery has a registered capacity', () => {
    const { storage, autonomy } = assessResilience(
      input({ storage: [battery({ energyCapacityWh: null })] })
    );
    expect(storage.usableEnergyWh).toBeNull();
    expect(storage.reason).toBe('storage_capacity_unregistered');
    expect(autonomy.hours).toBeNull();
    expect(autonomy.reason).toBe('storage_capacity_unregistered');
  });

  it('withholds stored energy when no battery has reported a state of charge', () => {
    const { autonomy } = assessResilience(
      input({ storage: [battery({ stateOfChargeRaw: null })] })
    );
    expect(autonomy.hours).toBeNull();
    expect(autonomy.reason).toBe('storage_state_of_charge_unavailable');
  });

  it('says so when the community has no storage at all', () => {
    const { autonomy } = assessResilience(input({ storage: [] }));
    expect(autonomy.reason).toBe('no_storage_registered');
  });
});

describe('assessResilience autonomy', () => {
  it('divides usable energy by the drain storage would have to cover', () => {
    const { autonomy } = assessResilience(input());
    // 12 kWh / (5 kW - 2 kW) = 4 h
    expect(autonomy).toMatchObject({ hours: 4, basis: 'measured', netDrainKw: 3 });
  });

  it('reports a lower bound when only some batteries could be assessed', () => {
    const assessment = assessResilience(
      input({
        storage: [battery(), battery({ assetId: 2, energyCapacityWh: null })],
      })
    );
    expect(assessment.autonomy.basis).toBe('partial');
    expect(assessment.autonomy.hours).toBe(4);
    expect(assessment.limitations.join(' ')).toContain('lower bound');
  });

  it('does not report ride-through while generation covers demand', () => {
    const { autonomy } = assessResilience(input({ totalGenerationKw: 6, totalLoadKw: 5 }));
    expect(autonomy.hours).toBeNull();
    expect(autonomy.reason).toBe('load_covered_by_generation');
  });

  it('refuses an autonomy figure when the community is unmeasured', () => {
    const { autonomy } = assessResilience(
      input({ totalGenerationKw: null, totalLoadKw: null })
    );
    expect(autonomy.hours).toBeNull();
    expect(autonomy.reason).toBe('load_unmeasured');
  });

  it('never returns the old 24-hour placeholder for a site at rest', () => {
    const { autonomy } = assessResilience(input({ totalGenerationKw: 5, totalLoadKw: 5 }));
    expect(autonomy.hours).toBeNull();
  });
});

describe('assessResilience critical service', () => {
  it('compares declared critical demand with generation plus discharge headroom', () => {
    const { criticalService } = assessResilience(input());
    expect(criticalService).toMatchObject({
      served: true,
      demandKw: 1.5,
      demandSource: 'declared',
      availableSupplyKw: 7, // 2 kW generation + 5 kW discharge limit
      unservedKw: 0,
    });
  });

  it('reports the shortfall when supply cannot cover the register', () => {
    const { criticalService } = assessResilience(
      input({
        totalGenerationKw: 0,
        criticalLoads: [criticalLoad({ ratedPowerW: 9000 })],
        storage: [battery({ maxDischargePowerW: 2000 })],
      })
    );
    expect(criticalService.served).toBe(false);
    expect(criticalService.unservedKw).toBe(7);
  });

  it('prefers the metered draw over the declared rating and says which', () => {
    const { criticalService } = assessResilience(
      input({ criticalLoads: [criticalLoad({ assetId: 7, measuredPowerW: -900 })] })
    );
    expect(criticalService.demandKw).toBe(0.9);
    expect(criticalService.demandSource).toBe('metered');
  });

  it('withholds coverage when nothing has been declared critical', () => {
    const { criticalService } = assessResilience(input({ criticalLoads: [] }));
    expect(criticalService.served).toBeNull();
    expect(criticalService.reason).toBe('no_critical_loads_registered');
  });

  it('withholds coverage when an uncountable battery is what stands between demand and supply', () => {
    const { criticalService } = assessResilience(
      input({
        totalGenerationKw: 0.5,
        storage: [battery({ maxDischargePowerW: null })],
      })
    );
    expect(criticalService.served).toBeNull();
    expect(criticalService.reason).toBe('storage_discharge_limit_unregistered');
  });

  it('withholds coverage when the shortfall depends on a battery that could not be assessed', () => {
    const { criticalService } = assessResilience(
      input({
        totalGenerationKw: 0.5,
        storage: [battery({ stateOfChargeRaw: null })],
      })
    );
    expect(criticalService.served).toBeNull();
    expect(criticalService.reason).toBe('storage_supply_unassessable');
  });

  it('counts measured generation alone as coverage without needing the battery registered', () => {
    // Generation exceeding the register is a fact whatever is unknown about
    // storage; the supply figure just excludes the battery it cannot count.
    const { criticalService } = assessResilience(
      input({ storage: [battery({ maxDischargePowerW: null })] })
    );
    expect(criticalService.served).toBe(true);
    expect(criticalService.availableSupplyKw).toBe(2);
    expect(criticalService.unservedKw).toBe(0);
  });

  it('withholds coverage when generation is unmeasured', () => {
    const { criticalService } = assessResilience(
      input({ totalGenerationKw: null, totalLoadKw: null })
    );
    expect(criticalService.served).toBeNull();
    expect(criticalService.reason).toBe('generation_unmeasured');
  });

  it('measures ride-through against the longest declared autonomy target', () => {
    const shortfall = assessResilience(
      input({ criticalLoads: [criticalLoad({ autonomyTargetHours: 8 })] })
    );
    expect(shortfall.criticalService.autonomyTargetHours).toBe(8);
    expect(shortfall.criticalService.meetsAutonomyTarget).toBe(false);

    const met = assessResilience(
      input({ criticalLoads: [criticalLoad({ autonomyTargetHours: 3 })] })
    );
    expect(met.criticalService.meetsAutonomyTarget).toBe(true);
  });

  it('leaves the target unjudged when ride-through is unknown', () => {
    const { criticalService } = assessResilience(input({ storage: [] }));
    expect(criticalService.meetsAutonomyTarget).toBeNull();
  });
});
