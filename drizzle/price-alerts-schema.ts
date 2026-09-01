import {
  index,
  boolean,
  integer as int,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Price Alerts - User-configured alerts for market price thresholds
 * Triggers notifications when market prices reach specified levels
 */
export const priceAlerts = pgTable("price_alerts", {
  id: serial("id").primaryKey(),
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
  updatedAt: timestamp("updatedAt").defaultNow().$onUpdate(() => new Date()).notNull(),
}, (table) => [
  // Per-user alert lists (db-price-alerts.ts getPriceAlertsByUserId)
  index("price_alerts_user_idx").on(table.userId),
]);

export type PriceAlert = typeof priceAlerts.$inferSelect;
export type InsertPriceAlert = typeof priceAlerts.$inferInsert;
