/**
 * The chart of accounts is the map from platform entities to ledger balances. If
 * a derivation ever changes, money starts landing in a different account than the
 * one that already holds it, so these tests pin the layout itself:
 *
 *  - an id is stable across processes and restarts, because it is derived, not issued
 *  - the same member on two currencies is two accounts, never one
 *  - two different kinds never collide, so a member's liability cannot be read as
 *    treasury cash
 *  - a member account cannot be derived without naming the member
 *  - transfer ids depend only on the business fact, which is what makes a retried
 *    provider callback idempotent rather than a second payment
 */

import { describe, it, expect } from 'vitest';
import {
  ACCOUNT_BALANCE_DIRECTION,
  ACCOUNT_KIND_CODES,
  LEDGER_CODES,
  accountIdFor,
  entityIdFor,
  transferIdFor,
} from './services/ledger/chart';
import { accountFlagsFor } from './services/ledger/tigerbeetle';
import { AccountFlags } from 'tigerbeetle-node';

describe('ledger account ids', () => {
  it('derives the same id for the same entity every time', () => {
    const first = accountIdFor({ kind: 'member_liability', currency: 'TZS', ownerUserId: 42 });
    const second = accountIdFor({ kind: 'member_liability', currency: 'TZS', ownerUserId: 42 });
    expect(first).toBe(second);
  });

  it('lays out the id as kind, ledger, entity', () => {
    const id = accountIdFor({ kind: 'member_liability', currency: 'TZS', ownerUserId: 42 });
    expect(id >> 96n).toBe(BigInt(ACCOUNT_KIND_CODES.member_liability));
    expect((id >> 64n) & 0xffffffffn).toBe(BigInt(LEDGER_CODES.TZS));
    expect(id & 0xffffffffffffffffn).toBe(42n);
  });

  it('keeps one member on two currencies as two accounts', () => {
    const tzs = accountIdFor({ kind: 'member_liability', currency: 'TZS', ownerUserId: 42 });
    const ngn = accountIdFor({ kind: 'member_liability', currency: 'NGN', ownerUserId: 42 });
    expect(tzs).not.toBe(ngn);
  });

  it('never collides across account kinds', () => {
    const ids = new Set(
      (['member_liability', 'gateway_clearing', 'treasury', 'fee_revenue'] as const).map(kind =>
        accountIdFor({ kind, currency: 'TZS', ownerUserId: 1, gatewayKey: 'mpesa' }).toString()
      )
    );
    expect(ids.size).toBe(4);
  });

  it('gives each gateway its own clearing account', () => {
    const mpesa = accountIdFor({ kind: 'gateway_clearing', currency: 'TZS', gatewayKey: 'mpesa' });
    const airtel = accountIdFor({ kind: 'gateway_clearing', currency: 'TZS', gatewayKey: 'airtel_money' });
    expect(mpesa).not.toBe(airtel);
  });

  it('refuses a member account with no member', () => {
    expect(() => accountIdFor({ kind: 'member_liability', currency: 'TZS' })).toThrow(/needs the member/);
    expect(() => accountIdFor({ kind: 'member_liability', currency: 'TZS', ownerUserId: 0 })).toThrow(
      /needs the member/
    );
  });

  it('refuses a gateway clearing account with no gateway', () => {
    expect(() => accountIdFor({ kind: 'gateway_clearing', currency: 'TZS' })).toThrow(/needs the gateway/);
  });

  it('never derives the reserved zero entity slot', () => {
    expect(entityIdFor({ kind: 'treasury', currency: 'USD' })).toBeGreaterThan(0n);
    expect(entityIdFor({ kind: 'gateway_clearing', currency: 'USD', gatewayKey: 'mpesa' })).toBeGreaterThan(0n);
  });
});

describe('ledger transfer ids', () => {
  it('derives the same id for the same business fact, so a retry cannot double-pay', () => {
    const fact = { postingKind: 'buyer_payment_captured', sourceType: 'payment', sourceId: 77 };
    expect(transferIdFor(fact)).toBe(transferIdFor(fact));
  });

  it('separates different facts about the same source', () => {
    const captured = transferIdFor({ postingKind: 'buyer_payment_captured', sourceType: 'payment', sourceId: 77 });
    const reversed = transferIdFor({ postingKind: 'buyer_payment_reversed', sourceType: 'payment', sourceId: 77 });
    expect(captured).not.toBe(reversed);
  });

  it('stays inside the range TigerBeetle accepts', () => {
    for (let sourceId = 1; sourceId < 200; sourceId++) {
      const id = transferIdFor({ postingKind: 'buyer_payment_captured', sourceType: 'payment', sourceId });
      expect(id).toBeGreaterThan(0n);
      expect(id).toBeLessThan((1n << 128n) - 1n);
    }
  });
});

describe('account flags', () => {
  it('stops a member being paid more than they are owed', () => {
    expect(ACCOUNT_BALANCE_DIRECTION.member_liability).toBe('credit');
    expect(accountFlagsFor('member_liability') & AccountFlags.debits_must_not_exceed_credits).toBeTruthy();
  });

  it('stops a gateway clearing account paying out money that was never received', () => {
    expect(ACCOUNT_BALANCE_DIRECTION.gateway_clearing).toBe('debit');
    expect(accountFlagsFor('gateway_clearing') & AccountFlags.credits_must_not_exceed_debits).toBeTruthy();
  });
});
