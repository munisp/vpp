import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { contracts } from "../../drizzle/schema";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";

/**
 * Contracts: the aggregation agreement a member is billed and paid under.
 *
 * Revenue share, monthly fee and minimum guarantee are settlement inputs — they
 * decide what the platform keeps and what the member is owed — so a member may
 * read their own contract but only an operator may write one. Invoicing already
 * refuses to bill a member with no active contract; before this router existed
 * there was no way to give them one, so that refusal could never be cleared.
 */

const CreateContractSchema = z.object({
  userId: z.number().int().positive(),
  contractType: z.enum(["asset_aggregation", "full_control", "prepaid"]),
  revenueSharePercentage: z.number().int().min(0).max(100).default(70),
  monthlyFee: z.number().int().nonnegative().default(0),
  minimumRevenue: z.number().int().nonnegative().default(0),
  startDate: z.date().default(() => new Date()),
  endDate: z.date().optional(),
  terms: z.string().max(4_000).optional(),
});

async function db() {
  const instance = await getDb();
  if (!instance) {
    throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Database not available" });
  }
  return instance;
}

export const contractsRouter = router({
  /** The caller's own contracts, newest first. */
  mine: protectedProcedure.query(async ({ ctx }) => {
    const instance = await db();
    return instance
      .select()
      .from(contracts)
      .where(eq(contracts.userId, ctx.user.id))
      .orderBy(desc(contracts.createdAt));
  }),

  /** The caller's active contract, or null when they are not under one. */
  myActive: protectedProcedure.query(async ({ ctx }) => {
    const instance = await db();
    const rows = await instance
      .select()
      .from(contracts)
      .where(and(eq(contracts.userId, ctx.user.id), eq(contracts.status, "active")))
      .orderBy(desc(contracts.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }),

  /** Every contract for one member, for an operator reviewing their account. */
  listForUser: adminProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const instance = await db();
      return instance
        .select()
        .from(contracts)
        .where(eq(contracts.userId, input.userId))
        .orderBy(desc(contracts.createdAt));
    }),

  /**
   * Sign a member onto a contract. A member may hold only one active contract:
   * two would leave settlement with two revenue shares and no rule for which
   * one an invoice was computed under.
   */
  create: adminProcedure.input(CreateContractSchema).mutation(async ({ input }) => {
    const instance = await db();
    const existing = await instance
      .select({ id: contracts.id })
      .from(contracts)
      .where(and(eq(contracts.userId, input.userId), eq(contracts.status, "active")))
      .limit(1);
    if (existing.length > 0) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `User ${input.userId} already holds active contract ${existing[0].id}.`,
      });
    }
    if (input.endDate && input.endDate <= input.startDate) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "A contract must end after it starts." });
    }

    const inserted = await instance
      .insert(contracts)
      .values({
        userId: input.userId,
        contractType: input.contractType,
        revenueSharePercentage: input.revenueSharePercentage,
        monthlyFee: input.monthlyFee,
        minimumRevenue: input.minimumRevenue,
        startDate: input.startDate,
        endDate: input.endDate ?? null,
        status: "active",
        metadata: input.terms ? JSON.stringify({ terms: input.terms }) : null,
      })
      .returning({ id: contracts.id });

    return { contractId: Number(inserted[0].id), status: "active" as const };
  }),

  /**
   * End a contract. Past invoices stay as issued: they were computed under the
   * terms in force when they were raised.
   */
  cancel: adminProcedure
    .input(z.object({ contractId: z.number().int().positive(), reason: z.string().max(500) }))
    .mutation(async ({ input }) => {
      const instance = await db();
      const updated = await instance
        .update(contracts)
        .set({ status: "cancelled", endDate: new Date() })
        .where(and(eq(contracts.id, input.contractId), eq(contracts.status, "active")))
        .returning({ id: contracts.id });
      if (updated.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No active contract ${input.contractId} to cancel.`,
        });
      }
      return { contractId: input.contractId, status: "cancelled" as const };
    }),
});

export type ContractsRouter = typeof contractsRouter;
