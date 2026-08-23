/**
 * Market participants.
 *
 * P2P trading here is bilateral between typed participants, so all four
 * combinations are real and are recorded as such on the trade:
 *
 *   person   -> person    (P2P)
 *   person   -> business  (P2B)
 *   business -> person    (B2P)
 *   business -> business  (B2B)
 *
 * Nothing about the matching or the money changes with the type; what changes
 * is that the trade can state who its sides were. A business must be verified
 * before it trades: an unverified business is refused rather than traded as if
 * it were a household, because its invoicing and tax treatment are different
 * and the platform has no evidence it is the business it claims to be.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { users } from '../../drizzle/schema';

export type ParticipantType = 'person' | 'business';

/** How the two sides of a trade relate, from the seller's side outward. */
export type CounterpartyRelation = 'p2p' | 'p2b' | 'b2p' | 'b2b';

export class ParticipantError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ParticipantError';
  }
}

export interface Participant {
  userId: number;
  participantType: ParticipantType;
  displayName: string | null;
  businessLegalName: string | null;
  businessRegistrationNumber: string | null;
  businessVerifiedAt: Date | null;
}

export function relationOf(seller: ParticipantType, buyer: ParticipantType): CounterpartyRelation {
  if (seller === 'person') return buyer === 'person' ? 'p2p' : 'p2b';
  return buyer === 'person' ? 'b2p' : 'b2b';
}

/** The name a counterparty trades under: its legal name if it is a business. */
export function tradingName(participant: Participant): string | null {
  return participant.participantType === 'business'
    ? participant.businessLegalName ?? participant.displayName
    : participant.displayName;
}

export async function loadParticipant(userId: number): Promise<Participant> {
  const db = await getDb();
  if (!db) throw new ParticipantError('DATABASE_UNAVAILABLE', 'Database not available');

  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      participantType: users.participantType,
      businessLegalName: users.businessLegalName,
      businessRegistrationNumber: users.businessRegistrationNumber,
      businessVerifiedAt: users.businessVerifiedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!row) {
    throw new ParticipantError('PARTICIPANT_NOT_FOUND', `No participant ${userId} exists.`);
  }

  return {
    userId: row.id,
    participantType: row.participantType,
    displayName: row.name,
    businessLegalName: row.businessLegalName,
    businessRegistrationNumber: row.businessRegistrationNumber,
    businessVerifiedAt: row.businessVerifiedAt,
  };
}

/**
 * Refuse a participant that cannot legitimately hold a position: an
 * unverified business. Persons need no verification to trade their own
 * generation.
 */
export function assertCanTrade(participant: Participant): void {
  if (participant.participantType !== 'business') return;
  if (participant.businessVerifiedAt === null) {
    throw new ParticipantError(
      'BUSINESS_NOT_VERIFIED',
      'This account trades as a business, and its business identity has not been verified yet, so it cannot place or accept orders.'
    );
  }
  // A verification timestamp with no identity behind it is a verification of
  // nothing. The database rejects such a row, but records imported or built
  // elsewhere are checked here too rather than trusted.
  if (!participant.businessLegalName || !participant.businessRegistrationNumber) {
    throw new ParticipantError(
      'BUSINESS_NOT_VERIFIED',
      'This account is marked as a verified business but carries no legal name or registration number, so its counterparty cannot be identified and it cannot trade.'
    );
  }
}

export async function loadTradingParticipant(userId: number): Promise<Participant> {
  const participant = await loadParticipant(userId);
  assertCanTrade(participant);
  return participant;
}

/** The participant facts a trade records about its two sides. */
export function counterpartyFacts(seller: Participant, buyer: Participant) {
  return {
    relation: relationOf(seller.participantType, buyer.participantType),
    sellerParticipantType: seller.participantType,
    buyerParticipantType: buyer.participantType,
    sellerTradingName: tradingName(seller),
    buyerTradingName: tradingName(buyer),
    sellerBusinessRegistrationNumber: seller.businessRegistrationNumber,
    buyerBusinessRegistrationNumber: buyer.businessRegistrationNumber,
  };
}
