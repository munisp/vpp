import { describe, expect, it } from 'vitest';

import { buildTwinGraph, type TwinAssetRecord } from '@shared/digital-twin';
import { layoutTwin } from './twin-layout';

const NOW = new Date('2026-08-22T12:00:00Z');

function asset(overrides: Partial<TwinAssetRecord>): TwinAssetRecord {
  return {
    id: 1,
    userId: 1,
    name: 'Asset',
    assetType: 'solar',
    capacity: 1000,
    status: 'active',
    observation: {
      observedAt: NOW,
      powerWatts: 500,
      energyWh: null,
      stateOfChargePercent: null,
      voltageVolts: null,
      frequencyHz: null,
      temperatureCelsius: null,
      samples: 1,
    },
    devices: [],
    ...overrides,
  };
}

function layoutOf(assets: TwinAssetRecord[]) {
  return layoutTwin(
    buildTwinGraph({ siteLabel: 'Site', assets, generatedAt: NOW, stalenessSeconds: 300 })
  );
}

describe('twin layout', () => {
  it('reads left to right from the grid through the meter to the equipment', () => {
    const layout = layoutOf([
      asset({ id: 1, assetType: 'meter', name: 'Meter' }),
      asset({ id: 2, assetType: 'solar', name: 'Array' }),
    ]);

    const x = (id: string) => layout.nodes.find(placement => placement.node.id === id)?.x ?? 0;

    expect(x('grid')).toBeLessThan(x('asset:1'));
    expect(x('asset:1')).toBeLessThan(x('site'));
    expect(x('site')).toBeLessThan(x('asset:2'));
  });

  it('places every node once and never stacks two in the same spot', () => {
    const layout = layoutOf([1, 2, 3, 4].map(id => asset({ id, name: `Asset ${id}` })));

    expect(layout.nodes).toHaveLength(6); // 4 assets + site + grid
    const spots = layout.nodes.map(placement => `${placement.x}:${placement.y}`);
    expect(new Set(spots).size).toBe(spots.length);
  });

  it('grows the canvas with the plant instead of overlapping rows', () => {
    const small = layoutOf([asset({ id: 1 })]);
    const large = layoutOf(Array.from({ length: 8 }, (_, index) => asset({ id: index + 1 })));

    expect(large.height).toBeGreaterThan(small.height);
    const ys = large.nodes
      .filter(placement => placement.node.assetId !== undefined)
      .map(placement => placement.y);
    expect(new Set(ys).size).toBe(ys.length);
  });

  it('draws a path for every edge whose endpoints are both placed', () => {
    const layout = layoutOf([asset({ id: 1, assetType: 'meter' }), asset({ id: 2 })]);

    expect(layout.edges).toHaveLength(3); // meter→bus, grid→bus, array→bus
    for (const placement of layout.edges) {
      expect(placement.path).toMatch(/^M [\d.]+ [\d.]+ C /);
    }
  });

  it('is deterministic, so a site keeps its shape between refreshes', () => {
    const assets = [asset({ id: 1 }), asset({ id: 2, assetType: 'battery' })];
    expect(layoutOf(assets)).toEqual(layoutOf(assets));
  });
});
