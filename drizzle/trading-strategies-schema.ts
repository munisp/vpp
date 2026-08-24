import {
  boolean,
  integer as int,
  json,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const tradingStrategies = pgTable("trading_strategies", {
  id: serial("id").primaryKey(),
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
    /** How many recorded trades the run looked at, matched or not. */
    tradesConsidered?: number;
    simulatedTrades?: number;
    projectedProfit?: number;
    projectedEnergyTraded?: number;
    /** Null when nothing matched: a rate over no trades is not zero percent. */
    successRate?: number | null;
    /** Whether any recorded trade met the strategy's conditions. */
    measured?: boolean;
    testedAt?: string;
  }>(),
  
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().$onUpdate(() => new Date()).notNull(),
  lastActivatedAt: timestamp("lastActivatedAt"),
});

export type TradingStrategy = typeof tradingStrategies.$inferSelect;
export type InsertTradingStrategy = typeof tradingStrategies.$inferInsert;
