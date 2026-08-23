/**
 * Matter ingest is where an appliance in someone's house becomes a controllable
 * load on the platform, so the dangerous failures are inventory that outlives
 * the fabric and telemetry that reads as zero. These tests pin the boundaries:
 *  - capability comes from the clusters a node published, never from its type
 *  - a node missing from a full inventory report is marked removed and made
 *    unavailable, not left dispatchable
 *  - a null attribute value is stored as null, because unknown is not zero
 *  - an attribute for a node the platform has never seen is refused rather than
 *    creating a node row out of one reading
 *  - a database outage raises, it does not render as an empty fabric
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Inserted {
  values: Record<string, unknown>;
  conflict: unknown;
}

interface Updated {
  set: Record<string, unknown>;
  returned: unknown[];
}

interface DbState {
  selectRows: unknown[];
  inserted: Inserted[];
  updated: Updated[];
  updateReturns: unknown[];
}

class SelectQuery {
  constructor(private readonly rows: unknown[]) {}
  where(): SelectQuery {
    return this;
  }
  orderBy(): SelectQuery {
    return this;
  }
  limit(): SelectQuery {
    return this;
  }
  then<TResult>(
    onFulfilled: (value: unknown[]) => TResult,
    onRejected?: (reason: unknown) => TResult
  ): Promise<TResult> {
    return Promise.resolve(this.rows).then(onFulfilled, onRejected);
  }
}

let state: DbState;

function mockDb(available = true) {
  const db = {
    select: () => ({ from: () => new SelectQuery(state.selectRows) }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: async (conflict: unknown) => {
          state.inserted.push({ values, conflict });
        },
      }),
    }),
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            state.updated.push({ set, returned: state.updateReturns });
            return state.updateReturns;
          },
        }),
      }),
    }),
  };
  vi.doMock('./db', () => ({ getDb: async () => (available ? db : null) }));
}

beforeEach(() => {
  vi.resetModules();
  state = { selectRows: [], inserted: [], updated: [], updateReturns: [] };
});

afterEach(() => {
  vi.doUnmock('./db');
  vi.restoreAllMocks();
});

describe('capabilitiesFromAttributes', () => {
  it('reads capability from published clusters, not from the device type', async () => {
    const { capabilitiesFromAttributes } = await import('./services/matter-ingest');

    const capabilities = capabilitiesFromAttributes({
      '1/6/0': true,
      '1/6/16385': 1,
      '1/144/10': 350000,
      '2/8/0': 128,
    });

    expect(capabilities).toEqual([
      { endpointId: 1, clusterId: 6, cluster: 'on_off' },
      { endpointId: 1, clusterId: 144, cluster: 'electrical_power_measurement' },
      { endpointId: 2, clusterId: 8, cluster: 'level_control' },
    ]);
  });

  it('gives a node that published nothing no capabilities at all', async () => {
    const { capabilitiesFromAttributes } = await import('./services/matter-ingest');
    expect(capabilitiesFromAttributes(null)).toEqual([]);
    expect(capabilitiesFromAttributes({})).toEqual([]);
  });

  it('skips a path it cannot attribute instead of guessing a cluster', async () => {
    const { capabilitiesFromAttributes } = await import('./services/matter-ingest');
    expect(capabilitiesFromAttributes({ '1/6': true, 'thermostat/setpoint': 21, '*/*/*': 1 })).toEqual(
      []
    );
  });

  it('names only the clusters the platform interprets and leaves the rest raw', async () => {
    const { capabilitiesFromAttributes } = await import('./services/matter-ingest');
    expect(capabilitiesFromAttributes({ '1/29/0': [] })).toEqual([
      { endpointId: 1, clusterId: 29, cluster: null },
    ]);
  });
});

describe('handleMatterNodes', () => {
  it('stores the inventory as reported, including the synthetic node flag', async () => {
    mockDb();
    const { handleMatterNodes } = await import('./services/matter-ingest');

    const result = await handleMatterNodes({
      fabric_id: '1',
      nodes: [
        { node_id: '4', available: true, is_bridge: false, is_test_node: false, attributes: { '1/6/0': true } },
        { node_id: '900001', available: true, is_bridge: false, is_test_node: true, attributes: null },
      ],
    });

    expect(result.stored).toBe(2);
    expect(state.inserted).toHaveLength(2);
    expect(state.inserted[0].values).toMatchObject({ nodeId: '4', available: true, isTestNode: false });
    expect(state.inserted[1].values).toMatchObject({ nodeId: '900001', isTestNode: true });
    // A node with no reported attributes stores none rather than an empty object
    // that would later read as "reported, nothing there".
    expect(state.inserted[1].values.reportedAttributes).toBeNull();
  });

  it('marks a node the controller stopped reporting unavailable as well as removed', async () => {
    mockDb();
    state.updateReturns = [{ id: 7 }];
    const { handleMatterNodes } = await import('./services/matter-ingest');

    const result = await handleMatterNodes({
      fabric_id: '1',
      nodes: [{ node_id: '4', available: true, is_bridge: false, is_test_node: false, attributes: null }],
    });

    expect(result.removed).toBe(1);
    expect(state.updated).toHaveLength(1);
    expect(state.updated[0].set.available).toBe(false);
    expect(state.updated[0].set.removedAt).toBeInstanceOf(Date);
  });

  it('refuses an identifier that is not a decimal Matter id', async () => {
    mockDb();
    const { GridProtocolError } = await import('./services/grid-protocol-ingest');
    const { handleMatterNodes } = await import('./services/matter-ingest');

    await expect(
      handleMatterNodes({
        fabric_id: '1',
        nodes: [
          { node_id: '0x4', available: true, is_bridge: false, is_test_node: false, attributes: null },
        ],
      })
    ).rejects.toThrow(GridProtocolError);
  });

  it('raises when the database is unavailable instead of reporting an empty fabric', async () => {
    mockDb(false);
    const { handleMatterNodes } = await import('./services/matter-ingest');
    await expect(handleMatterNodes({ fabric_id: '1', nodes: [] })).rejects.toThrow(/database unavailable/);
  });
});

describe('handleMatterNode', () => {
  it('upserts the announced node without retiring the rest of the fabric', async () => {
    mockDb();
    state.updateReturns = [{ id: 7 }];
    const { handleMatterNode } = await import('./services/matter-ingest');

    const result = await handleMatterNode({
      fabric_id: '1',
      node: {
        node_id: '6',
        available: true,
        is_bridge: false,
        is_test_node: false,
        attributes: { '1/6/0': true },
      },
    });

    expect(result.stored).toBe(1);
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0].values).toMatchObject({ fabricId: '1', nodeId: '6', available: true });
    // A node event says nothing about the other nodes, so nothing is reconciled:
    // an update here would mark every load the event omitted as removed.
    expect(state.updated).toHaveLength(0);
  });

  it('refuses an identifier that is not a decimal Matter id', async () => {
    mockDb();
    const { GridProtocolError } = await import('./services/grid-protocol-ingest');
    const { handleMatterNode } = await import('./services/matter-ingest');

    await expect(
      handleMatterNode({
        fabric_id: '1',
        node: { node_id: 'six', available: true, is_bridge: false, is_test_node: false, attributes: null },
      })
    ).rejects.toThrow(GridProtocolError);
  });
});

describe('handleMatterAttribute', () => {
  it('stores a null reading as null, because unknown is not zero', async () => {
    mockDb();
    state.selectRows = [{ id: 11 }];
    const { handleMatterAttribute } = await import('./services/matter-ingest');

    await handleMatterAttribute({ node_id: '4', attribute_path: '1/144/10', value: null });

    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0].values).toMatchObject({
      matterNodeId: 11,
      endpointId: 1,
      clusterId: 144,
      attributeId: 10,
      attributePath: '1/144/10',
    });
    expect(state.inserted[0].values.value).toBeNull();
  });

  it('keeps a value it cannot interpret verbatim', async () => {
    mockDb();
    state.selectRows = [{ id: 11 }];
    const { handleMatterAttribute } = await import('./services/matter-ingest');

    await handleMatterAttribute({
      node_id: '4',
      attribute_path: '1/29/0',
      value: [{ deviceType: 769, revision: 1 }],
    });

    expect(state.inserted[0].values.value).toEqual([{ deviceType: 769, revision: 1 }]);
  });

  it('refuses a report for a node it has never seen rather than inventing one', async () => {
    mockDb();
    state.selectRows = [];
    const { handleMatterAttribute } = await import('./services/matter-ingest');

    await expect(
      handleMatterAttribute({ node_id: '4', attribute_path: '1/6/0', value: true })
    ).rejects.toThrow(/has not been reported/);
    expect(state.inserted).toHaveLength(0);
  });

  it('refuses a path it cannot attribute to exactly one attribute', async () => {
    mockDb();
    state.selectRows = [{ id: 11 }];
    const { handleMatterAttribute } = await import('./services/matter-ingest');

    await expect(
      handleMatterAttribute({ node_id: '4', attribute_path: '1/6', value: true })
    ).rejects.toThrow(/<endpoint>\/<cluster>\/<attribute>/);
    await expect(
      handleMatterAttribute({ node_id: '4', attribute_path: '1/*/0', value: true })
    ).rejects.toThrow(/not numeric/);
  });
});

describe('handleMatterNodeRemoved', () => {
  it('reports whether a node was actually still commissioned', async () => {
    mockDb();
    const { handleMatterNodeRemoved } = await import('./services/matter-ingest');

    state.updateReturns = [{ id: 3 }];
    await expect(handleMatterNodeRemoved({ node_id: '4' })).resolves.toEqual({ removed: true });

    state.updateReturns = [];
    await expect(handleMatterNodeRemoved({ node_id: '4' })).resolves.toEqual({ removed: false });
  });
});

describe('listMatterNodes', () => {
  it('returns each node with its published capabilities and last raw values', async () => {
    mockDb();
    const reportedAt = new Date('2026-03-01T10:00:00.000Z');
    // One select serves both queries in this harness, so the rows carry the
    // fields of both shapes.
    state.selectRows = [
      {
        id: 11,
        fabricId: '1',
        nodeId: '4',
        available: true,
        isBridge: false,
        isTestNode: false,
        removedAt: null,
        lastReportedAt: reportedAt,
        reportedAttributes: { '1/6/0': true, '1/144/10': 350000 },
        matterNodeId: 11,
        endpointId: 1,
        clusterId: 144,
        attributeId: 10,
        attributePath: '1/144/10',
        value: null,
        reportedAt,
      },
    ];

    const { listMatterNodes } = await import('./services/matter-ingest');
    const nodes = await listMatterNodes();

    expect(nodes).toHaveLength(1);
    expect(nodes[0].capabilities).toEqual([
      { endpointId: 1, clusterId: 6, cluster: 'on_off' },
      { endpointId: 1, clusterId: 144, cluster: 'electrical_power_measurement' },
    ]);
    expect(nodes[0].attributes).toEqual([
      {
        path: '1/144/10',
        endpointId: 1,
        clusterId: 144,
        attributeId: 10,
        cluster: 'electrical_power_measurement',
        value: null,
        reportedAt,
      },
    ]);
  });

  it('raises when the database is unavailable', async () => {
    mockDb(false);
    const { listMatterNodes } = await import('./services/matter-ingest');
    await expect(listMatterNodes()).rejects.toThrow(/database unavailable/);
  });
});
