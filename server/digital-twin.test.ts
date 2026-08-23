/**
 * The twin's job is to be honest about what it does not know, so these tests are
 * mostly about absence: a silent asset, a stale asset, a battery whose sign was
 * misread, a plant with no meter.
 */

import { describe, expect, it } from 'vitest';

import {
  buildTwinGraph,
  flowOf,
  stalenessBoundFor,
  type TwinAssetRecord,
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
});
