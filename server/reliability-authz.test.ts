/**
 * Trust boundaries on the reliability router.
 *
 * Interruption records name a customer's connection, the times their power was
 * off and the evidence behind it, so the fleet view is an operator's view. A
 * member gets exactly their own connections — and gets them by the server
 * filtering on their user id, not by the client asking nicely — while
 * registering a connection or recording an interruption is refused outright.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

interface ServiceCall {
  fn: string;
  filter: unknown;
}

const calls: ServiceCall[] = [];

function mockReliabilityService() {
  vi.doMock('./services/service-reliability', () => ({
    SERVICE_POINT_CLASSES: ['household', 'business', 'institution', 'productive_use'] as const,
    SERVICE_POINT_MONITORING: ['metered_telemetry', 'reported_only', 'unmonitored'] as const,
    INTERRUPTION_CAUSES: [
      'utility_grid_outage',
      'generation_shortfall',
      'storage_depleted',
      'equipment_fault',
      'planned_maintenance',
      'load_shedding',
      'payment_disconnection',
      'unknown',
    ] as const,
    INTERRUPTION_DETECTION_SOURCES: [
      'meter_event',
      'telemetry_gap',
      'device_offline_event',
      'operator_declared',
      'customer_reported',
    ] as const,
    ServiceReliabilityError: class ServiceReliabilityError extends Error {},
    reliabilityReport: async (_period: unknown, filter: unknown) => {
      calls.push({ fn: 'reliabilityReport', filter });
      return { indices: {}, coverage: {}, limitations: [] };
    },
    listServicePoints: async (filter: unknown) => {
      calls.push({ fn: 'listServicePoints', filter });
      return [];
    },
    listInterruptions: async (filter: unknown) => {
      calls.push({ fn: 'listInterruptions', filter });
      return [];
    },
    setServicePointMonitoring: async () => {
      calls.push({ fn: 'setServicePointMonitoring', filter: null });
      return {};
    },
    disconnectServicePoint: async () => {
      calls.push({ fn: 'disconnectServicePoint', filter: null });
      return {};
    },
    reconnectServicePoint: async () => {
      calls.push({ fn: 'reconnectServicePoint', filter: null });
      return {};
    },
    registerServicePoint: async () => {
      calls.push({ fn: 'registerServicePoint', filter: null });
      return {};
    },
    recordInterruption: async () => {
      calls.push({ fn: 'recordInterruption', filter: null });
      return {};
    },
    closeInterruption: async () => {
      calls.push({ fn: 'closeInterruption', filter: null });
      return {};
    },
    detectInterruptionsFromTelemetryGaps: async () => {
      calls.push({ fn: 'detectInterruptionsFromTelemetryGaps', filter: null });
      return { reporting: 0, opened: [], closed: [], skipped: [] };
    },
  }));
}

async function callerFor(userId: number, role: 'user' | 'admin') {
  mockReliabilityService();
  const { reliabilityRouter } = await import('./routers/nextgen/reliability');
  return reliabilityRouter.createCaller({ user: { id: userId, role } } as never);
}

const period = { start: new Date('2026-08-01T00:00:00Z'), end: new Date('2026-08-31T00:00:00Z') };

afterEach(() => {
  calls.length = 0;
  vi.resetModules();
  vi.doUnmock('./services/service-reliability');
});

describe('fleet reliability is an operator view', () => {
  it('refuses a member the fleet report', async () => {
    const caller = await callerFor(8, 'user');
    await expect(caller.report(period)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('refuses a member the connection register', async () => {
    const caller = await callerFor(8, 'user');
    await expect(caller.servicePoints({})).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('refuses a member the fleet interruption history', async () => {
    const caller = await callerFor(8, 'user');
    await expect(caller.interruptions({ limit: 10 })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('refuses a member the registration of a connection', async () => {
    const caller = await callerFor(8, 'user');
    await expect(
      caller.registerServicePoint({
        userId: 8,
        code: 'SP-1',
        pointClass: 'household',
        monitoring: 'reported_only',
        connectedAt: new Date('2026-01-01T00:00:00Z'),
      })
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('refuses a member the recording of an interruption', async () => {
    const caller = await callerFor(8, 'user');
    await expect(
      caller.recordInterruption({
        servicePointId: 1,
        startedAt: new Date('2026-08-02T00:00:00Z'),
        cause: 'utility_grid_outage',
        detectionSource: 'operator_declared',
        evidenceRef: 'ticket:1',
      })
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('refuses a member the disconnection of a connection', async () => {
    const caller = await callerFor(8, 'user');
    await expect(
      caller.disconnectServicePoint({ id: 1, disconnectedAt: new Date('2026-08-10T00:00:00Z') })
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('refuses a member a change to how their connection is monitored', async () => {
    const caller = await callerFor(8, 'user');
    await expect(
      caller.setServicePointMonitoring({ id: 1, monitoring: 'unmonitored' })
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('refuses a member the meter sweep', async () => {
    const caller = await callerFor(8, 'user');
    await expect(caller.detectGaps({})).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('serves an admin the fleet report', async () => {
    const caller = await callerFor(1, 'admin');
    await caller.report(period);
    expect(calls).toEqual([{ fn: 'reliabilityReport', filter: { communityId: undefined } }]);
  });
});

describe('a member sees their own supply only', () => {
  it('scopes their connections to their own user id', async () => {
    const caller = await callerFor(8, 'user');
    await caller.myServicePoints();
    expect(calls).toEqual([{ fn: 'listServicePoints', filter: { userId: 8 } }]);
  });

  it('computes their indices over their own connections, not the fleet', async () => {
    const caller = await callerFor(8, 'user');
    const result = await caller.myReliability(period);

    // Every read is filtered server-side by the caller's own id.
    for (const call of calls) {
      expect(call.filter).toMatchObject({ userId: 8 });
    }
    expect(calls.map((call) => call.fn).sort()).toEqual([
      'listInterruptions',
      'listServicePoints',
      'reliabilityReport',
    ]);
    // Indices, not just rows: a customer asking about their supply gets the
    // figures, not a list they have to average themselves.
    expect(result?.assessment).toBeDefined();
  });
});
