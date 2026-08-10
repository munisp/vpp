import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  getAllStrategyTemplates,
  getStrategyTemplateById,
  getStrategyTemplatesByCategory,
  incrementTemplateCloneCount,
} from "../db-strategy-templates";
import { tradingStrategies } from "../../drizzle/schema";
import { getDb } from "../db";

export const strategyTemplatesRouter = router({
  /**
   * List all strategy templates
   */
  list: protectedProcedure.query(async () => {
    return await getAllStrategyTemplates();
  }),

  /**
   * Get strategy template by ID
   */
  getById: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      return await getStrategyTemplateById(input.id);
    }),

  /**
   * Get strategy templates by category
   */
  getByCategory: protectedProcedure
    .input(z.object({ category: z.string() }))
    .query(async ({ input }) => {
      return await getStrategyTemplatesByCategory(input.category);
    }),

  /**
   * Clone a template to create a new user strategy
   */
  clone: protectedProcedure
    .input(z.object({ templateId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const template = await getStrategyTemplateById(input.templateId);
      if (!template) {
        throw new Error("Template not found");
      }

      const db = await getDb();
      if (!db) {
        throw new Error("Database not available");
      }

      // Create new strategy from template
      const [newStrategy] = await db.insert(tradingStrategies).values({
        userId: ctx.user.id,
        name: `${template.name} (Copy)`,
        description: template.description,
        conditions: template.conditions,
        tradingMode: template.tradingMode,
        priority: template.priority,
        isActive: false, // User needs to activate manually
        performanceMetrics: {
          totalTrades: 0,
          successfulTrades: 0,
          failedTrades: 0,
          totalEnergyTraded: 0,
          totalProfit: 0,
          averagePrice: 0,
        },
      });

      // Increment clone counter
      await incrementTemplateCloneCount(input.templateId);

      return { success: true, strategyId: newStrategy.insertId };
    }),
});
