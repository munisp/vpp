import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { users } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

export const onboardingRouter = router({
  // Get current onboarding status
  getStatus: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

    const [user] = await db
      .select({
        onboardingCompleted: users.onboardingCompleted,
        onboardingStep: users.onboardingStep,
        onboardingSkipped: users.onboardingSkipped,
      })
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .limit(1);

    if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });

    return {
      completed: user.onboardingCompleted,
      currentStep: user.onboardingStep,
      skipped: user.onboardingSkipped,
    };
  }),

  // Update onboarding step
  updateStep: protectedProcedure
    .input(
      z.object({
        step: z.number().min(0).max(5),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      await db
        .update(users)
        .set({
          onboardingStep: input.step,
          onboardingCompleted: input.step >= 5,
        })
        .where(eq(users.id, ctx.user.id));

      return { success: true, step: input.step };
    }),

  // Complete onboarding
  complete: protectedProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

    await db
      .update(users)
      .set({
        onboardingCompleted: true,
        onboardingStep: 5,
      })
      .where(eq(users.id, ctx.user.id));

    return { success: true };
  }),

  // Skip onboarding
  skip: protectedProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

    await db
      .update(users)
      .set({
        onboardingSkipped: true,
        onboardingCompleted: true,
        onboardingStep: 5,
      })
      .where(eq(users.id, ctx.user.id));

    return { success: true };
  }),

  // Reset onboarding (for testing or re-onboarding)
  reset: protectedProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

    await db
      .update(users)
      .set({
        onboardingCompleted: false,
        onboardingStep: 0,
        onboardingSkipped: false,
      })
      .where(eq(users.id, ctx.user.id));

    return { success: true };
  }),
});
