import { int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

/**
 * Referrals table - tracks user referrals and rewards
 */
export const referrals = mysqlTable("referrals", {
  id: int("id").autoincrement().primaryKey(),
  
  // Referrer information
  referrerId: int("referrer_id").notNull(), // User who made the referral
  referralCode: varchar("referral_code", { length: 20 }).notNull().unique(), // Unique referral code
  
  // Referee information
  refereeId: int("referee_id"), // User who was referred (null until they sign up)
  refereeEmail: varchar("referee_email", { length: 320 }), // Email of referred user
  refereePhone: varchar("referee_phone", { length: 20 }), // Phone of referred user
  
  // Status tracking
  status: mysqlEnum("status", ["pending", "completed", "rewarded", "expired"]).default("pending").notNull(),
  
  // Reward information
  rewardType: mysqlEnum("reward_type", ["credits", "cash", "discount", "tokens"]).default("credits").notNull(),
  rewardAmount: int("reward_amount").default(0).notNull(), // Amount in cents or credits
  rewardCurrency: mysqlEnum("reward_currency", ["NGN", "TZS", "USD", "CREDITS"]).default("CREDITS").notNull(),
  
  // Completion tracking
  completedAt: timestamp("completed_at"), // When referee completed required action
  rewardedAt: timestamp("rewarded_at"), // When reward was given to referrer
  expiresAt: timestamp("expires_at"), // When referral link expires
  
  // Metadata
  source: varchar("source", { length: 100 }), // Where referral was shared (email, sms, social)
  metadata: text("metadata"), // JSON string for additional data
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type Referral = typeof referrals.$inferSelect;
export type InsertReferral = typeof referrals.$inferInsert;

/**
 * Referral rewards table - tracks all rewards earned through referrals
 */
export const referralRewards = mysqlTable("referral_rewards", {
  id: int("id").autoincrement().primaryKey(),
  
  referralId: int("referral_id").notNull(), // Reference to referrals table
  userId: int("user_id").notNull(), // User who received the reward
  
  // Reward details
  rewardType: mysqlEnum("reward_type", ["credits", "cash", "discount", "tokens"]).notNull(),
  amount: int("amount").notNull(), // Amount in cents or credits
  currency: mysqlEnum("currency", ["NGN", "TZS", "USD", "CREDITS"]).notNull(),
  
  // Status
  status: mysqlEnum("status", ["pending", "processed", "failed"]).default("pending").notNull(),
  processedAt: timestamp("processed_at"),
  
  // Metadata
  description: text("description"),
  metadata: text("metadata"), // JSON string for additional data
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type ReferralReward = typeof referralRewards.$inferSelect;
export type InsertReferralReward = typeof referralRewards.$inferInsert;
