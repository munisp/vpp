import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, boolean } from "drizzle-orm/mysql-core";

/**
 * Achievement Definitions
 */
export const achievements = mysqlTable("achievements", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  icon: varchar("icon", { length: 50 }), // Icon name from lucide-react
  category: mysqlEnum("category", ["participation", "performance", "milestone", "special"]).notNull(),
  
  // Criteria
  criteriaType: mysqlEnum("criteria_type", [
    "events_participated",
    "total_reduction",
    "reliability_score",
    "consecutive_events",
    "compensation_earned",
  ]).notNull(),
  criteriaValue: int("criteria_value").notNull(), // Threshold to unlock
  
  // Rewards
  rewardPoints: int("reward_points").default(0).notNull(),
  rewardBadge: varchar("reward_badge", { length: 50 }), // Badge tier: bronze, silver, gold, platinum
  
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type Achievement = typeof achievements.$inferSelect;
export type InsertAchievement = typeof achievements.$inferInsert;

/**
 * User Achievements
 */
export const userAchievements = mysqlTable("user_achievements", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull(),
  achievementId: int("achievement_id").notNull(),
  
  unlockedAt: timestamp("unlocked_at").defaultNow().notNull(),
  notified: boolean("notified").default(false).notNull(),
  
  metadata: text("metadata"), // JSON for additional data
});

export type UserAchievement = typeof userAchievements.$inferSelect;
export type InsertUserAchievement = typeof userAchievements.$inferInsert;

/**
 * Leaderboard Entries
 */
export const leaderboardEntries = mysqlTable("leaderboard_entries", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull(),
  
  // Period
  period: mysqlEnum("period", ["daily", "weekly", "monthly", "all_time"]).notNull(),
  periodStart: timestamp("period_start").notNull(),
  periodEnd: timestamp("period_end").notNull(),
  
  // Metrics
  rank: int("rank").notNull(),
  score: int("score").notNull(), // Overall performance score
  eventsParticipated: int("events_participated").default(0).notNull(),
  totalReduction: int("total_reduction").default(0).notNull(), // kW
  compensationEarned: int("compensation_earned").default(0).notNull(), // cents
  reliabilityScore: int("reliability_score").default(0).notNull(),
  
  // Rewards
  rewardAmount: int("reward_amount"), // cents
  rewardPaid: boolean("reward_paid").default(false).notNull(),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type LeaderboardEntry = typeof leaderboardEntries.$inferSelect;
export type InsertLeaderboardEntry = typeof leaderboardEntries.$inferInsert;
