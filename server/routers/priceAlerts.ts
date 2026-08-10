import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  getUserPriceAlerts,
  getActivePriceAlerts,
  getPriceAlertById,
  createPriceAlert,
  updatePriceAlert,
  deletePriceAlert,
  recordAlertTrigger,
  shouldTriggerAlert,
  getAllActivePriceAlerts,
} from "../db-price-alerts";
import { getCurrentPrice } from "../db";

export const priceAlertsRouter = router({
  /**
   * List all price alerts for current user
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    return await getUserPriceAlerts(ctx.user.id);
  }),

  /**
   * List active price alerts for current user
   */
  listActive: protectedProcedure.query(async ({ ctx }) => {
    return await getActivePriceAlerts(ctx.user.id);
  }),

  /**
   * Get price alert by ID
   */
  getById: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const alert = await getPriceAlertById(input.id);
      if (!alert || alert.userId !== ctx.user.id) {
        throw new Error("Alert not found");
      }
      return alert;
    }),

  /**
   * Create new price alert
   */
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        alertType: z.enum(["above", "below", "between"]),
        targetPrice: z.number().optional(),
        minPrice: z.number().optional(),
        maxPrice: z.number().optional(),
        notifyEmail: z.boolean().default(true),
        notifyPush: z.boolean().default(true),
        notifySMS: z.boolean().default(false),
        cooldownMinutes: z.number().default(60),
        maxTriggers: z.number().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Validate price thresholds based on alert type
      if (input.alertType === "above" || input.alertType === "below") {
        if (!input.targetPrice) {
          throw new Error("Target price is required for above/below alerts");
        }
      } else if (input.alertType === "between") {
        if (!input.minPrice || !input.maxPrice) {
          throw new Error("Min and max prices are required for between alerts");
        }
        if (input.minPrice >= input.maxPrice) {
          throw new Error("Min price must be less than max price");
        }
      }

      const alertId = await createPriceAlert({
        userId: ctx.user.id,
        name: input.name,
        description: input.description,
        alertType: input.alertType,
        targetPrice: input.targetPrice,
        minPrice: input.minPrice,
        maxPrice: input.maxPrice,
        isActive: true,
        notifyEmail: input.notifyEmail,
        notifyPush: input.notifyPush,
        notifySMS: input.notifySMS,
        cooldownMinutes: input.cooldownMinutes,
        maxTriggers: input.maxTriggers,
        triggerCount: 0,
      });

      return { success: true, alertId };
    }),

  /**
   * Update price alert
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        alertType: z.enum(["above", "below", "between"]).optional(),
        targetPrice: z.number().optional(),
        minPrice: z.number().optional(),
        maxPrice: z.number().optional(),
        isActive: z.boolean().optional(),
        notifyEmail: z.boolean().optional(),
        notifyPush: z.boolean().optional(),
        notifySMS: z.boolean().optional(),
        cooldownMinutes: z.number().optional(),
        maxTriggers: z.number().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const alert = await getPriceAlertById(input.id);
      if (!alert || alert.userId !== ctx.user.id) {
        throw new Error("Alert not found");
      }

      const { id, ...updateData } = input;
      await updatePriceAlert(id, updateData);

      return { success: true };
    }),

  /**
   * Delete price alert
   */
  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const alert = await getPriceAlertById(input.id);
      if (!alert || alert.userId !== ctx.user.id) {
        throw new Error("Alert not found");
      }

      await deletePriceAlert(input.id);
      return { success: true };
    }),

  /**
   * Check alerts against current market price (for manual testing)
   */
  checkAlerts: protectedProcedure.query(async ({ ctx }) => {
    const alerts = await getActivePriceAlerts(ctx.user.id);
    
    // Get current peak price (most common trading time)
    const currentPrice = await getCurrentPrice(ctx.user.country || "tanzania", "peak");

    if (!currentPrice) {
      return { triggered: [], currentPrice: null };
    }

    const triggered = alerts.filter((alert) =>
      shouldTriggerAlert(alert, currentPrice.price)
    );

    return {
      triggered: triggered.map((a) => a.id),
      currentPrice: currentPrice.price,
      totalActive: alerts.length,
    };
  }),
});
