import { describe, expect, it } from 'vitest';

import {
  controllability,
  formatMeasurement,
  measuredEnergyWh,
  measuredWatts,
  nodeVerdict,
  reportedOnOff,
  summariseFabric,
  type MatterNode,
} from './matter-loads';

function node(overrides: Partial<MatterNode> = {}): MatterNode {
  return {
    id: 1,
    fabricId: '1',
    nodeId: '4',
    available: true,
    isBridge: false,
    isTestNode: false,
    removedAt: null,
    lastReportedAt: '2026-03-01T10:00:00.000Z',
    capabilities: [{ endpointId: 1, clusterId: 6, cluster: 'on_off' }],
    attributes: [],
    ...overrides,
  };
}

describe('nodeVerdict', () => {
  it('calls a synthetic controller node out before anything else about it', () => {
    const verdict = nodeVerdict(node({ isTestNode: true, available: true }));
    expect(verdict.tone).toBe('danger');
    expect(verdict.meaning).toMatch(/no appliance performs/);
  });

  it('describes a removed node as removed even though it was reachable', () => {
    expect(nodeVerdict(node({ removedAt: '2026-03-01T11:00:00.000Z' })).label).toBe(
      'Removed from fabric'
    );
  });

  it('does not let reachability read as delivery', () => {
    expect(nodeVerdict(node()).meaning).toMatch(/not delivery/);
  });

  it('flags a reachable node that published no clusters', () => {
    const verdict = nodeVerdict(node({ capabilities: [] }));
    expect(verdict.tone).toBe('warning');
    expect(verdict.meaning).toMatch(/refuse to command/);
  });

  it('says an unreachable node is not having its window enforced', () => {
    expect(nodeVerdict(node({ available: false })).meaning).toMatch(/not being enforced/);
  });
});

describe('controllability', () => {
  it('is derived from published clusters only', () => {
    expect(controllability(node())).toBe('controllable');
    expect(
      controllability(
        node({ capabilities: [{ endpointId: 1, clusterId: 144, cluster: 'electrical_power_measurement' }] })
      )
    ).toBe('metered_only');
    expect(controllability(node({ capabilities: [{ endpointId: 1, clusterId: 29, cluster: null }] }))).toBe(
      'none'
    );
  });

  it('never treats a synthetic or removed node as dispatchable', () => {
    expect(controllability(node({ isTestNode: true }))).toBe('none');
    expect(controllability(node({ removedAt: new Date() }))).toBe('none');
  });
});

describe('measurements', () => {
  const powerAttribute = (value: unknown) => ({
    path: '1/144/10',
    endpointId: 1,
    clusterId: 144,
    attributeId: 10,
    cluster: 'electrical_power_measurement',
    value,
    reportedAt: '2026-03-01T10:00:00.000Z',
  });

  it('converts milliwatts to watts', () => {
    expect(measuredWatts(node({ attributes: [powerAttribute(350_000)] }))).toBe(350);
  });

  it('reports an unreported or unreadable value as unknown, never zero', () => {
    expect(measuredWatts(node({ attributes: [] }))).toBeNull();
    expect(measuredWatts(node({ attributes: [powerAttribute(null)] }))).toBeNull();
    expect(measuredWatts(node({ attributes: [powerAttribute('350000')] }))).toBeNull();
    expect(formatMeasurement(null, 'W')).toBe('Not reported');
  });

  it('converts cumulative energy from milliwatt-hours', () => {
    const energyNode = node({
      attributes: [
        {
          path: '1/145/1',
          endpointId: 1,
          clusterId: 145,
          attributeId: 1,
          cluster: 'electrical_energy_measurement',
          value: 2_500_000,
          reportedAt: '2026-03-01T10:00:00.000Z',
        },
      ],
    });
    expect(measuredEnergyWh(energyNode)).toBe(2500);
  });

  it('reads On/Off only from a boolean', () => {
    const onOff = (value: unknown) =>
      node({
        attributes: [
          {
            path: '1/6/0',
            endpointId: 1,
            clusterId: 6,
            attributeId: 0,
            cluster: 'on_off',
            value,
            reportedAt: '2026-03-01T10:00:00.000Z',
          },
        ],
      });
    expect(reportedOnOff(onOff(true))).toBe(true);
    expect(reportedOnOff(onOff(null))).toBeNull();
    expect(reportedOnOff(onOff(1))).toBeNull();
  });
});

describe('summariseFabric', () => {
  it('counts the loads that can be commanded but not verified', () => {
    const summary = summariseFabric([
      // Controllable and metered: verifiable.
      node({
        nodeId: '4',
        capabilities: [
          { endpointId: 1, clusterId: 6, cluster: 'on_off' },
          { endpointId: 1, clusterId: 144, cluster: 'electrical_power_measurement' },
        ],
        attributes: [
          {
            path: '1/144/10',
            endpointId: 1,
            clusterId: 144,
            attributeId: 10,
            cluster: 'electrical_power_measurement',
            value: 350_000,
            reportedAt: '2026-03-01T10:00:00.000Z',
          },
        ],
      }),
      // Controllable, never measured: a dispatch here cannot be observed.
      node({ nodeId: '5' }),
      // Metered only.
      node({
        nodeId: '6',
        capabilities: [{ endpointId: 1, clusterId: 144, cluster: 'electrical_power_measurement' }],
      }),
      node({ nodeId: '7', available: false }),
      node({ nodeId: '900001', isTestNode: true }),
      node({ nodeId: '8', removedAt: '2026-03-01T09:00:00.000Z' }),
    ]);

    expect(summary).toEqual({
      nodes: 6,
      reachable: 4,
      unreachable: 1,
      removed: 1,
      syntheticNodes: 1,
      controllable: 3,
      meteredOnly: 1,
      // Nodes 5 and 900001 are controllable-shaped with no measurement, but the
      // synthetic one is not dispatchable at all, so only node 5 counts.
      controllableWithoutMeasurement: 1,
    });
  });
});
