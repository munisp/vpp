/**
 * Pinning tests for the offer/accept audit fixes:
 *  - M4 (router half): accepting an offer writes a p2p_matches row naming BOTH
 *    order ids — the same source of truth settlement resolves against — not
 *    just trade columns.
 *  - M5: getOffers reports committed/available energy from matcher fills and
 *    hides fully committed offers; acceptOffer locks the offer row, accepts a
 *    partial quantity, and refuses to accept more than remains (double-sell
 *    guard).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { getTableName, type Table } from 'drizzle-orm';

type Row = Record<string, unknown>;

interface Captured {
  matchInserts: Row[];
  tradeInserts: Row[];
  tradeUpdates: Row[];
  locked: boolean;
}

const offer: Row = {
  id: 101,
  userId: 8,
  tradeType: 'p2p_sell',
  status: 'pending',
  counterpartyId: null,
  energy: 1000,
  price: 120,
  totalAmount: 120,
  metadata: null,
};

function mockDeps(opts: { committedWh: number }, captured: Captured) {
  const tx = {
    select: (fields?: Row) => ({
      from: (table: Table) => {
        if (fields && 'committed' in fields) {
          return {
            where: () => ({
              then: (resolve: (rows: Row[]) => unknown) =>
                Promise.resolve([{ committed: opts.committedWh }]).then(resolve),
            }),
          };
        }
        return {
          where: () => ({
            limit: () => ({
              for: async (mode: string) => {
                expect(mode).toBe('update'); // the offer row must be locked
                captured.locked = true;
                return [offer];
              },
            }),
          }),
        };
      },
    }),
    update: (table: Table) => ({
      set: (values: Row) => ({
        where: async () => {
          if (getTableName(table) === 'trades') captured.tradeUpdates.push(values);
          return { rowCount: 1 };
        },
      }),
    }),
    insert: (table: Table) => ({
      values: (values: Row) => ({
        returning: async () => {
          if (getTableName(table) === 'p2p_matches') {
            captured.matchInserts.push(values);
            return [{ id: 301 }];
          }
          captured.tradeInserts.push(values);
          return [{ id: 201 }];
        },
      }),
    }),
  };
  vi.doMock('./db', () => ({
    getDb: async () => ({ transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx) }),
  }));
  vi.doMock('./services/p2p-settlement', () => ({
    P2pSettlementError: class P2pSettlementError extends Error {
      constructor(public code: string, message: string) {
        super(message);
      }
    },
    startTradePayment: async () => {
      throw new Error('not used by acceptOffer');
    },
  }));
  vi.doMock('./services/p2p-participants', () => ({
    ParticipantError: class ParticipantError extends Error {},
    loadTradingParticipant: async (userId: number) => ({ userId, participantType: 'household' }),
    counterpartyFacts: () => ({ relation: 'unrelated' }),
  }));
}

async function callerFor(userId: number) {
  const { p2pTradingRouter } = await import('./routers/p2p-trading');
  return p2pTradingRouter.createCaller({ user: { id: userId, role: 'user' } } as never);
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('./db');
  vi.doUnmock('./services/p2p-settlement');
  vi.doUnmock('./services/p2p-participants');
});

describe('acceptOffer records the match (M4)', () => {
  it('writes a p2p_matches row naming both order ids and both parties', async () => {
    const captured: Captured = { matchInserts: [], tradeInserts: [], tradeUpdates: [], locked: false };
    mockDeps({ committedWh: 0 }, captured);
    const caller = await callerFor(7);

    const result = await caller.acceptOffer({ offerId: 101 });

    expect(captured.locked).toBe(true);
    expect(captured.matchInserts).toHaveLength(1);
    expect(captured.matchInserts[0]).toMatchObject({
      buyOrderId: 201, // the buyer counter-trade this accept created
      sellOrderId: 101, // the offer
      buyerId: 7,
      sellerId: 8,
      energyWh: 1000,
      priceCentsPerKwh: 120,
      totalAmountCents: 120,
    });
    expect(captured.tradeInserts[0]).toMatchObject({
      userId: 7,
      tradeType: 'p2p_buy',
      counterpartyId: 8,
      status: 'pending',
    });
    expect(result.matchId).toBe(301);
    expect(result.settlement).toBe('awaiting_payment');
  });
});

describe('acceptOffer availability guard (M5)', () => {
  it('accepts a partial quantity and leaves the remainder open', async () => {
    const captured: Captured = { matchInserts: [], tradeInserts: [], tradeUpdates: [], locked: false };
    mockDeps({ committedWh: 250 }, captured); // order book already took 250 of 1000 Wh
    const caller = await callerFor(7);

    const result = await caller.acceptOffer({ offerId: 101, energyWh: 400 });

    expect(result.acceptedEnergyWh).toBe(400);
    expect(result.remainingEnergyWh).toBe(350);
    expect(result.amountDueCents).toBe(48); // 400 Wh * 120c/kWh / 1000
    expect(captured.matchInserts[0].energyWh).toBe(400);
    // Partially consumed offers stay on the market: the offer row is NOT
    // marked taken (no counterparty update).
    expect(captured.tradeUpdates).toHaveLength(0);
  });

  it('refuses to accept more than remains after matcher fills', async () => {
    const captured: Captured = { matchInserts: [], tradeInserts: [], tradeUpdates: [], locked: false };
    mockDeps({ committedWh: 250 }, captured);
    const caller = await callerFor(7);

    await expect(caller.acceptOffer({ offerId: 101, energyWh: 800 })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(caller.acceptOffer({ offerId: 101, energyWh: 751 })).rejects.toThrow(
      /Only 750 Wh of this offer remain available/
    );
    expect(captured.matchInserts).toHaveLength(0);
    expect(captured.tradeInserts).toHaveLength(0);
  });

  it('refuses an offer the order book has already fully committed', async () => {
    const captured: Captured = { matchInserts: [], tradeInserts: [], tradeUpdates: [], locked: false };
    mockDeps({ committedWh: 1000 }, captured);
    const caller = await callerFor(7);

    await expect(caller.acceptOffer({ offerId: 101 })).rejects.toThrow(/fully matched/);
    expect(captured.matchInserts).toHaveLength(0);
  });
});

describe('getOffers availability reporting (M5)', () => {
  it('reports committed/available energy and hides fully committed offers', async () => {
    const listed = [
      { id: 101, userId: 8, energy: 1000, price: 120, totalAmount: 120, timestamp: new Date(), createdAt: new Date(), committed: 250, sellerName: 'S', sellerParticipantType: 'household', sellerBusinessLegalName: null, sellerBusinessRegistrationNumber: null },
      { id: 102, userId: 9, energy: 500, price: 110, totalAmount: 55, timestamp: new Date(), createdAt: new Date(), committed: 500, sellerName: 'T', sellerParticipantType: 'household', sellerBusinessLegalName: null, sellerBusinessRegistrationNumber: null },
    ];
    vi.doMock('./db', () => ({
      getDb: async () => ({
        select: () => ({
          from: () => ({
            leftJoin: () => ({
              where: () => ({
                orderBy: () => ({ limit: async () => listed }),
              }),
            }),
          }),
        }),
      }),
    }));
    const caller = await callerFor(7);

    const offers = await caller.getOffers();

    expect(offers).toHaveLength(1); // 102 is fully committed and hidden
    expect(offers[0]).toMatchObject({ id: 101, committedEnergyWh: 250, availableEnergyWh: 750 });
    expect('committed' in offers[0]).toBe(false);
  });
});
