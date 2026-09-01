/**
 * Pinning test for P10: routers/nextgen/compliance.ts exposes regulatory
 * operations over the whole platform's evidence. Running checks, reading
 * summaries, generating reports and seeding jurisdiction rules are admin-only;
 * only reading the (public) rule text stays authenticated.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

function mockService() {
  vi.doMock('./services/compliance-automation', () => ({
    complianceAutomation: {
      getActiveRules: async () => [],
      runComplianceCheck: async () => ({ id: 1 }),
      getComplianceSummary: async () => ({}),
      generateComplianceReport: async () => ({ id: 2 }),
      initializeJurisdictionRules: async () => [],
    },
  }));
}

async function callerFor(role: 'user' | 'admin') {
  const { complianceRouter } = await import('./routers/nextgen/compliance');
  return complianceRouter.createCaller({ user: { id: role === 'admin' ? 1 : 8, role } } as never);
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('./services/compliance-automation');
});

describe('nextgen compliance router authorization (P10)', () => {
  it('a non-admin cannot run compliance checks', async () => {
    mockService();
    const caller = await callerFor('user');
    await expect(
      caller.runComplianceCheck({ ruleId: 1, scopeType: 'platform' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a non-admin cannot read summaries, generate reports, or seed rules', async () => {
    mockService();
    const caller = await callerFor('user');
    await expect(caller.getComplianceSummary()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller.generateComplianceReport({
        jurisdiction: 'NG',
        periodStart: new Date('2026-01-01'),
        periodEnd: new Date('2026-02-01'),
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.initializeJurisdictionRules({ jurisdiction: 'NG' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('a non-admin CAN read the active rule set (public regulatory text)', async () => {
    mockService();
    const caller = await callerFor('user');
    await expect(caller.getActiveRules({ jurisdiction: 'NG' })).resolves.toEqual([]);
  });

  it('an admin can run compliance checks', async () => {
    mockService();
    const caller = await callerFor('admin');
    await expect(
      caller.runComplianceCheck({ ruleId: 1, scopeType: 'platform' })
    ).resolves.toMatchObject({ id: 1 });
  });
});
