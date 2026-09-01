/**
 * Pinning test for M6: 'executed' is a claim that money and energy moved, so
 * routers/trading.ts updateStatus only accepts it when a p2p_settlements row in
 * its terminal 'complete' state is linked to the trade. No caller — admin
 * included — may declare a trade settled by hand.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

type Row = Record<string, unknown>;

const trade: Row = {
  id: 10,
  userId: 7,
  tradeType: 'p2p_buy',
  status: 'pending',
  energy: 2000,
  price: 120,
  totalAmount: 240,
};

function mockDeps(evidenceRows: Row[]) {
  const tx = {
    update: () => ({ set: () => ({ where: async () => ({ rowCount: 1 }) }) }),
  };
  const conn = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => evidenceRows }) }),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  };
  vi.doMock('./db', () => ({
    getTradeById: async () => trade,
    getDb: async () => conn,
    getUserById: async () => ({ id: 7, email: null, name: 'Buyer' }),
    createAlert: async () => ({}),
  }));
  vi.doMock('./services/events/outbox', () => ({ enqueueEvent: async () => undefined }));
  vi.doMock('./integration/temporal-client', () => ({ temporalClient: {} }));
  vi.doMock('./_core/sendNotification', () => ({ sendPushNotification: async () => ({ success: true }) }));
  vi.doMock('./_core/emailService', () => ({ sendEmail: async () => ({ success: true }) }));
  vi.doMock('./_core/auditLog', () => ({
    createAuditLog: async () => undefined,
    getClientIP: () => '127.0.0.1',
    getUserAgent: () => 'test',
  }));
}

async function callerFor(userId: number, role: 'user' | 'admin') {
  const { tradingRouter } = await import('./routers/trading');
  return tradingRouter.createCaller({ user: { id: userId, role, name: 'T' }, req: {} } as never);
}

afterEach(() => {
  vi.resetModules();
  for (const m of [
    './db',
    './services/events/outbox',
    './integration/temporal-client',
    './_core/sendNotification',
    './_core/emailService',
    './_core/auditLog',
  ]) {
    vi.doUnmock(m);
  }
});

describe('updateStatus executed requires settlement evidence (M6)', () => {
  it('a trade owner can never set executed themselves', async () => {
    mockDeps([{ id: 1, state: 'complete' }]);
    const caller = await callerFor(7, 'user');
    await expect(caller.updateStatus({ tradeId: 10, status: 'executed' })).rejects.toThrow(
      /Only cancellation is self-service/
    );
  });

  it('an admin cannot mark executed with no settlement row', async () => {
    mockDeps([]);
    const caller = await callerFor(1, 'admin');
    await expect(caller.updateStatus({ tradeId: 10, status: 'executed' })).rejects.toThrow(
      /without settlement evidence/
    );
  });

  it("an admin cannot mark executed while the settlement is not 'complete'", async () => {
    mockDeps([{ id: 1, state: 'buyer_paid_seller_unpaid' }]);
    const caller = await callerFor(1, 'admin');
    await expect(caller.updateStatus({ tradeId: 10, status: 'executed' })).rejects.toThrow(
      /without settlement evidence/
    );
  });

  it("accepts executed when a 'complete' settlement row names the trade", async () => {
    mockDeps([{ id: 1, state: 'complete' }]);
    const caller = await callerFor(1, 'admin');
    const result = await caller.updateStatus({ tradeId: 10, status: 'executed' });
    expect(result.success).toBe(true);
  });
});
