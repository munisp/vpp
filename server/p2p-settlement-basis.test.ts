/**
 * Pinning tests for the settlement-basis audit fixes:
 *  - M1: what a purchase owes is resolved from its p2p_matches rows (energy,
 *    amount, sellers, sell legs), not from the trade row's limit-price total;
 *    trades matched before p2p_matches existed fall back to the legacy
 *    counterparty/metadata columns; a trade with neither refuses loudly.
 *  - M2: a match priced outside EITHER side's limit is a corrupt record and
 *    stops settlement loudly instead of paying the wrong amount.
 *  - M4 (settlement half): the settlement row's sellTradeId comes from
 *    p2p_matches.sellOrderId — the sole sell leg when there is exactly one,
 *    null for a multi-seller purchase (which the reconciliation note names
 *    instead of implying a single leg).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { getTableName, type Table } from 'drizzle-orm';

type Row = Record<string, unknown>;

/* ------------------------------------------------------------------ */
/* M1/M2: resolveSettlementBasis takes its db handle as a parameter.   */
/* ------------------------------------------------------------------ */

function basisDb(rows: { matches: Row[]; sellLegs: Row[] }) {
  return {
    select: () => ({
      from: (table: Table) => ({
        where: () => ({
          then: (resolve: (rows: Row[]) => unknown) =>
            Promise.resolve(getTableName(table) === 'p2p_matches' ? rows.matches : rows.sellLegs).then(resolve),
        }),
      }),
    }),
  } as never;
}

const buyTrade = (overrides: Row = {}): Row => ({
  id: 10,
  userId: 7,
  tradeType: 'p2p_buy',
  status: 'pending',
  energy: 250,
  price: 120, // buyer limit: 120c/kWh
  totalAmount: 30,
  counterpartyId: null,
  metadata: null,
  ...overrides,
});

// One purchase matched against TWO sell legs: 150 Wh and 100 Wh, both at 120c/kWh.
const twoMatches: Row[] = [
  { id: 1, buyOrderId: 10, sellOrderId: 101, buyerId: 7, sellerId: 8, energyWh: 150, priceCentsPerKwh: 120, totalAmountCents: 18 },
  { id: 2, buyOrderId: 10, sellOrderId: 102, buyerId: 7, sellerId: 9, energyWh: 100, priceCentsPerKwh: 120, totalAmountCents: 12 },
];
const twoSellLegs: Row[] = [
  { id: 101, userId: 8, tradeType: 'p2p_sell', price: 110, energy: 150 },
  { id: 102, userId: 9, tradeType: 'p2p_sell', price: 115, energy: 100 },
];

describe('resolveSettlementBasis from p2p_matches (M1)', () => {
  it('resolves a 1-buy x 2-sell purchase: 150 Wh + 100 Wh at 120c/kWh', async () => {
    const { resolveSettlementBasis } = await import('./services/p2p-settlement');
    const basis = await resolveSettlementBasis(basisDb({ matches: twoMatches, sellLegs: twoSellLegs }), buyTrade() as never);

    expect(basis.source).toBe('p2p_matches');
    expect(basis.energyWh).toBe(250);
    expect(basis.totalAmountCents).toBe(30); // 150*120/1000 + 100*120/1000
    expect(basis.sellerIds).toEqual([8, 9]);
    expect(basis.sellTradeIds).toEqual([101, 102]);
    expect(basis.matches.map(m => m.sellTradeId)).toEqual([101, 102]);
  });

  it('falls back to legacy counterparty columns when no match rows exist', async () => {
    const { resolveSettlementBasis } = await import('./services/p2p-settlement');
    const trade = buyTrade({ counterpartyId: 8, metadata: JSON.stringify({ sellOfferId: 101 }) });
    const basis = await resolveSettlementBasis(basisDb({ matches: [], sellLegs: [] }), trade as never);

    expect(basis.source).toBe('legacy_trade_columns');
    expect(basis.sellerIds).toEqual([8]);
    expect(basis.sellTradeIds).toEqual([101]);
    expect(basis.energyWh).toBe(250);
    expect(basis.totalAmountCents).toBe(30);
  });

  it('refuses a trade with neither matches nor a counterparty', async () => {
    const { resolveSettlementBasis, P2pSettlementError } = await import('./services/p2p-settlement');
    await expect(
      resolveSettlementBasis(basisDb({ matches: [], sellLegs: [] }), buyTrade() as never)
    ).rejects.toMatchObject({ code: 'TRADE_UNMATCHED' } satisfies Partial<InstanceType<typeof P2pSettlementError>>);
  });
});

describe('match price limit enforcement (M2)', () => {
  it("refuses a match priced above the buyer's limit", async () => {
    const { resolveSettlementBasis } = await import('./services/p2p-settlement');
    const matches = [{ ...twoMatches[0], priceCentsPerKwh: 121 }];
    await expect(
      resolveSettlementBasis(basisDb({ matches, sellLegs: [twoSellLegs[0]] }), buyTrade() as never)
    ).rejects.toMatchObject({ code: 'MATCH_PRICE_OUT_OF_LIMITS' });
  });

  it("refuses a match priced below the seller's limit", async () => {
    const { resolveSettlementBasis } = await import('./services/p2p-settlement');
    const matches = [{ ...twoMatches[0], priceCentsPerKwh: 109 }]; // seller's limit is 110
    await expect(
      resolveSettlementBasis(basisDb({ matches, sellLegs: [twoSellLegs[0]] }), buyTrade() as never)
    ).rejects.toMatchObject({ code: 'MATCH_PRICE_OUT_OF_LIMITS' });
  });

  it('refuses a match that names a seller who does not own the sell leg', async () => {
    const { resolveSettlementBasis } = await import('./services/p2p-settlement');
    const matches = [{ ...twoMatches[0], sellerId: 99 }];
    await expect(
      resolveSettlementBasis(basisDb({ matches, sellLegs: [twoSellLegs[0]] }), buyTrade() as never)
    ).rejects.toMatchObject({ code: 'MATCH_SELLER_MISMATCH' });
  });
});

/* ------------------------------------------------------------------ */
/* M4: recordBuyerPaymentSettled keys the settlement row by the match. */
/* ------------------------------------------------------------------ */

interface Captured {
  settlementInserts: Row[];
  tradeUpdates: Row[];
}

function settledDb(rows: { matches: Row[]; sellLegs: Row[]; buyTrade: Row }, captured: Captured) {
  const selectFrom = (table: Table) => ({
    where: () => ({
      limit: async () => (getTableName(table) === 'trades' ? [rows.buyTrade] : []),
      then: (resolve: (rows: Row[]) => unknown) =>
        Promise.resolve(
          getTableName(table) === 'p2p_matches' ? rows.matches : rows.sellLegs
        ).then(resolve),
    }),
  });
  const db = {
    select: () => ({ from: selectFrom }),
    update: (table: Table) => ({
      set: (values: Row) => ({
        where: async () => {
          if (getTableName(table) === 'trades') captured.tradeUpdates.push(values);
        },
      }),
    }),
    insert: (table: Table) => ({
      values: (values: Row) => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            if (getTableName(table) === 'p2p_settlements') captured.settlementInserts.push(values);
            return [{ id: 42 }];
          },
        }),
        returning: async () => [{ id: 42 }],
      }),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  vi.doMock('./db', () => ({ getDb: async () => db }));
  vi.doMock('./services/ledger/postings', () => ({
    postBuyerPaymentCaptured: async () => ({ state: 'posted', detail: 'posted' }),
  }));
  vi.doMock('./services/ledger/tigerbeetle', () => ({
    LedgerRefusedError: class LedgerRefusedError extends Error {},
  }));
}

function settledPayment(amount: number): Row {
  return {
    id: 55,
    userId: 7,
    amount,
    currency: 'TZS',
    transactionId: 'PROVIDER-REF-1',
    p2pTradeId: 10,
    paymentMethod: 'mpesa',
    metadata: JSON.stringify({ buyTradeId: 10 }),
  };
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('./db');
  vi.doUnmock('./services/ledger/postings');
  vi.doUnmock('./services/ledger/tigerbeetle');
});

describe('settlement row records the matched sell leg (M4)', () => {
  it('names the sole sellOrderId for a single-seller purchase', async () => {
    const captured: Captured = { settlementInserts: [], tradeUpdates: [] };
    settledDb({ matches: [twoMatches[0]], sellLegs: [twoSellLegs[0]], buyTrade: buyTrade() }, captured);
    const { recordBuyerPaymentSettled } = await import('./services/p2p-settlement');

    const result = await recordBuyerPaymentSettled(settledPayment(18) as never);

    expect(captured.settlementInserts).toHaveLength(1);
    expect(captured.settlementInserts[0].sellTradeId).toBe(101);
    expect(captured.settlementInserts[0].sellerId).toBe(8);
    expect(result.sellTradeId).toBe(101);
    expect(result.sellerPayoutAvailable).toBe(false);
  });

  it('leaves sellTradeId null for a multi-seller purchase instead of naming one leg', async () => {
    const captured: Captured = { settlementInserts: [], tradeUpdates: [] };
    settledDb({ matches: twoMatches, sellLegs: twoSellLegs, buyTrade: buyTrade() }, captured);
    const { recordBuyerPaymentSettled } = await import('./services/p2p-settlement');

    const result = await recordBuyerPaymentSettled(settledPayment(30) as never);

    expect(captured.settlementInserts).toHaveLength(1);
    expect(captured.settlementInserts[0].sellTradeId).toBeNull();
    // The reporting key is the seller owed the largest share (18 > 12).
    expect(captured.settlementInserts[0].sellerId).toBe(8);
    expect(result.sellTradeId).toBeNull();
    // Both seller legs were moved to buyer-paid, not just one.
    expect(captured.tradeUpdates.length).toBe(3); // buy leg + 2 sell legs
  });

  it('refuses a payment whose amount does not equal the matched total', async () => {
    const captured: Captured = { settlementInserts: [], tradeUpdates: [] };
    settledDb({ matches: twoMatches, sellLegs: twoSellLegs, buyTrade: buyTrade() }, captured);
    const { recordBuyerPaymentSettled } = await import('./services/p2p-settlement');

    await expect(recordBuyerPaymentSettled(settledPayment(29) as never)).rejects.toMatchObject({
      code: 'AMOUNT_MISMATCH',
    });
    expect(captured.settlementInserts).toHaveLength(0);
  });
});
