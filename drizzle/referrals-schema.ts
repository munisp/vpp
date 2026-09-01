import {
  index,
  integer as int,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const referralRewardsStatusEnum = pgEnum("referral_rewards_status", ["pending", "processed", "failed"]);
export const referralRewardsCurrencyEnum = pgEnum("referral_rewards_currency", ["NGN", "TZS", "USD", "CREDITS"]);
export const referralRewardsRewardTypeEnum = pgEnum("referral_rewards_reward_type", ["credits", "cash", "discount", "tokens"]);
export const referralsRewardCurrencyEnum = pgEnum("referrals_reward_currency", ["NGN", "TZS", "USD", "CREDITS"]);
export const referralsRewardTypeEnum = pgEnum("referrals_reward_type", ["credits", "cash", "discount", "tokens"]);
export const referralsStatusEnum = pgEnum("referrals_status", ["pending", "completed", "rewarded", "expired"]);


/**
 * Referrals table - tracks user referrals and rewards
 */
export const referrals = pgTable("referrals", {
  id: serial("id").primaryKey(),
  
  // Referrer information
  referrerId: int("referrer_id").notNull(), // User who made the referral
  referralCode: varchar("referral_code", { length: 20 }).notNull().unique(), // Unique referral code
  
  // Referee information
  refereeId: int("referee_id"), // User who was referred (null until they sign up)
  refereeEmail: varchar("referee_email", { length: 320 }), // Email of referred user
  refereePhone: varchar("referee_phone", { length: 20 }), // Phone of referred user
  
  // Status tracking
  status: referralsStatusEnum("status").default("pending").notNull(),
  
  // Reward information
  rewardType: referralsRewardTypeEnum("reward_type").default("credits").notNull(),
  rewardAmount: int("reward_amount").default(0).notNull(), // Amount in cents or credits
  rewardCurrency: referralsRewardCurrencyEnum("reward_currency").default("CREDITS").notNull(),
  
  // Completion tracking
  completedAt: timestamp("completed_at"), // When referee completed required action
  rewardedAt: timestamp("rewarded_at"), // When reward was given to referrer
  expiresAt: timestamp("expires_at"), // When referral link expires
  
  // Metadata
  source: varchar("source", { length: 100 }), // Where referral was shared (email, sms, social)
  metadata: text("metadata"), // JSON string for additional data
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
}, (table) => [
  // "My referrals" lists and pending-referral counts per referrer
  // (db-referrals.ts)
  index("referrals_referrer_idx").on(table.referrerId),
]);

export type Referral = typeof referrals.$inferSelect;
export type InsertReferral = typeof referrals.$inferInsert;

/**
 * Referral rewards table - tracks all rewards earned through referrals
 */
export const referralRewards = pgTable("referral_rewards", {
  id: serial("id").primaryKey(),
  
  referralId: int("referral_id").notNull(), // Reference to referrals table
  userId: int("user_id").notNull(), // User who received the reward
  
  // Reward details
  rewardType: referralRewardsRewardTypeEnum("reward_type").notNull(),
  amount: int("amount").notNull(), // Amount in cents or credits
  currency: referralRewardsCurrencyEnum("currency").notNull(),
  
  // Status
  status: referralRewardsStatusEnum("status").default("pending").notNull(),
  processedAt: timestamp("processed_at"),
  
  // Metadata
  description: text("description"),
  metadata: text("metadata"), // JSON string for additional data
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
}, (table) => [
  // Reward history per user (db-referrals.ts)
  index("referral_rewards_user_idx").on(table.userId),
]);

export type ReferralReward = typeof referralRewards.$inferSelect;
export type InsertReferralReward = typeof referralRewards.$inferInsert;
