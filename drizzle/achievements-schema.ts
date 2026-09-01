import {
  index,
  boolean,
  integer as int,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const leaderboardEntriesPeriodEnum = pgEnum("leaderboard_entries_period", ["daily", "weekly", "monthly", "all_time"]);
export const achievementsCriteriaTypeEnum = pgEnum("achievements_criteria_type", [
    "events_participated",
    "total_reduction",
    "reliability_score",
    "consecutive_events",
    "compensation_earned",
  ]);
export const achievementsCategoryEnum = pgEnum("achievements_category", ["participation", "performance", "milestone", "special"]);


/**
 * Achievement Definitions
 */
export const achievements = pgTable("achievements", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  icon: varchar("icon", { length: 50 }), // Icon name from lucide-react
  category: achievementsCategoryEnum("category").notNull(),
  
  // Criteria
  criteriaType: achievementsCriteriaTypeEnum("criteria_type").notNull(),
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
export const userAchievements = pgTable("user_achievements", {
  id: serial("id").primaryKey(),
  userId: int("user_id").notNull(),
  achievementId: int("achievement_id").notNull(),
  
  unlockedAt: timestamp("unlocked_at").defaultNow().notNull(),
  notified: boolean("notified").default(false).notNull(),

  metadata: text("metadata"), // JSON for additional data
}, (table) => [
  // Per-user achievement lists and unlock checks (gamification.ts)
  index("user_achievements_user_idx").on(table.userId),
]);

export type UserAchievement = typeof userAchievements.$inferSelect;
export type InsertUserAchievement = typeof userAchievements.$inferInsert;

/**
 * Leaderboard Entries
 */
export const leaderboardEntries = pgTable("leaderboard_entries", {
  id: serial("id").primaryKey(),
  userId: int("user_id").notNull(),
  
  // Period
  period: leaderboardEntriesPeriodEnum("period").notNull(),
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
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
}, (table) => [
  // Leaderboard reads filter (period, periodStart >=) ordered by rank
  // (gamification.ts)
  index("leaderboard_entries_period_idx").on(table.period, table.periodStart),
  // "My rank" lookups filter (userId, period)
  index("leaderboard_entries_user_idx").on(table.userId, table.period),
]);

export type LeaderboardEntry = typeof leaderboardEntries.$inferSelect;
export type InsertLeaderboardEntry = typeof leaderboardEntries.$inferInsert;
