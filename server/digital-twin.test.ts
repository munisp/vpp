/**
 * The twin's job is to be honest about what it does not know, so these tests are
 * mostly about absence: a silent asset, a stale asset, a battery whose sign was
 * misread, a plant with no meter.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

import {
  buildTwinGraph,
  flowOf,
  stalenessBoundFor,
  type TwinAssetRecord,
  type TwinDeviceRecord,
  type TwinObservation,
} from '../shared/digital-twin';

const NOW = new Date('2026-08-22T12:00:00Z');

function observation(overrides: Partial<TwinObservation> = {}): TwinObservation {
  return {
    observedAt: NOW,
    powerWatts: 1000,
    energyWh: null,
    stateOfChargePercent: null,
    voltageVolts: null,
    frequencyHz: null,
    temperatureCelsius: null,
    samples: 1,
    ...overrides,
  };
}

function asset(overrides: Partial<TwinAssetRecord> = {}): TwinAssetRecord {
  return {
    id: 1,
    userId: 7,
    name: 'Roof array',
    assetType: 'solar',
    capacity: 5000,
    status: 'active',
    observation: observation(),
    devices: [],
    ...overrides,
  };
}

function device(overrides: Partial<TwinDeviceRecord> = {}): TwinDeviceRecord {
  return {
    id: 1,
    deviceId: 'aa:bb',
    deviceType: 'smart_meter',
    manufacturer: null,
    model: null,
    firmwareVersion: null,
    status: 'online',
    lastSeen: NOW,
    enabled: true,
    telemetryIntervalSeconds: 5,
    ...overrides,
  };
}

function graphOf(assets: TwinAssetRecord[], stalenessSeconds = 300) {
  return buildTwinGraph({ siteLabel: 'Site', assets, generatedAt: NOW, stalenessSeconds });
}

describe('digital twin graph', () => {
  it('draws an asset that has never reported as unknown, not as idle', () => {
    const graph = graphOf([asset({ observation: observation({ observedAt: null, powerWatts: null, samples: 0 }) })]);

    const node = graph.nodes.find(candidate => candidate.assetId === 1);
    const edge = graph.edges.find(candidate => candidate.id === 'edge:asset:1');

    expect(node?.evidence).toBe('never');
    expect(node?.powerWatts).toBeNull();
    expect(edge?.direction).toBe('unknown');
    expect(edge?.flowWatts).toBeNull();
    expect(edge?.animated).toBe(false);
    expect(edge?.detail).toContain('not a zero flow');
  });

  it('keeps a stale asset visible but never animates it', () => {
    const graph = graphOf([
      asset({ observation: observation({ observedAt: new Date(NOW.getTime() - 3_600_000) }) }),
    ]);

    const node = graph.nodes.find(candidate => candidate.assetId === 1);
    const edge = graph.edges.find(candidate => candidate.id === 'edge:asset:1');

    expect(node?.evidence).toBe('stale');
    // The last reading stays readable, but it is not offered as the present.
    expect(node?.powerWatts).toBeNull();
    expect(node?.lastPowerWatts).toBe(1000);
    expect(edge?.animated).toBe(false);
    expect(edge?.flowWatts).toBeNull();
  });

  it('treats a reading timestamped in the future as stale, never as current', () => {
    const graph = graphOf([
      asset({ observation: observation({ observedAt: new Date(NOW.getTime() + 3_600_000) }) }),
    ]);

    expect(graph.nodes.find(candidate => candidate.assetId === 1)?.evidence).toBe('stale');
  });

  it('separates a measured zero from missing data', () => {
    const graph = graphOf([asset({ observation: observation({ powerWatts: 0 }) })]);
    const edge = graph.edges.find(candidate => candidate.id === 'edge:asset:1');

    expect(edge?.direction).toBe('idle');
    expect(edge?.flowWatts).toBe(0);
    expect(edge?.animated).toBe(false);
    expect(edge?.detail).toContain('measured zero');
  });

  it('reads a charging battery as drawing from the bus, not generating into it', () => {
    expect(flowOf('battery', -2000, 'measured')).toEqual({ direction: 'out', flowWatts: 2000 });
    expect(flowOf('battery', 2000, 'measured')).toEqual({ direction: 'in', flowWatts: 2000 });
  });

  it('reads a consuming asset positive figure as load, not as generation', () => {
    expect(flowOf('ev_charger', 7000, 'measured')).toEqual({ direction: 'out', flowWatts: 7000 });
    expect(flowOf('load', 400, 'measured')).toEqual({ direction: 'out', flowWatts: 400 });
  });

  it('leaves silent assets out of the net figure instead of counting them as zero', () => {
    const graph = graphOf([
      asset({ id: 1, observation: observation({ powerWatts: 3000 }) }),
      asset({
        id: 2,
        name: 'Silent array',
        capacity: 8000,
        observation: observation({ observedAt: null, powerWatts: null, samples: 0 }),
      }),
    ]);

    expect(graph.measuredNetPowerWatts).toBe(3000);
    expect(graph.coverage).toEqual({
      assets: 2,
      measured: 1,
      stale: 0,
      neverObserved: 1,
      unseenCapacity: 8000,
    });
    const site = graph.nodes.find(node => node.id === 'site');
    expect(site?.detail).toContain('not assumed idle');
  });

  it('does not add the meter to the equipment behind it', () => {
    // A 3 kW array exporting 1.5 kW through the meter: summing both would
    // report 1.5 kW of nothing physical.
    const graph = graphOf([
      asset({ id: 1, assetType: 'solar', observation: observation({ powerWatts: 3000 }) }),
      asset({
        id: 2,
        name: 'Main meter',
        assetType: 'meter',
        observation: observation({ powerWatts: -1500 }),
      }),
    ]);

    expect(graph.measuredNetPowerWatts).toBe(3000);
    expect(graph.measuredBehindMeter).toBe(1);
    expect(graph.meteredGridPowerWatts).toBe(-1500);
    expect(graph.coverage.measured).toBe(2);
  });

  it('reports the grid exchange as unknown when only equipment behind the meter is reporting', () => {
    const graph = graphOf([
      asset({ id: 1, assetType: 'solar', observation: observation({ powerWatts: 3000 }) }),
    ]);

    expect(graph.meteredGridPowerWatts).toBeNull();
    expect(graph.measuredNetPowerWatts).toBe(3000);
  });

  it('leaves the behind-the-meter net unknown when only the meter is reporting', () => {
    const graph = graphOf([
      asset({
        id: 1,
        name: 'Main meter',
        assetType: 'meter',
        observation: observation({ powerWatts: 900 }),
      }),
    ]);

    expect(graph.measuredBehindMeter).toBe(0);
    expect(graph.meteredGridPowerWatts).toBe(900);
    const site = graph.nodes.find(node => node.id === 'site');
    expect(site?.powerWatts).toBeNull();
    // A reporting meter says nothing about the equipment behind the bus, so the
    // bus is not drawn live off it.
    expect(site?.evidence).toBe('never');
    expect(site?.detail).toContain('Only a meter is registered');
  });

  it('calls the bus stale when the only equipment behind it is stale, meter or not', () => {
    const graph = graphOf([
      asset({
        id: 1,
        assetType: 'solar',
        observation: observation({ observedAt: new Date(NOW.getTime() - 3_600_000) }),
      }),
      asset({
        id: 2,
        name: 'Main meter',
        assetType: 'meter',
        observation: observation({ powerWatts: 900 }),
      }),
    ]);

    const site = graph.nodes.find(node => node.id === 'site');
    expect(site?.evidence).toBe('stale');
    expect(site?.powerWatts).toBeNull();
  });

  it('counts equipment reporting without a power value as seen but not as a zero', () => {
    const graph = graphOf([
      asset({ id: 1, assetType: 'solar', observation: observation({ powerWatts: null }) }),
    ]);

    const site = graph.nodes.find(node => node.id === 'site');
    expect(site?.evidence).toBe('measured');
    expect(site?.powerWatts).toBeNull();
    expect(graph.measuredBehindMeter).toBe(0);
  });

  it('says the grid exchange is unmeasured when no meter is reporting', () => {
    const graph = graphOf([asset()]);
    const grid = graph.nodes.find(node => node.id === 'grid');

    expect(grid?.evidence).toBe('never');
    expect(grid?.detail).toContain('cannot be shown');
    expect(graph.edges.some(edge => edge.id.startsWith('edge:grid:'))).toBe(false);
  });

  it('measures the grid boundary at the meter and directs import and export by sign', () => {
    const importing = graphOf([
      asset({ id: 3, name: 'Main meter', assetType: 'meter', observation: observation({ powerWatts: 1200 }) }),
    ]);
    const gridEdge = importing.edges.find(edge => edge.id === 'edge:grid:3');
    expect(gridEdge).toMatchObject({ from: 'grid', to: 'site', direction: 'in', flowWatts: 1200 });
    expect(importing.nodes.find(node => node.id === 'grid')?.evidence).toBe('measured');

    const exporting = graphOf([
      asset({ id: 3, name: 'Main meter', assetType: 'meter', observation: observation({ powerWatts: -800 }) }),
    ]);
    expect(exporting.edges.find(edge => edge.id === 'edge:grid:3')).toMatchObject({
      from: 'site',
      to: 'grid',
      direction: 'out',
      flowWatts: 800,
    });
  });

  it('holds a site with only stale assets short of claiming a net flow', () => {
    const graph = graphOf([
      asset({ observation: observation({ observedAt: new Date(NOW.getTime() - 7_200_000) }) }),
    ]);
    const site = graph.nodes.find(node => node.id === 'site');

    expect(site?.evidence).toBe('stale');
    expect(site?.powerWatts).toBeNull();
    expect(site?.detail).toContain('unknown rather than zero');
  });

  it('ages a fast-reporting device against its own interval, not a global bound', () => {
    const fast = asset({
      devices: [
        {
          id: 1,
          deviceId: 'aa:bb',
          deviceType: 'smart_meter',
          manufacturer: null,
          model: null,
          firmwareVersion: null,
          status: 'online',
          lastSeen: NOW,
          enabled: true,
          telemetryIntervalSeconds: 5,
        },
      ],
    });

    // Never below the deployment floor: a five-second device is not called stale
    // after fifteen seconds when the platform's own bound is wider.
    expect(stalenessBoundFor(fast, 300)).toBe(300);
    expect(stalenessBoundFor(fast, 5)).toBe(15);

    const slow = asset({
      devices: [{ ...fast.devices[0], telemetryIntervalSeconds: 900 }],
    });
    expect(stalenessBoundFor(slow, 300)).toBe(2700);
  });

  it('ignores a disabled device when deciding how fresh a reading must be', () => {
    const withDisabled = asset({
      devices: [
        {
          id: 1,
          deviceId: 'aa:bb',
          deviceType: 'smart_meter',
          manufacturer: null,
          model: null,
          firmwareVersion: null,
          status: 'offline',
          lastSeen: null,
          enabled: false,
          telemetryIntervalSeconds: 900,
        },
      ],
    });

    expect(stalenessBoundFor(withDisabled, 300)).toBe(300);
  });

  it('ages an asset against its fastest reporter, never its slowest', () => {
    // A 5-second sensor and a 15-minute device on the same asset: the fast
    // sensor sets the bound, so when it stops reporting the asset is stale
    // even though the slow device would not be due for hours.
    const mixed = asset({
      observation: observation({ observedAt: new Date(NOW.getTime() - 400_000) }),
      devices: [
        device({ id: 1, telemetryIntervalSeconds: 5 }),
        device({ id: 2, telemetryIntervalSeconds: 900 }),
      ],
    });

    // max(300 floor, min(5, 900) * 3) — the 900s device must not widen it.
    expect(stalenessBoundFor(mixed, 300)).toBe(300);
    const graph = graphOf([mixed]);
    expect(graph.nodes.find(candidate => candidate.assetId === 1)?.evidence).toBe('stale');
  });

  it('designates one boundary meter instead of summing every meter into the grid figure', () => {
    // Two meters on the same boundary see the same exchange; adding both would
    // report double the physical flow. The largest-rated meter is the boundary.
    const graph = graphOf([
      asset({
        id: 1,
        name: 'Sub meter',
        assetType: 'meter',
        capacity: 100,
        observation: observation({ powerWatts: 500 }),
      }),
      asset({
        id: 2,
        name: 'Main meter',
        assetType: 'meter',
        capacity: 20_000,
        observation: observation({ powerWatts: -1500 }),
      }),
    ]);

    expect(graph.meteredGridPowerWatts).toBe(-1500);
    expect(graph.edges.some(edge => edge.id === 'edge:grid:2')).toBe(true);
    expect(graph.edges.some(edge => edge.id === 'edge:grid:1')).toBe(false);

    // The demoted meter stays a regular node: drawn, with its own evidence,
    // feeding no grid figure.
    const demoted = graph.nodes.find(candidate => candidate.assetId === 1);
    expect(demoted?.evidence).toBe('measured');
    expect(graph.edges.some(edge => edge.id === 'edge:asset:1')).toBe(true);

    const grid = graph.nodes.find(candidate => candidate.id === 'grid');
    expect(grid?.detail).toContain('boundary meter Main meter');
    expect(grid?.detail).toContain('Sub meter');
  });

  it('honours an explicit boundary marker over the capacity rule', () => {
    const graph = graphOf([
      asset({
        id: 1,
        name: 'Marked meter',
        assetType: 'meter',
        capacity: 100,
        metadata: '{"role":"boundary"}',
        observation: observation({ powerWatts: 300 }),
      }),
      asset({
        id: 2,
        name: 'Bigger meter',
        assetType: 'meter',
        capacity: 50_000,
        observation: observation({ powerWatts: -9000 }),
      }),
    ]);

    expect(graph.meteredGridPowerWatts).toBe(300);
    expect(graph.edges.some(edge => edge.id === 'edge:grid:1')).toBe(true);
    expect(graph.edges.some(edge => edge.id === 'edge:grid:2')).toBe(false);
  });

  it('excludes a rejected asset from the graph entirely', () => {
    const graph = graphOf([
      asset({ id: 1, approvalStatus: 'approved' }),
      asset({ id: 2, name: 'Refused equipment', approvalStatus: 'rejected' }),
    ]);

    expect(graph.nodes.some(candidate => candidate.assetId === 2)).toBe(false);
    expect(graph.edges.some(edge => edge.id === 'edge:asset:2')).toBe(false);
    expect(graph.coverage.assets).toBe(1);
  });

  it('keeps a pending asset visible but says it is not yet approved', () => {
    const graph = graphOf([asset({ approvalStatus: 'pending' })]);
    const node = graph.nodes.find(candidate => candidate.assetId === 1);

    expect(node?.approvalStatus).toBe('pending');
    expect(node?.detail).toContain('not yet approved');
  });

  it('carries the measured companion readings onto the node, and clears them when stale', () => {
    const measuredGraph = graphOf([
      asset({
        observation: observation({
          energyWh: 12_000,
          voltageVolts: 231.2,
          frequencyHz: 50.01,
          temperatureCelsius: 34.5,
        }),
      }),
    ]);
    const node = measuredGraph.nodes.find(candidate => candidate.assetId === 1);
    expect(node?.energyWh).toBe(12_000);
    expect(node?.voltageVolts).toBe(231.2);
    expect(node?.frequencyHz).toBe(50.01);
    expect(node?.temperatureCelsius).toBe(34.5);

    // Stale evidence shows no companion readings as if they were current.
    const staleGraph = graphOf([
      asset({
        observation: observation({
          observedAt: new Date(NOW.getTime() - 3_600_000),
          voltageVolts: 231.2,
        }),
      }),
    ]);
    expect(staleGraph.nodes.find(candidate => candidate.assetId === 1)?.voltageVolts).toBeNull();
  });

  it('states the freshness bound the graph was built with, per node and per graph', () => {
    const graph = graphOf([asset()], 300);

    expect(graph.stalenessSeconds).toBe(300);
    expect(graph.nodes.find(candidate => candidate.assetId === 1)?.stalenessBoundSeconds).toBe(300);
  });
});

/**
 * The SQL layer, through the same mocked-database idiom as
 * server/price-signal.test.ts: `execute` answers the asset query first and the
 * device query second, from a queue each test fills.
 */
describe('digital twin SQL layer', () => {
  interface SqlState {
    results: Array<{ rows: Record<string, unknown>[] }>;
  }

  let state: SqlState;

  function mockDb(db: unknown) {
    vi.doMock('./db', () => ({ getDb: async () => db }));
  }

  function mockDbWithRows() {
    mockDb({ execute: async () => state.results.shift() ?? { rows: [] } });
  }

  function assetRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 1,
      user_id: 7,
      name: 'Roof array',
      asset_type: 'solar',
      capacity: 5000,
      status: 'active',
      approval_status: 'approved',
      metadata: null,
      observed_at: NOW,
      power: 1000,
      energy: null,
      voltage: null,
      current: null,
      frequency: null,
      state_of_charge: null,
      temperature: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.resetModules();
    state = { results: [] };
  });

  afterEach(() => {
    vi.doUnmock('./db');
  });

  it('throws DigitalTwinError when the database is unavailable, and the evidence map is null', async () => {
    mockDb(null);
    const { loadTwinAssets, getDigitalTwin, getTwinEvidence, DigitalTwinError } = await import(
      './services/digital-twin'
    );

    await expect(loadTwinAssets({ userId: 7 })).rejects.toBeInstanceOf(DigitalTwinError);
    await expect(getDigitalTwin({ userId: 7 }, 'Site')).rejects.toThrow(/database is unavailable/);
    // null means "the twin cannot say", never "all clear".
    await expect(getTwinEvidence({ userId: 7 })).resolves.toBeNull();
  });

  it('keeps a never-reported asset through the LEFT JOIN as evidence never', async () => {
    mockDbWithRows();
    state.results = [
      { rows: [assetRow({ observed_at: null, power: null })] },
      { rows: [] },
    ];
    const { getDigitalTwin } = await import('./services/digital-twin');

    const graph = await getDigitalTwin({ userId: 7 }, 'Site');
    const node = graph.nodes.find(candidate => candidate.assetId === 1);

    expect(node?.evidence).toBe('never');
    expect(node?.powerWatts).toBeNull();
    expect(graph.coverage.neverObserved).toBe(1);
  });

  it('excludes a rejected asset from the loaded graph', async () => {
    mockDbWithRows();
    state.results = [
      { rows: [assetRow(), assetRow({ id: 2, name: 'Refused equipment', approval_status: 'rejected' })] },
      { rows: [] },
    ];
    const { getDigitalTwin } = await import('./services/digital-twin');

    const graph = await getDigitalTwin({ userId: 7 }, 'Site');

    expect(graph.nodes.some(candidate => candidate.assetId === 2)).toBe(false);
    expect(graph.coverage.assets).toBe(1);
  });

  it('refuses a registry row that cannot be true, naming the asset and the field', async () => {
    mockDbWithRows();
    // SoC is stored as percentage x100, so 14000 unscales to 140%.
    state.results = [{ rows: [assetRow({ state_of_charge: 14_000 })] }, { rows: [] }];
    const { loadTwinAssets, DigitalTwinError } = await import('./services/digital-twin');

    const error = await loadTwinAssets({ userId: 7 }).catch(candidate => candidate);
    expect(error).toBeInstanceOf(DigitalTwinError);
    expect(error.message).toContain('asset 1');
    expect(error.message).toContain('stateOfChargePercent');
  });

  it('maps twin evidence per asset for the control plane', async () => {
    mockDbWithRows();
    state.results = [
      {
        rows: [
          // Judged against the real clock, so the fresh row must be fresh now.
          assetRow({ observed_at: new Date() }),
          assetRow({ id: 2, name: 'Quiet battery', asset_type: 'battery', observed_at: null, power: null }),
        ],
      },
      { rows: [] },
    ];
    const { getTwinEvidence } = await import('./services/digital-twin');

    const evidence = await getTwinEvidence({ userId: 7 });

    expect(evidence?.get(1)?.evidence).toBe('measured');
    expect(evidence?.get(2)?.evidence).toBe('never');
    expect(evidence?.get(2)?.ageSeconds).toBeNull();
  });
});

/**
 * The control plane consumes the twin's evidence: an in-force setpoint to an
 * asset with no fresh meter evidence is commanding blind and is refused; a
 * refused or unconfirmed delivery is still recorded, because it did not
 * command anything and its audit record must exist.
 */
describe('control plane twin evidence gate', () => {
  const window = { validFrom: NOW, validTo: new Date(NOW.getTime() + 900_000), seconds: 900 };

  function assignment(overrides: Record<string, unknown> = {}) {
    return {
      protocol: 'mqtt' as const,
      targetRef: 'DEV-1',
      assetId: 1,
      userId: 7,
      source: 'optimizer' as const,
      window,
      fallbackPolicy: 'resume_local' as const,
      fallbackLimitWatts: null,
      delivery: 'broker_queued' as const,
      deliveryDetail: 'published to the MQTT broker',
      ...overrides,
    };
  }

  function mockControlDb(assetRows: Record<string, unknown>[] | null) {
    const tx = {
      update: () => ({ set: () => ({ where: async () => undefined }) }),
      insert: () => ({ values: () => ({ returning: async () => [{ id: 99 }] }) }),
    };
    const results: Array<{ rows: Record<string, unknown>[] }> =
      assetRows === null ? [] : [{ rows: assetRows }, { rows: [] }];
    vi.doMock('./db', () => ({
      getDb: async () => ({
        execute:
          assetRows === null
            ? async () => {
                throw new Error('relation "assets" does not exist');
              }
            : async () => results.shift() ?? { rows: [] },
        transaction: async (cb: (t: typeof tx) => Promise<number | null>) => cb(tx),
      }),
    }));
  }

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('./db');
  });

  it('refuses an in-force dispatch to an asset that has never reported', async () => {
    mockControlDb([
      {
        id: 1,
        user_id: 7,
        name: 'Quiet battery',
        asset_type: 'battery',
        capacity: 5000,
        status: 'active',
        approval_status: 'approved',
        metadata: null,
        observed_at: null,
        power: null,
        energy: null,
        voltage: null,
        current: null,
        frequency: null,
        state_of_charge: null,
        temperature: null,
      },
    ]);
    const { recordControlAssignment, ControlValidityError } = await import(
      './services/control-validity'
    );

    const error = await recordControlAssignment(assignment()).catch(candidate => candidate);
    expect(error).toBeInstanceOf(ControlValidityError);
    expect(error.message).toContain('asset 1');
    expect(error.message).toContain('commanding blind');
  });

  it('records an in-force dispatch to an asset with fresh evidence', async () => {
    mockControlDb([
      {
        id: 1,
        user_id: 7,
        name: 'Roof battery',
        asset_type: 'battery',
        capacity: 5000,
        status: 'active',
        approval_status: 'approved',
        metadata: null,
        observed_at: new Date(),
        power: 1000,
        energy: null,
        voltage: null,
        current: null,
        frequency: null,
        state_of_charge: null,
        temperature: null,
      },
    ]);
    const { recordControlAssignment } = await import('./services/control-validity');

    await expect(recordControlAssignment(assignment())).resolves.toBe(99);
  });

  it('still records a delivery that commanded nothing, stale asset or not', async () => {
    mockControlDb([
      {
        id: 1,
        user_id: 7,
        name: 'Quiet battery',
        asset_type: 'battery',
        capacity: 5000,
        status: 'active',
        approval_status: 'approved',
        metadata: null,
        observed_at: null,
        power: null,
        energy: null,
        voltage: null,
        current: null,
        frequency: null,
        state_of_charge: null,
        temperature: null,
      },
    ]);
    const { recordControlAssignment } = await import('./services/control-validity');

    await expect(
      recordControlAssignment(assignment({ delivery: 'unconfirmed' }))
    ).resolves.toBe(99);
  });

  it('records a warning on the assignment when the twin itself cannot be read', async () => {
    mockControlDb(null);
    const recorded: Array<Record<string, unknown>> = [];
    const tx = {
      update: () => ({ set: () => ({ where: async () => undefined }) }),
      insert: () => ({
        values: (values: Record<string, unknown>) => ({
          returning: async () => {
            recorded.push(values);
            return [{ id: 99 }];
          },
        }),
      }),
    };
    vi.doMock('./db', () => ({
      getDb: async () => ({
        execute: async () => {
          throw new Error('relation "assets" does not exist');
        },
        transaction: async (cb: (t: typeof tx) => Promise<number | null>) => cb(tx),
      }),
    }));
    const { recordControlAssignment } = await import('./services/control-validity');

    await expect(recordControlAssignment(assignment())).resolves.toBe(99);
    expect(recorded[0]?.deliveryDetail).toContain('twin evidence unavailable');
  });
});

describe('digital twin router error mapping', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('maps DigitalTwinError to SERVICE_UNAVAILABLE, never to an empty graph', async () => {
    const { toTRPCError } = await import('./routers/nextgen/digital-twin');
    const { DigitalTwinError } = await import('./services/digital-twin');

    const error = await Promise.resolve()
      .then(() => toTRPCError(new DigitalTwinError('The database is unavailable')))
      .catch(candidate => candidate);

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
  });

  it('rethrows errors that are not twin failures untouched', async () => {
    const { toTRPCError } = await import('./routers/nextgen/digital-twin');
    const other = new Error('boom');

    expect(() => toTRPCError(other)).toThrow(other);
  });
});
