import { boolean, int, mysqlTable, mysqlEnum, timestamp, time } from "drizzle-orm/mysql-core";

/**
 * User Notification Preferences
 */
export const notificationPreferences = mysqlTable("notification_preferences", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull().unique(),
  
  // Email notifications
  emailPaymentReceived: boolean("email_payment_received").default(true).notNull(),
  emailTradeExecuted: boolean("email_trade_executed").default(true).notNull(),
  emailTradeFailed: boolean("email_trade_failed").default(true).notNull(),
  emailSystemAlert: boolean("email_system_alert").default(true).notNull(),
  emailAchievementUnlocked: boolean("email_achievement_unlocked").default(true).notNull(),
  emailDREventReminder: boolean("email_dr_event_reminder").default(true).notNull(),
  emailDREventCreated: boolean("email_dr_event_created").default(true).notNull(),
  emailLeaderboardRankChange: boolean("email_leaderboard_rank_change").default(true).notNull(),
  emailWeeklySummary: boolean("email_weekly_summary").default(false).notNull(),
  emailMonthlySummary: boolean("email_monthly_summary").default(false).notNull(),
  
  // Push notifications (for mobile and web app)
  pushPaymentReceived: boolean("push_payment_received").default(true).notNull(),
  pushAchievementUnlocked: boolean("push_achievement_unlocked").default(true).notNull(),
  pushDREventReminder: boolean("push_dr_event_reminder").default(true).notNull(),
  pushDREventCreated: boolean("push_dr_event_created").default(true).notNull(),
  pushLeaderboardRankChange: boolean("push_leaderboard_rank_change").default(false).notNull(),
  pushTradeExecuted: boolean("push_trade_executed").default(true).notNull(),
  pushTradeFailed: boolean("push_trade_failed").default(true).notNull(),
  pushSystemAlert: boolean("push_system_alert").default(true).notNull(),
  pushBillingAlert: boolean("push_billing_alert").default(true).notNull(),
  
  // Notification preferences
  notificationSound: boolean("notification_sound").default(true).notNull(),
  notificationFrequency: mysqlEnum("notification_frequency", ["instant", "hourly", "daily"]).default("instant").notNull(),
  
  // Quiet hours (format: HH:MM:SS)
  quietHoursEnabled: boolean("quiet_hours_enabled").default(false).notNull(),
  quietHoursStart: time("quiet_hours_start").default("22:00:00"),
  quietHoursEnd: time("quiet_hours_end").default("08:00:00"),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type NotificationPreference = typeof notificationPreferences.$inferSelect;
export type InsertNotificationPreference = typeof notificationPreferences.$inferInsert;
