/**
 * Market participant identity.
 *
 * Trading already refuses an unverified business (`assertCanTrade`), but until
 * now nothing could declare an account as a business or verify one: the columns
 * could only be set by hand in the database, which means in practice every
 * trade was a household trade and B2B/P2B/B2P existed only in the schema. This
 * router closes that: a member declares the business they trade as, and an
 * operator verifies it against evidence they name.
 *
 * Declaring is not verifying. A declaration takes effect immediately for
 * invoicing identity but leaves the account unable to trade until an operator
 * has verified it, because the platform has no evidence the account is the
 * business it claims to be.
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { eq, isNotNull, isNull, and, desc } from 'drizzle-orm';

import { router, protectedProcedure, adminProcedure } from '../_core/trpc';
import { getDb } from '../db';
import { users } from '../../drizzle/schema';
import { createAuditLog } from '../_core/auditLog';
import { loadParticipant, ParticipantError } from '../services/p2p-participants';

const DeclareBusinessSchema = z.object({
  legalName: z.string().trim().min(2).max(255),
  registrationNumber: z.string().trim().min(2).max(100),
});

const VerifySchema = z.object({
  userId: z.number().int().positive(),
  /** What the operator checked. Stored on the audit trail, not on the user. */
  evidence: z.string().trim().min(10).max(1000),
});

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database not available' });
  }
  return db;
}

function toProfile(participant: Awaited<ReturnType<typeof loadParticipant>>) {
  const verified = participant.businessVerifiedAt !== null;
  return {
    userId: participant.userId,
    participantType: participant.participantType,
    displayName: participant.displayName,
    businessLegalName: participant.businessLegalName,
    businessRegistrationNumber: participant.businessRegistrationNumber,
    businessVerifiedAt: participant.businessVerifiedAt,
    /**
     * Whether this account may currently hold a market position. A business
     * that has declared but not been verified reads `false` with a reason,
     * rather than discovering it at the point of trading.
     */
    canTrade: participant.participantType === 'person' || verified,
    blockedReason:
      participant.participantType === 'business' && !verified
        ? 'The business identity has not been verified by an operator yet.'
        : null,
  };
}

export const marketParticipantsRouter = router({
  /** The account's own participant identity, and whether it can trade. */
  me: protectedProcedure.query(async ({ ctx }) => {
    try {
      return toProfile(await loadParticipant(ctx.user.id));
    } catch (error) {
      if (error instanceof ParticipantError) {
        throw new TRPCError({ code: 'NOT_FOUND', message: error.message });
      }
      throw error;
    }
  }),

  /**
   * Declare that this account trades as a business. Re-declaring updates the
   * details, and any details change drops an existing verification: the
   * operator verified a named legal entity, not the account.
   */
  declareBusiness: protectedProcedure
    .input(DeclareBusinessSchema)
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const before = await loadParticipant(ctx.user.id);
      const detailsChanged =
        before.businessLegalName !== input.legalName ||
        before.businessRegistrationNumber !== input.registrationNumber;
      const verificationDropped = before.businessVerifiedAt !== null && detailsChanged;

      await db
        .update(users)
        .set({
          participantType: 'business',
          businessLegalName: input.legalName,
          businessRegistrationNumber: input.registrationNumber,
          ...(verificationDropped ? { businessVerifiedAt: null, businessVerifiedBy: null } : {}),
        })
        .where(eq(users.id, ctx.user.id));

      await createAuditLog({
        userId: ctx.user.id,
        userName: ctx.user.name ?? undefined,
        userRole: ctx.user.role === 'admin' ? 'admin' : 'user',
        action: 'configure',
        entityType: 'user',
        entityId: String(ctx.user.id),
        entityName: input.legalName,
        changes: {
          participantType: 'business',
          businessLegalName: input.legalName,
          businessRegistrationNumber: input.registrationNumber,
          verificationDropped,
        },
        description: 'Declared a business trading identity',
      });

      const after = toProfile(await loadParticipant(ctx.user.id));
      return {
        ...after,
        verificationDropped,
        message: after.canTrade
          ? 'Business identity recorded.'
          : 'Business identity recorded. An operator must verify it before this account can trade.',
      };
    }),

  /** Revert to trading as a household. Clears any business verification. */
  declarePerson: protectedProcedure.mutation(async ({ ctx }) => {
    const db = await requireDb();
    await db
      .update(users)
      .set({
        participantType: 'person',
        businessLegalName: null,
        businessRegistrationNumber: null,
        businessVerifiedAt: null,
        businessVerifiedBy: null,
      })
      .where(eq(users.id, ctx.user.id));

    await createAuditLog({
      userId: ctx.user.id,
      userName: ctx.user.name ?? undefined,
      userRole: ctx.user.role === 'admin' ? 'admin' : 'user',
      action: 'configure',
      entityType: 'user',
      entityId: String(ctx.user.id),
      description: 'Reverted to a household trading identity',
    });

    return toProfile(await loadParticipant(ctx.user.id));
  }),

  /** Businesses awaiting verification, for an operator to work through. */
  pendingVerification: adminProcedure
    .input(z.object({ limit: z.number().int().positive().max(200).default(50) }).optional())
    .query(async ({ input }) => {
      const db = await requireDb();
      const rows = await db
        .select({
          userId: users.id,
          displayName: users.name,
          email: users.email,
          businessLegalName: users.businessLegalName,
          businessRegistrationNumber: users.businessRegistrationNumber,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(and(eq(users.participantType, 'business'), isNull(users.businessVerifiedAt)))
        .orderBy(desc(users.createdAt))
        .limit(input?.limit ?? 50);
      return { participants: rows, count: rows.length };
    }),

  /** Businesses an operator has already verified. */
  verified: adminProcedure
    .input(z.object({ limit: z.number().int().positive().max(200).default(50) }).optional())
    .query(async ({ input }) => {
      const db = await requireDb();
      const rows = await db
        .select({
          userId: users.id,
          businessLegalName: users.businessLegalName,
          businessRegistrationNumber: users.businessRegistrationNumber,
          businessVerifiedAt: users.businessVerifiedAt,
          businessVerifiedBy: users.businessVerifiedBy,
        })
        .from(users)
        .where(and(eq(users.participantType, 'business'), isNotNull(users.businessVerifiedAt)))
        .orderBy(desc(users.businessVerifiedAt))
        .limit(input?.limit ?? 50);
      return { participants: rows, count: rows.length };
    }),

  /**
   * Verify a declared business. Refused when the account has not declared the
   * identity being verified: there would be nothing to verify, and a
   * verification timestamp with no legal entity behind it is what
   * `assertCanTrade` already refuses to trade on.
   */
  verifyBusiness: adminProcedure.input(VerifySchema).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const participant = await loadParticipant(input.userId);

    if (participant.participantType !== 'business') {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'This account does not trade as a business, so there is nothing to verify.',
      });
    }
    if (!participant.businessLegalName || !participant.businessRegistrationNumber) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message:
          'This account has not declared a legal name and registration number, so no legal entity can be verified.',
      });
    }

    const verifiedAt = new Date();
    await db
      .update(users)
      .set({ businessVerifiedAt: verifiedAt, businessVerifiedBy: ctx.user.id })
      .where(eq(users.id, input.userId));

    await createAuditLog({
      userId: ctx.user.id,
      userName: ctx.user.name ?? undefined,
      userRole: 'admin',
      action: 'approve',
      entityType: 'user',
      entityId: String(input.userId),
      entityName: participant.businessLegalName,
      changes: {
        businessLegalName: participant.businessLegalName,
        businessRegistrationNumber: participant.businessRegistrationNumber,
        evidence: input.evidence,
      },
      description: 'Verified a business trading identity',
    });

    return {
      ...toProfile(await loadParticipant(input.userId)),
      verifiedBy: ctx.user.id,
    };
  }),

  /**
   * Withdraw a verification. The account keeps its declared identity and stops
   * being able to trade, which is what should happen when a registration
   * lapses.
   */
  revokeVerification: adminProcedure
    .input(z.object({ userId: z.number().int().positive(), reason: z.string().trim().min(10).max(1000) }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const participant = await loadParticipant(input.userId);
      if (participant.businessVerifiedAt === null) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This account is not verified, so there is no verification to withdraw.',
        });
      }

      await db
        .update(users)
        .set({ businessVerifiedAt: null, businessVerifiedBy: null })
        .where(eq(users.id, input.userId));

      await createAuditLog({
        userId: ctx.user.id,
        userName: ctx.user.name ?? undefined,
        userRole: 'admin',
        action: 'reject',
        entityType: 'user',
        entityId: String(input.userId),
        entityName: participant.businessLegalName ?? undefined,
        changes: { reason: input.reason },
        description: 'Withdrew a business verification',
      });

      return toProfile(await loadParticipant(input.userId));
    }),
});
