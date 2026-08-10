import { int, mysqlTable, text, timestamp, boolean, varchar } from "drizzle-orm/mysql-core";

/**
 * Price Alerts - User-configured alerts for market price thresholds
 * Triggers notifications when market prices reach specified levels
 */
export const priceAlerts = mysqlTable("price_alerts", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  
  // Alert configuration
  name: text("name").notNull(),
  description: text("description"),
  alertType: varchar("alertType", { length: 20 }).notNull(),
  
  // Price thresholds (in TZS/kWh)
  targetPrice: int("targetPrice"), // For "above" or "below" alerts
  minPrice: int("minPrice"), // For "between" alerts
  maxPrice: int("maxPrice"), // For "between" alerts
  
  // Alert settings
  isActive: boolean("isActive").default(true).notNull(),
  notifyEmail: boolean("notifyEmail").default(true).notNull(),
  notifyPush: boolean("notifyPush").default(true).notNull(),
  notifySMS: boolean("notifySMS").default(false).notNull(),
  
  // Cooldown period to prevent spam (in minutes)
  cooldownMinutes: int("cooldownMinutes").default(60).notNull(),
  
  // Alert history
  lastTriggeredAt: timestamp("lastTriggeredAt"),
  triggerCount: int("triggerCount").default(0).notNull(),
  
  // Auto-disable after certain triggers
  maxTriggers: int("maxTriggers"), // null = unlimited
  
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type PriceAlert = typeof priceAlerts.$inferSelect;
export type InsertPriceAlert = typeof priceAlerts.$inferInsert;
