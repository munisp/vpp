/**
 * Pinning tests for P15: demoting an administrator is only allowed while at
 * least one OTHER admin remains. The one rule covers both lockout paths —
 * demoting the last admin, and an admin demoting themselves while no other
 * admin exists.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

type Row = Record<string, unknown>;

function mockDeps(opts: { userBefore: Row | null; otherAdmins: Row[] }, updates: Row[]) {
  const dbInstance = {
    select: (fields?: Row) => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            fields ? opts.otherAdmins : opts.userBefore ? [opts.userBefore] : [],
        }),
      }),
    }),
    update: () => ({
      set: (values: Row) => ({
        where: async () => {
          updates.push(values);
        },
      }),
    }),
  };
  vi.doMock('./db', () => ({ getDb: async () => dbInstance }));
  vi.doMock('./_core/auditLog', () => ({
    createAuditLog: async () => undefined,
    getClientIP: () => '127.0.0.1',
    getUserAgent: () => 'test',
  }));
}

async function callerFor(userId: number, role: 'user' | 'admin') {
  const { adminRouter } = await import('./routers/admin');
  return adminRouter.createCaller({ user: { id: userId, role, name: 'A' }, req: {} } as never);
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('./db');
  vi.doUnmock('./_core/auditLog');
});

describe('updateUserRole last-admin guard (P15)', () => {
  it('refuses to demote the last remaining administrator', async () => {
    const updates: Row[] = [];
    mockDeps({ userBefore: { id: 2, role: 'admin', name: 'B' }, otherAdmins: [] }, updates);
    const caller = await callerFor(1, 'admin');

    await expect(caller.updateUserRole({ userId: 2, role: 'user' })).rejects.toThrow(
      /last remaining administrator/
    );
    expect(updates).toHaveLength(0);
  });

  it('refuses an admin demoting themselves while they are the only admin', async () => {
    const updates: Row[] = [];
    mockDeps({ userBefore: { id: 1, role: 'admin', name: 'A' }, otherAdmins: [] }, updates);
    const caller = await callerFor(1, 'admin');

    await expect(caller.updateUserRole({ userId: 1, role: 'user' })).rejects.toThrow(
      /cannot demote yourself while you are the only administrator/
    );
    expect(updates).toHaveLength(0);
  });

  it('allows demoting an admin while another admin remains', async () => {
    const updates: Row[] = [];
    mockDeps({ userBefore: { id: 2, role: 'admin', name: 'B' }, otherAdmins: [{ id: 1 }] }, updates);
    const caller = await callerFor(1, 'admin');

    const result = await caller.updateUserRole({ userId: 2, role: 'user' });
    expect(result.success).toBe(true);
    expect(updates).toEqual([{ role: 'user' }]);
  });

  it('a non-admin cannot change roles at all', async () => {
    const updates: Row[] = [];
    mockDeps({ userBefore: { id: 2, role: 'admin', name: 'B' }, otherAdmins: [{ id: 1 }] }, updates);
    const caller = await callerFor(8, 'user');

    await expect(caller.updateUserRole({ userId: 2, role: 'user' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(updates).toHaveLength(0);
  });
});
