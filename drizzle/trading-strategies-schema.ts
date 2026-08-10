import { int, mysqlTable, text, timestamp, boolean, json, varchar } from "drizzle-orm/mysql-core";

export const tradingStrategies = mysqlTable("trading_strategies", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  
  // Strategy status
  isActive: boolean("isActive").default(false).notNull(),
  
  // Trading conditions (stored as JSON)
  conditions: json("conditions").$type<{
    priceThresholds?: {
      minExportPrice?: number;
      maxExportPrice?: number;
      minImportPrice?: number;
      maxImportPrice?: number;
    };
    batteryLevels?: {
      minSOC?: number; // Minimum state of charge to sell
      maxSOC?: number; // Maximum state of charge to buy
    };
    timeWindows?: {
      startHour?: number; // 0-23
      endHour?: number; // 0-23
      daysOfWeek?: number[]; // 0-6 (Sunday-Saturday)
    };
    energyLimits?: {
      minTradeSize?: number; // Minimum kWh per trade
      maxTradeSize?: number; // Maximum kWh per trade
      dailyLimit?: number; // Maximum kWh per day
    };
  }>(),
  
  // Trading preferences
  tradingMode: varchar("tradingMode", { length: 20 }).default("both").notNull(),
  priority: int("priority").default(0).notNull(), // Higher priority strategies execute first
  
  // Performance metrics (updated after each trade)
  performanceMetrics: json("performanceMetrics").$type<{
    totalTrades?: number;
    successfulTrades?: number;
    failedTrades?: number;
    totalEnergyTraded?: number; // kWh
    totalProfit?: number; // TZS
    averagePrice?: number; // TZS/kWh
    lastExecutedAt?: string;
  }>(),
  
  // Backtesting results (stored after simulation)
  backtestResults: json("backtestResults").$type<{
    period?: string;
    simulatedTrades?: number;
    projectedProfit?: number;
    projectedEnergyTraded?: number;
    successRate?: number;
    testedAt?: string;
  }>(),
  
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastActivatedAt: timestamp("lastActivatedAt"),
});

export type TradingStrategy = typeof tradingStrategies.$inferSelect;
export type InsertTradingStrategy = typeof tradingStrategies.$inferInsert;
