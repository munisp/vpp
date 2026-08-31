/**
 * Carbon Offset Marketplace (innovation 12)
 *
 * Users sell their real carbon_certificates rows to other users.
 *
 * Sellable state, enforced by conditional update at purchase time:
 * a certificate can be sold only while carbon_certificates.status = 'minted'
 * AND it is still owned by the seller AND it has never changed hands before
 * (no offset_transfers row for it). A retired certificate, a certificate
 * already transferred once, or one owned by someone else is refused. The
 * purchase path re-checks ownership and status inside the same transaction
 * as the ownership UPDATE, so a race between two buyers (or a concurrent
 * retirement) fails one of them instead of double-selling.
 *
 * The asking price is the seller's own declaration in their stated currency
 * — that is real data (it is their ask). The platform does not move money
 * here: this service records the listing, the state machine and the
 * certificate transfer. If payment rails are later wired in, the transfer
 * stays the receipt of the ownership change, not of a payment.
 *
 * State machine: active -> sold | cancelled. Terminal states never leave.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../db';
import { carbonCertificates } from '../../drizzle/innovations-schema';
import {
  offsetListings,
  offsetTransfers,
  type OffsetListing,
} from '../../drizzle/innov3-market-schema';

const SUPPORTED_CURRENCIES = ['NGN', 'TZS', 'USD'] as const;
export type OffsetCurrency = (typeof SUPPORTED_CURRENCIES)[number];

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  return db;
}

/**
 * Create a listing for a certificate the caller owns.
 * Throws: CERTIFICATE_NOT_FOUND, NOT_CERTIFICATE_OWNER,
 * CERTIFICATE_NOT_SELLABLE, CERTIFICATE_ALREADY_LISTED, INVALID_PRICE,
 * UNSUPPORTED_CURRENCY.
 */
export async function createListing(
  sellerUserId: number,
  input: { certificateId: number; askingPriceCents: number; currency: OffsetCurrency }
): Promise<OffsetListing> {
  const db = await requireDb();

  if (!Number.isInteger(input.askingPriceCents) || input.askingPriceCents <= 0) {
    throw new Error('INVALID_PRICE');
  }
  if (!SUPPORTED_CURRENCIES.includes(input.currency)) {
    throw new Error('UNSUPPORTED_CURRENCY');
  }

  return db.transaction(async (tx) => {
    const [cert] = await tx
      .select()
      .from(carbonCertificates)
      .where(eq(carbonCertificates.id, input.certificateId))
      .limit(1);
    if (!cert) throw new Error('CERTIFICATE_NOT_FOUND');
    if (cert.userId !== sellerUserId) throw new Error('NOT_CERTIFICATE_OWNER');
    // 'retired' certificates are consumed offsets; they can never be sold.
    if (cert.status !== 'minted') throw new Error('CERTIFICATE_NOT_SELLABLE');

    // A certificate that has already changed hands once is not sellable
    // again through this marketplace: the chain ends at one transfer so the
    // buyer's claim is always against the original minter's verified
    // generation.
    const [priorTransfer] = await tx
      .select({ id: offsetTransfers.id })
      .from(offsetTransfers)
      .where(eq(offsetTransfers.certificateId, input.certificateId))
      .limit(1);
    if (priorTransfer) throw new Error('CERTIFICATE_NOT_SELLABLE');

    const [activeListing] = await tx
      .select({ id: offsetListings.id })
      .from(offsetListings)
      .where(and(eq(offsetListings.certificateId, input.certificateId), eq(offsetListings.status, 'active')))
      .limit(1);
    if (activeListing) throw new Error('CERTIFICATE_ALREADY_LISTED');

    const [listing] = await tx
      .insert(offsetListings)
      .values({
        sellerUserId,
        certificateId: input.certificateId,
        askingPriceCents: input.askingPriceCents,
        currency: input.currency,
        status: 'active',
      })
      .returning();
    return listing;
  });
}

/**
 * Withdraw an active listing. Conditional update: only the seller, only
 * while still active. Throws LISTING_NOT_ACTIVE when the row is missing,
 * not theirs, or already terminal.
 */
export async function cancelListing(sellerUserId: number, listingId: number): Promise<OffsetListing> {
  const db = await requireDb();
  const updated = await db
    .update(offsetListings)
    .set({ status: 'cancelled', cancelledAt: new Date() })
    .where(
      and(
        eq(offsetListings.id, listingId),
        eq(offsetListings.sellerUserId, sellerUserId),
        eq(offsetListings.status, 'active')
      )
    )
    .returning();
  if (updated.length === 0) throw new Error('LISTING_NOT_ACTIVE');
  return updated[0];
}

export interface PurchaseResult {
  listing: OffsetListing;
  transferId: number;
  certificateId: number;
}

/**
 * Buy an active listing. One transaction:
 *  1. claim the listing (active -> sold) so a second buyer loses the race,
 *  2. move the certificate with a conditional UPDATE that only matches
 *     while it is still 'minted' and still the seller's,
 *  3. write the transfer receipt.
 * Any failed step rolls the whole purchase back.
 * Throws: LISTING_NOT_ACTIVE, CANNOT_BUY_OWN_LISTING,
 * CERTIFICATE_NOT_SELLABLE.
 */
export async function purchaseListing(buyerUserId: number, listingId: number): Promise<PurchaseResult> {
  const db = await requireDb();

  return db.transaction(async (tx) => {
    const [listing] = await tx.select().from(offsetListings).where(eq(offsetListings.id, listingId)).limit(1);
    if (!listing || listing.status !== 'active') throw new Error('LISTING_NOT_ACTIVE');
    if (listing.sellerUserId === buyerUserId) throw new Error('CANNOT_BUY_OWN_LISTING');

    // 1. Claim the listing. The status predicate makes this a compare-and-swap.
    const claimed = await tx
      .update(offsetListings)
      .set({ status: 'sold', buyerUserId, soldAt: new Date() })
      .where(and(eq(offsetListings.id, listingId), eq(offsetListings.status, 'active')))
      .returning();
    if (claimed.length === 0) throw new Error('LISTING_NOT_ACTIVE');

    // 2. Move the certificate, only while it is still sellable and the
    //    seller's. Zero rows updated => the certificate was retired or moved
    //    between listing and purchase => the purchase must not happen.
    const moved = await tx
      .update(carbonCertificates)
      .set({ userId: buyerUserId })
      .where(
        and(
          eq(carbonCertificates.id, listing.certificateId),
          eq(carbonCertificates.userId, listing.sellerUserId),
          eq(carbonCertificates.status, 'minted')
        )
      )
      .returning({ id: carbonCertificates.id });
    if (moved.length === 0) throw new Error('CERTIFICATE_NOT_SELLABLE');

    // 3. Receipt.
    const [transfer] = await tx
      .insert(offsetTransfers)
      .values({
        listingId: listing.id,
        certificateId: listing.certificateId,
        fromUserId: listing.sellerUserId,
        toUserId: buyerUserId,
        priceCents: listing.askingPriceCents,
        currency: listing.currency,
      })
      .returning({ id: offsetTransfers.id });

    return { listing: claimed[0], transferId: transfer.id, certificateId: listing.certificateId };
  });
}

/** Open marketplace view: active listings with the certificate's facts. */
export async function listActiveListings(opts: { limit: number }) {
  const db = await requireDb();
  return db
    .select({
      listing: offsetListings,
      certificate: {
        id: carbonCertificates.id,
        certificateHash: carbonCertificates.certificateHash,
        region: carbonCertificates.region,
        energyWh: carbonCertificates.energyWh,
        co2AvoidedGrams: carbonCertificates.co2AvoidedGrams,
        periodStart: carbonCertificates.periodStart,
        periodEnd: carbonCertificates.periodEnd,
        mintedAt: carbonCertificates.mintedAt,
      },
    })
    .from(offsetListings)
    .innerJoin(carbonCertificates, eq(offsetListings.certificateId, carbonCertificates.id))
    .where(eq(offsetListings.status, 'active'))
    .orderBy(desc(offsetListings.createdAt))
    .limit(opts.limit);
}

export async function listMyListings(userId: number, opts: { limit: number }) {
  const db = await requireDb();
  return db
    .select()
    .from(offsetListings)
    .where(eq(offsetListings.sellerUserId, userId))
    .orderBy(desc(offsetListings.createdAt))
    .limit(opts.limit);
}

export async function listMyTransfers(userId: number, opts: { limit: number }) {
  const db = await requireDb();
  return db
    .select()
    .from(offsetTransfers)
    .where(sql`${offsetTransfers.fromUserId} = ${userId} OR ${offsetTransfers.toUserId} = ${userId}`)
    .orderBy(desc(offsetTransfers.transferredAt))
    .limit(opts.limit);
}
