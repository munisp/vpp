/**
 * Pinning tests for the DR automation audit fixes:
 *
 *  - The frequency-deviation rule was dead code: it required
 *    f <= 49.8 AND f >= 50.2 simultaneously, which is unsatisfiable. The rule
 *    now fires on the deviation band: f <= 49.8 OR f >= 50.2.
 *  - enrollParticipants ran an invalid GROUP BY query whose drResponses join
 *    fanned out the capacity SUM, and inserted enrollment rows into
 *    drParticipants — a table with no eventId/participationStatus columns.
 *    The aggregate now joins only assets, and enrollments land in drResponses
 *    with participationStatus 'auto_enrolled'.
 *  - Compensation paid kW x (rate per kWh), ignoring the event duration. It
 *    now pays (avg kW reduction x event hours) x rate.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

// The schema tables are imported dynamically INSIDE each test: vi.resetModules
// gives the service under test a fresh module registry, and table identity
// comparisons only hold against schema objects from that same registry.
async function schema() {
  return import('../drizzle/schema');
}

async function importService() {
  vi.doMock('./services/redis-cache', () => ({
    redisCache: {
      cacheGridStatus: vi.fn(async () => undefined),
      getDREvent: vi.fn(async () => null),
      cacheDREvent: vi.fn(async () => undefined),
      invalidateDREvent: vi.fn(async () => undefined),
    },
  }));
  vi.doMock('./services/webhook-notifications', () => ({
    webhookNotificationService: {
      notifyGridStress: vi.fn(async () => undefined),
      notifyDREventTriggered: vi.fn(async () => undefined),
    },
  }));
  const { drAutomationService } = await import('./services/dr-automation');
  return drAutomationService as any;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('./db');
  vi.doUnmock('./services/redis-cache');
  vi.doUnmock('./services/webhook-notifications');
});

describe('frequency-deviation rule fires on the deviation band', () => {
  const conditions = (frequency: number) => ({
    loadLevel: 50,
    frequency,
    voltage: 230,
    temperature: 25,
    timestamp: new Date(),
  });

  it('fires at f=49.7 (under-frequency), not at f=50.0, and at f=50.3 (over-frequency)', async () => {
    const svc = await importService();
    const rule = svc
      .getAutomationRules()
      .find((r: any) => r.id === 'frequency-deviation');
    expect(rule).toBeDefined();
    // The rule still carries the intended thresholds.
    expect(rule.conditions).toMatchObject({ maxFrequency: 49.8, minFrequency: 50.2 });

    expect(svc.shouldTriggerEvent(rule, conditions(49.7))).toBe(true);
    expect(svc.shouldTriggerEvent(rule, conditions(50.0))).toBe(false);
    expect(svc.shouldTriggerEvent(rule, conditions(50.3))).toBe(true);
  });

  it('fires at the band edges and stays quiet inside it', async () => {
    const svc = await importService();
    const rule = svc.getAutomationRules().find((r: any) => r.id === 'frequency-deviation');

    expect(svc.shouldTriggerEvent(rule, conditions(49.8))).toBe(true);
    expect(svc.shouldTriggerEvent(rule, conditions(50.2))).toBe(true);
    expect(svc.shouldTriggerEvent(rule, conditions(49.9))).toBe(false);
    expect(svc.shouldTriggerEvent(rule, conditions(50.1))).toBe(false);
  });
});

describe('enrollParticipants aggregate query', () => {
  // Fixture: three candidate users. User 1 owns two assets (3000 + 4000) and
  // has several historical DR responses — the exact shape that used to fan
  // out SUM(capacity) through the drResponses join.
  const userRows = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const assetRows = [
    { userId: 1, capacity: 3000 },
    { userId: 1, capacity: 4000 },
    { userId: 2, capacity: 2000 },
  ];

  function fakeDb(tables: { users: any; assets: any; drResponses: any }) {
    const { users, assets, drResponses } = tables;
    const insertedResponses: any[] = [];
    const joins: any[] = [];
    const db = {
      select: (_fields: any) => {
        const builder: any = {
          from(table: any) {
            if (table !== users) throw new Error(`unexpected FROM table`);
            return builder;
          },
          leftJoin(table: any) {
            joins.push(table);
            // The fixed query aggregates assets only. A second join (the old
            // drResponses fan-out) fails this test loudly.
            if (table !== assets) {
              throw new Error('fan-out join: aggregate query must join only assets');
            }
            return builder;
          },
          where: () => builder,
          groupBy: () => builder,
          // Correct SQL semantics: one row per user, capacity = SUM of that
          // user's assets (each asset counted exactly once).
          then(resolve: any, reject: any) {
            const rows = userRows.map(u => ({
              userId: u.id,
              capacity: assetRows
                .filter(a => a.userId === u.id)
                .reduce((sum, a) => sum + a.capacity, 0),
            }));
            return Promise.resolve(rows).then(resolve, reject);
          },
        };
        return builder;
      },
      insert: (table: any) => ({
        values: async (rows: any[]) => {
          if (table !== drResponses) {
            throw new Error('event enrollment must be a drResponses row');
          }
          insertedResponses.push(...rows);
        },
      }),
    };
    return { db, insertedResponses, joins };
  }

  it('enrolls exactly the eligible participants with exact aggregates, in drResponses', async () => {
    const tables = await schema();
    const { db, insertedResponses, joins } = fakeDb(tables);
    vi.doMock('./db', () => ({ getDb: vi.fn(async () => db) }));
    const svc = await importService();

    const rule = {
      id: 'test-rule',
      name: 'Test',
      enabled: true,
      conditions: {},
      eventConfig: {
        targetReduction: 100,
        duration: 60,
        baselineCompensation: 150,
        performanceBonus: 0,
      },
      // 5000 minimum: user 1 (7000 = 3000 + 4000, each counted once despite
      // their response history) qualifies; user 2 (2000) and user 3 (0) do not.
      participantCriteria: { minCapacity: 5000 },
    };

    await svc.enrollParticipants(99, rule);

    expect(joins).toEqual([tables.assets]);
    expect(insertedResponses).toEqual([
      { eventId: 99, userId: 1, participationStatus: 'auto_enrolled' },
    ]);
  });
});

describe('DR compensation pays for energy, not power', () => {
  function fakeDb(tables: { demandResponseEvents: any }, event: any, responses: any[] = []) {
    const { demandResponseEvents } = tables;
    return {
      select: () => {
        let table: any = null;
        const builder: any = {
          from(t: any) {
            table = t;
            return builder;
          },
          where: () => builder,
          orderBy: () => builder,
          limit: () => builder,
          then(resolve: any, reject: any) {
            const rows = table === demandResponseEvents ? [event] : responses;
            return Promise.resolve(rows).then(resolve, reject);
          },
        };
        return builder;
      },
    };
  }

  it('10 kW over a 2-hour event at 150/kWh pays 20 kWh x 150', async () => {
    const event = {
      id: 5,
      compensationRate: 150,
      startTime: new Date(Date.UTC(2026, 0, 1, 10)),
      endTime: new Date(Date.UTC(2026, 0, 1, 12)),
    };
    const tables = await schema();
    const db = fakeDb(tables, event);
    vi.doMock('./db', () => ({ getDb: vi.fn(async () => db) }));
    const svc = await importService();

    const result = await svc.calculateCompensation(5, 1, 10);

    expect(result.eventDurationHours).toBe(2);
    expect(result.energyBasisKwh).toBe(20);
    expect(result.baseCompensation).toBe(20 * 150);
    expect(result.compensationRate).toBe(150);
    // No response history → no performance bonus on an unverifiable record.
    expect(result.performanceBonus).toBe(0);
    expect(result.totalCompensation).toBe(20 * 150);
  });

  it('a 30-minute event pays half an hour of energy', async () => {
    const event = {
      id: 6,
      compensationRate: 200,
      startTime: new Date(Date.UTC(2026, 0, 1, 10)),
      endTime: new Date(Date.UTC(2026, 0, 1, 10, 30)),
    };
    const tables = await schema();
    const db = fakeDb(tables, event);
    vi.doMock('./db', () => ({ getDb: vi.fn(async () => db) }));
    const svc = await importService();

    const result = await svc.calculateCompensation(6, 1, 10);

    expect(result.energyBasisKwh).toBe(5);
    expect(result.baseCompensation).toBe(1000);
  });
});
