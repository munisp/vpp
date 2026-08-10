import { z } from "zod";
import { router, protectedProcedure, adminProcedure } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { subscribe, unsubscribe, listMySubscriptions, checkPriceAlerts } from "../services/price-alert-engine";

/**
 * Price Alert Engine router (feature 14).
 *
 * Thin wrappers over the engine service; the base CRUD lives in the existing
 * server/routers/priceAlerts.ts (untouched). checkPriceAlerts() is exported
 * from server/services/price-alert-engine.ts for the scheduler the lead wires.
 */
export const priceAlertEngineRouter = router({
  /**
   * Subscribe to a market price threshold (creates alert + market scope).
   */
  subscribe: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(500),
        description: z.string().max(2000).optional(),
        alertType: z.enum(["above", "below", "between"]),
        targetPrice: z.number().int().positive().optional(),
        minPrice: z.number().int().positive().optional(),
        maxPrice: z.number().int().positive().optional(),
        country: z.enum(["nigeria", "tanzania"]),
        priceType: z.enum(["off_peak", "shoulder", "peak", "super_peak"]),
        notifyPush: z.boolean().default(true),
        notifySMS: z.boolean().default(false),
        cooldownMinutes: z.number().int().min(1).max(10080).default(60),
        maxTriggers: z.number().int().positive().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if ((input.alertType === "above" || input.alertType === "below") && !input.targetPrice) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "targetPrice is required for above/below alerts." });
      }
      if (input.alertType === "between" && (!input.minPrice || !input.maxPrice || input.minPrice >= input.maxPrice)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "between alerts require minPrice < maxPrice." });
      }
      try {
        return await subscribe({ ...input, userId: ctx.user.id });
      } catch (error) {
        console.error("[PriceAlertEngine] subscribe failed:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to create subscription." });
      }
    }),

  /**
   * Unsubscribe (deletes alert + scope, ownership-verified).
   */
  unsubscribe: protectedProcedure
    .input(z.object({ priceAlertId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await unsubscribe(input.priceAlertId, ctx.user.id);
        return { success: true };
      } catch (error: any) {
        const notFound = error?.message === "Price alert subscription not found";
        throw new TRPCError({
          code: notFound ? "NOT_FOUND" : "INTERNAL_SERVER_ERROR",
          message: notFound ? "Subscription not found." : "Failed to unsubscribe.",
        });
      }
    }),

  /**
   * List the caller's subscriptions with their market scopes.
   */
  listMySubscriptions: protectedProcedure.query(async ({ ctx }) => {
    try {
      const subscriptions = await listMySubscriptions(ctx.user.id);
      return { subscriptions, count: subscriptions.length };
    } catch (error) {
      console.error("[PriceAlertEngine] listMySubscriptions failed:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to list subscriptions." });
    }
  }),

  /**
   * Admin: run one evaluation cycle now (the same engine the scheduler calls).
   */
  runEvaluation: adminProcedure.mutation(async () => {
    try {
      return await checkPriceAlerts();
    } catch (error) {
      console.error("[PriceAlertEngine] runEvaluation failed:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to evaluate price alerts." });
    }
  }),
});
