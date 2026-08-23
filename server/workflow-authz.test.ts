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
      caller.getWorkflowStatus({ workflowId: 'auto-trading-9-3-1700000000' })
    ).rejects.toThrow(/only read your own/);
    expect(queryCalls).toEqual([]);
  });

  it('serves the owner and an admin', async () => {
    const owner = await orchestratorCaller(8, 'user');
    await owner.getWorkflowStatus({ workflowId: 'auto-trading-8-3-1700000000' });

    const admin = await orchestratorCaller(1, 'admin');
    await admin.getWorkflowStatus({ workflowId: 'auto-trading-9-3-1700000000' });

    expect(queryCalls).toEqual(['getWorkflowDetails', 'getWorkflowDetails']);
  });
});

/**
 * Ownership used to be `workflowId.includes('-' + userId + '-')`, which the id
 * conventions here do not support: the second numeric segment is an asset, trade
 * or counterparty id, and several id shapes encode no user at all.
 */
describe('workflow ownership parsing', () => {
  it('reads the owner by position, not by finding the number anywhere in the id', async () => {
    const { workflowOwnerId, ownsWorkflow } = await import('./services/workflows/ownership');

    expect(workflowOwnerId('auto-trading-7-42-1700000000')).toBe(7);
    // `-42-` appears in the id as the asset, so user 42 must not be the owner.
    expect(ownsWorkflow('auto-trading-7-42-1700000000', 42)).toBe(false);
    expect(workflowOwnerId('manual-trade-3-91-1700000000')).toBe(3);
    expect(workflowOwnerId('p2p-trade-5-11-1700000000')).toBe(5);
    expect(workflowOwnerId('notification-1700000000-12')).toBe(12);
  });

  it('reads the owner of a payment workflow started by the member-facing route', async () => {
    const { workflowOwnerId, ownsWorkflow } = await import('./services/workflows/ownership');

    // `orchestrator.processPayment` builds `user-<userId>-<epochMs>` and the
    // Temporal client prefixes it, so the member keeps sight of their own payment.
    expect(workflowOwnerId('payment-user-8-1700000000000')).toBe(8);
    expect(ownsWorkflow('payment-user-8-1700000000000', 8)).toBe(true);
    expect(ownsWorkflow('payment-user-8-1700000000000', 1700000000000)).toBe(false);
    // `payment-<paymentId>` from the billing route encodes a payment row, not a
    // user: payment 8 must not become user 8's workflow.
    expect(workflowOwnerId('payment-8')).toBeNull();
  });

  it('leaves ids that encode no user unowned, so a non-admin is refused rather than guessed at', async () => {
    const { workflowOwnerId } = await import('./services/workflows/ownership');

    for (const id of [
      'payment-42',
      'trade-42',
      'dr-event-42',
      'reconciliation-2026-08-22-mpesa',
      'batch-notification-1700000000',
      '',
      'auto-trading-abc-1-2',
    ]) {
      expect(workflowOwnerId(id)).toBeNull();
    }
  });
});
