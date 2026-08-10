import { z } from "zod";
import { router, protectedProcedure, adminProcedure } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import {
  drForecasts,
  drEventTemplates,
  drAutomationRules,
  gridMonitoring,
} from "../../drizzle/schema";
import { desc, gte, lte, and, eq } from "drizzle-orm";
import {
  generateLoadForecast,
  saveForecast,
  generateDailyForecasts,
  getUpcomingForecasts,
} from "../dr-forecasting";
import { evaluateAutomationRules } from "../dr-automation";
import { calculateDynamicPrice, getPricingRecommendation } from "../dr-pricing";

/**
 * DR Forecasting and Automation Router
 */
export const drForecastingRouter = router({
  /**
   * Get upcoming forecasts
   */
  getForecasts: protectedProcedure
    .input(
      z.object({
        hours: z.number().int().min(1).max(168).optional().default(24),
      })
    )
    .query(async ({ input }) => {
      return await getUpcomingForecasts(input.hours);
    }),

  /**
   * Generate forecast for specific time
   */
  generateForecast: adminProcedure
    .input(
      z.object({
        targetDate: z.date(),
        targetHour: z.number().int().min(0).max(23),
        temperature: z.number().optional(),
        weatherCondition: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const result = await generateLoadForecast(input);
      await saveForecast(input, result);
      return result;
    }),

  /**
   * Generate daily forecasts (24 hours)
   */
  generateDailyForecasts: adminProcedure.mutation(async () => {
    await generateDailyForecasts();
    return { success: true, message: "Generated forecasts for next 24 hours" };
  }),

  /**
   * Get grid monitoring data
   */
  getGridStatus: protectedProcedure
    .input(
      z.object({
        hours: z.number().int().min(1).max(168).optional().default(24),
      })
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const since = new Date();
      since.setHours(since.getHours() - input.hours);

      return await db
        .select()
        .from(gridMonitoring)
        .where(gte(gridMonitoring.timestamp, since))
        .orderBy(desc(gridMonitoring.timestamp))
        .limit(100);
    }),

  /**
   * Get latest grid status
   */
  getLatestGridStatus: protectedProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

    const result = await db
      .select()
      .from(gridMonitoring)
      .orderBy(desc(gridMonitoring.timestamp))
      .limit(1);

    return result[0] || null;
  }),

  /**
   * Get event templates
   */
  getEventTemplates: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

    return await db.select().from(drEventTemplates).orderBy(drEventTemplates.name);
  }),

  /**
   * Create event template
   */
  createEventTemplate: adminProcedure
    .input(
      z.object({
        name: z.string().min(1),
        eventType: z.enum(["peak_shaving", "load_shifting", "emergency", "economic"]),
        defaultDuration: z.number().int().positive(),
        defaultTargetReduction: z.number().int().positive(),
        defaultCompensationRate: z.number().int().positive(),
        triggerCondition: z.enum([
          "manual",
          "peak_forecast",
          "grid_stress",
          "price_spike",
          "renewable_surplus",
        ]),
        triggerThreshold: z.number().int().optional(),
        advanceNoticeMinutes: z.number().int().positive().optional().default(60),
      })
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      await db.insert(drEventTemplates).values(input);
      return { success: true };
    }),

  /**
   * Update event template
   */
  updateEventTemplate: adminProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        isActive: z.enum(["true", "false"]).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      await db
        .update(drEventTemplates)
        .set({ isActive: input.isActive })
        .where(eq(drEventTemplates.id, input.id));

      return { success: true };
    }),

  /**
   * Get automation rules
   */
  getAutomationRules: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

    return await db.select().from(drAutomationRules).orderBy(desc(drAutomationRules.priority));
  }),

  /**
   * Create automation rule
   */
  createAutomationRule: adminProcedure
    .input(
      z.object({
        name: z.string().min(1),
        templateId: z.number().int().positive(),
        condition: z.enum([
          "load_threshold",
          "price_threshold",
          "grid_frequency",
          "renewable_percentage",
          "time_based",
        ]),
        operator: z.enum(["greater_than", "less_than", "equals", "between"]),
        threshold: z.number().int(),
        thresholdMax: z.number().int().optional(),
        activeHoursStart: z.number().int().min(0).max(23).optional(),
        activeHoursEnd: z.number().int().min(0).max(23).optional(),
        activeDays: z.string().optional(),
        cooldownMinutes: z.number().int().positive().optional().default(120),
        priority: z.number().int().min(1).max(10).optional().default(5),
      })
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      await db.insert(drAutomationRules).values(input);
      return { success: true };
    }),

  /**
   * Update automation rule
   */
  updateAutomationRule: adminProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        isEnabled: z.enum(["true", "false"]).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      await db
        .update(drAutomationRules)
        .set({ isEnabled: input.isEnabled })
        .where(eq(drAutomationRules.id, input.id));

      return { success: true };
    }),

  /**
   * Manually trigger automation evaluation
   */
  evaluateRules: adminProcedure.mutation(async () => {
    await evaluateAutomationRules();
    return { success: true, message: "Automation rules evaluated" };
  }),

  /**
   * Calculate dynamic pricing for DR event
   */
  calculateDynamicPrice: adminProcedure
    .input(
      z.object({
        eventType: z.enum(["peak_shaving", "load_shifting", "emergency", "economic"]),
        targetReduction: z.number().int().positive(),
        startTime: z.date(),
      })
    )
    .query(async ({ input }) => {
      return await calculateDynamicPrice(
        input.eventType,
        input.targetReduction,
        input.startTime
      );
    }),

  /**
   * Get pricing recommendation
   */
  getPricingRecommendation: adminProcedure
    .input(
      z.object({
        eventType: z.enum(["peak_shaving", "load_shifting", "emergency", "economic"]),
        targetReduction: z.number().int().positive(),
        startTime: z.date(),
      })
    )
    .query(async ({ input }) => {
      return await getPricingRecommendation(
        input.eventType,
        input.targetReduction,
        input.startTime
      );
    }),
});
