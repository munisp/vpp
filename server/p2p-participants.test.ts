import { describe, expect, it } from 'vitest';
import {
  ParticipantError,
  assertCanTrade,
  counterpartyFacts,
  relationOf,
  tradingName,
  type Participant,
} from './services/p2p-participants';

function person(overrides: Partial<Participant> = {}): Participant {
  return {
    userId: 1,
    participantType: 'person',
    displayName: 'Asha',
    businessLegalName: null,
    businessRegistrationNumber: null,
    businessVerifiedAt: null,
    ...overrides,
  };
}

function business(overrides: Partial<Participant> = {}): Participant {
  return {
    userId: 2,
    participantType: 'business',
    displayName: 'ops@kilimo',
    businessLegalName: 'Kilimo Cold Storage Ltd',
    businessRegistrationNumber: 'TZ-2019-441',
    businessVerifiedAt: new Date('2026-01-04T00:00:00Z'),
    ...overrides,
  };
}

describe('market participant relations', () => {
  it('names all four bilateral combinations', () => {
    expect(relationOf('person', 'person')).toBe('p2p');
    expect(relationOf('person', 'business')).toBe('p2b');
    expect(relationOf('business', 'person')).toBe('b2p');
    expect(relationOf('business', 'business')).toBe('b2b');
  });

  it('trades a business under its legal name, not its login name', () => {
    expect(tradingName(business())).toBe('Kilimo Cold Storage Ltd');
    expect(tradingName(person())).toBe('Asha');
  });

  it('records both sides of the trade, including registration numbers', () => {
    const facts = counterpartyFacts(business(), person());
    expect(facts.relation).toBe('b2p');
    expect(facts.sellerParticipantType).toBe('business');
    expect(facts.buyerParticipantType).toBe('person');
    expect(facts.sellerBusinessRegistrationNumber).toBe('TZ-2019-441');
    expect(facts.buyerBusinessRegistrationNumber).toBeNull();
  });
});

describe('who may hold a position', () => {
  it('lets a person trade without any verification', () => {
    expect(() => assertCanTrade(person())).not.toThrow();
  });

  it('lets a verified business trade', () => {
    expect(() => assertCanTrade(business())).not.toThrow();
  });

  it('refuses an unverified business rather than trading it as a household', () => {
    try {
      assertCanTrade(business({ businessVerifiedAt: null }));
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(ParticipantError);
      expect((error as ParticipantError).code).toBe('BUSINESS_NOT_VERIFIED');
    }
  });

  it('refuses a business that claims verification with no registration on record', () => {
    // The DB CHECK constraint forbids this pairing, but a record built or
    // imported outside Postgres is checked here too: a verification with no
    // identity behind it verifies nothing.
    const claimed = business({ businessLegalName: null, businessRegistrationNumber: null });
    try {
      assertCanTrade(claimed);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(ParticipantError);
      expect((error as ParticipantError).code).toBe('BUSINESS_NOT_VERIFIED');
    }
    expect(counterpartyFacts(claimed, person()).sellerBusinessRegistrationNumber).toBeNull();
  });
});
