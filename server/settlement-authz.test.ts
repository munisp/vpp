/**
 * Trust-boundary tests for `settlement.createEvent`.
 *
 * The amount on a hand-written settlement event is not derived from anything the
 * platform measured, so end-to-end testing was able to append a member-authored
 * event crediting 999,999 Wh and 500,000 to the caller with no meter evidence at
 * all. The route is now operator-only, credits a named member rather than the
 * caller, and is refused when the evidence a claim of measured delivery or of
 * payment depends on is missing.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

const created: Array<Record<string, unknown>> = [];

function mockLedger() {
  vi.doMock('./services/settlement-ledger', () => ({
    settlementLedger: {
      createEvent: async (input: Record<string, unknown>) => {
        created.push(input);
        return { id: 1, ...input };
      },
    },
  }));
}

function mockCapabilities(refuse: string | null) {
  vi.doMock('./services/degraded-operation', async () => {
    const actual = await vi.importActual<typeof import('./services/degraded-operation')>(
      './services/degraded-operation'
    );
    return {
      ...actual,
      requireCapability: async (capability: string) => {
        if (refuse !== null) {
          throw new actual.DegradedOperationError(
            capability,
            ['meter_telemetry'],
            refuse
          );
        }
        return { posture: 'available' as const, missing: [], evidenceLimit: null };
      },
    };
  });
}

async function callerFor(userId: number, role: 'user' | 'admin') {
  const { settlementRouter } = await import('./routers/nextgen/settlement');
  return settlementRouter.createCaller({ user: { id: userId, role } } as never);
}

const event = {
  eventType: 'service_delivered' as const,
  sourceType: 'dispatch',
  sourceId: 7,
  energyWh: 999_999,
  grossAmount: 500_000,
  netAmount: 500_000,
  userId: 42,
};

afterEach(() => {
  created.length = 0;
  vi.resetModules();
  vi.doUnmock('./services/settlement-ledger');
  vi.doUnmock('./services/degraded-operation');
});

describe('settlement.createEvent', () => {
  it('refuses a member appending their own settlement event', async () => {
    mockLedger();
    mockCapabilities(null);
    const caller = await callerFor(42, 'user');

    await expect(caller.createEvent(event)).rejects.toThrow();
    expect(created).toEqual([]);
  });

  it('refuses an operator when the evidence behind the claim is missing', async () => {
    mockLedger();
    mockCapabilities('no meter reading in the settlement window');
    const caller = await callerFor(1, 'admin');

    await expect(caller.createEvent(event)).rejects.toThrow(/meter reading/);
    expect(created).toEqual([]);
  });

  it('credits the named member and records who wrote the row', async () => {
    mockLedger();
    mockCapabilities(null);
    const caller = await callerFor(1, 'admin');

    await caller.createEvent(event);

    expect(created).toHaveLength(1);
    // The operator is not the beneficiary: the ledger credits the member.
    expect(created[0].userId).toBe(42);
    expect((created[0].eventData as Record<string, unknown>).recordedByUserId).toBe(1);
  });

  it('holds a payment claim to the gateway evidence, not the meter', async () => {
    mockLedger();
    const capabilities: string[] = [];
    vi.doMock('./services/degraded-operation', async () => {
      const actual = await vi.importActual<typeof import('./services/degraded-operation')>(
        './services/degraded-operation'
      );
      return {
        ...actual,
        requireCapability: async (capability: string) => {
          capabilities.push(capability);
          return { posture: 'available' as const, missing: [], evidenceLimit: null };
        },
      };
    });
    const caller = await callerFor(1, 'admin');

    await caller.createEvent({ ...event, eventType: 'payment_completed', energyWh: undefined });
    expect(capabilities).toEqual(['settlement_payout']);
  });
});
