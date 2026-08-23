/**
 * Trust-boundary tests for workflow visibility and control.
 *
 * A Temporal execution carries its own input, which for the payment and trading
 * workflows means amounts, phone numbers and counterparties. Every procedure in
 * `workflowsRouter` was `protectedProcedure` with no role or ownership check, so
 * any signed-in member could list the whole fleet's executions, read their
 * history, and cancel or terminate another member's payment mid-flight.
 * `orchestrator.getWorkflowStatus` had the same read hole while its sibling
 * `cancelWorkflow` checked ownership.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

const queryCalls: string[] = [];

function mockTemporalQuery() {
  const record = (name: string) => {
    queryCalls.push(name);
  };
  vi.doMock('./integration/temporal-query', () => ({
    temporalQueryService: {
      listWorkflows: async () => {
        record('listWorkflows');
        return [];
      },
      getWorkflowDetails: async () => {
        record('getWorkflowDetails');
        return { workflowId: 'x', startTime: new Date(), status: 'running' };
      },
      getWorkflowStats: async () => {
        record('getWorkflowStats');
        return {};
      },
      getWorkflowHistory: async () => {
        record('getWorkflowHistory');
        return [];
      },
      cancelWorkflow: async () => {
        record('cancelWorkflow');
        return true;
      },
      terminateWorkflow: async () => {
        record('terminateWorkflow');
        return true;
      },
    },
  }));
}

function ctxFor(userId: number, role: 'user' | 'admin') {
  return { user: { id: userId, role } } as never;
}

async function workflowsCaller(userId: number, role: 'user' | 'admin') {
  mockTemporalQuery();
  const { workflowsRouter } = await import('./routers/workflows');
  return workflowsRouter.createCaller(ctxFor(userId, role));
}

afterEach(() => {
  queryCalls.length = 0;
  vi.resetModules();
  vi.doUnmock('./integration/temporal-query');
});

describe('workflowsRouter', () => {
  it('refuses a member every read', async () => {
    const caller = await workflowsCaller(8, 'user');

    await expect(caller.list({})).rejects.toThrow(/required permission/i);
    await expect(caller.getStats({})).rejects.toThrow(/required permission/i);
    await expect(caller.getDetails({ workflowId: 'payment-9-abc' })).rejects.toThrow(/required permission/i);
    await expect(caller.getHistory({ workflowId: 'payment-9-abc' })).rejects.toThrow(/required permission/i);
    expect(queryCalls).toEqual([]);
  });

  it('refuses a member cancelling or terminating anyone', async () => {
    const caller = await workflowsCaller(8, 'user');

    // Including a workflow the member could plausibly own: control of an
    // execution is an operator action, not a member one.
    await expect(
      caller.cancel({ workflowId: 'payment-8-abc', reason: 'mine' })
    ).rejects.toThrow(/required permission/i);
    await expect(
      caller.terminate({ workflowId: 'payment-9-abc', reason: 'theirs' })
    ).rejects.toThrow(/required permission/i);
    expect(queryCalls).toEqual([]);
  });

  it('serves an admin', async () => {
    const caller = await workflowsCaller(1, 'admin');

    await caller.list({});
    await caller.getDetails({ workflowId: 'payment-9-abc' });
    expect(queryCalls).toEqual(['listWorkflows', 'getWorkflowDetails']);
  });
});

describe('orchestrator.getWorkflowStatus', () => {
  async function orchestratorCaller(userId: number, role: 'user' | 'admin') {
    mockTemporalQuery();
    vi.doMock('./temporal/client', () => ({
      getTemporalClient: async () => null,
      isTemporalAvailable: () => false,
    }));
    const { orchestratorRouter } = await import('./routers/orchestrator');
    return orchestratorRouter.createCaller(ctxFor(userId, role));
  }

  afterEach(() => {
    vi.doUnmock('./temporal/client');
  });

  it("refuses another user's workflow", async () => {
    const caller = await orchestratorCaller(8, 'user');

    await expect(
      caller.getWorkflowStatus({ workflowId: 'payment-processing-9-1700000000' })
    ).rejects.toThrow(/only read your own/);
    expect(queryCalls).toEqual([]);
  });

  it('serves the owner and an admin', async () => {
    const owner = await orchestratorCaller(8, 'user');
    await owner.getWorkflowStatus({ workflowId: 'payment-processing-8-1700000000' });

    const admin = await orchestratorCaller(1, 'admin');
    await admin.getWorkflowStatus({ workflowId: 'payment-processing-9-1700000000' });

    expect(queryCalls).toEqual(['getWorkflowDetails', 'getWorkflowDetails']);
  });
});
