import { int, mysqlTable, text, timestamp, json, varchar } from "drizzle-orm/mysql-core";

/**
 * Strategy Templates - Pre-built trading strategy configurations
 * Users can clone these templates to quickly set up proven trading strategies
 */
export const strategyTemplates = mysqlTable("strategy_templates", {
  id: int("id").autoincrement().primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  category: varchar("category", { length: 50 }).notNull(),
  
  // Template icon/image for UI
  icon: varchar("icon", { length: 50 }).default("Zap").notNull(), // Lucide icon name
  
  // Pre-configured trading conditions
  conditions: json("conditions").$type<{
    priceThresholds?: {
      minExportPrice?: number;
      maxExportPrice?: number;
      minImportPrice?: number;
      maxImportPrice?: number;
    };
    batteryLevels?: {
      minSOC?: number;
      maxSOC?: number;
    };
    timeWindows?: {
      startHour?: number;
      endHour?: number;
      daysOfWeek?: number[];
    };
    energyLimits?: {
      minTradeSize?: number;
      maxTradeSize?: number;
      dailyLimit?: number;
    };
  }>().notNull(),
  
  // Trading preferences
  tradingMode: varchar("tradingMode", { length: 20 }).default("both").notNull(),
  priority: int("priority").default(0).notNull(),
  
  // Expected performance (based on historical data)
  expectedPerformance: json("expectedPerformance").$type<{
    avgDailyTrades?: number;
    avgDailyProfit?: number; // TZS
    avgDailyEnergy?: number; // kWh
    successRate?: number; // percentage
    bestSeason?: string; // e.g., "Dry season", "All year"
  }>(),
  
  // Usage statistics
  timesCloned: int("timesCloned").default(0).notNull(),
  
  // Template metadata
  tags: json("tags").$type<string[]>(), // e.g., ["beginner-friendly", "high-profit", "conservative"]
  difficulty: varchar("difficulty", { length: 20 }).default("beginner").notNull(),
  
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type StrategyTemplate = typeof strategyTemplates.$inferSelect;
export type InsertStrategyTemplate = typeof strategyTemplates.$inferInsert;
