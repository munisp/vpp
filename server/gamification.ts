import { getDb } from './db';
import {
  achievements,
  userAchievements,
  leaderboardEntries,
  participantScores,
  drResponses,
  InsertUserAchievement,
  InsertLeaderboardEntry,
} from '../drizzle/schema';
import { eq, and, desc, gte, lte, sql } from 'drizzle-orm';
import { startOfDay, endOfDay, startOfWeek, endOfWeek, startOfMonth, endOfMonth } from 'date-fns';

/**
 * Gamification Engine
 * Manages achievements, leaderboards, and rewards
 */
export class GamificationEngine {
  /**
   * Check and unlock achievements for a user
   */
  static async checkAchievements(userId: number): Promise<number> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Get user's current achievements
    const userAchievementsList = await db
      .select()
      .from(userAchievements)
      .where(eq(userAchievements.userId, userId));

    const unlockedIds = userAchievementsList.map(ua => ua.achievementId);

    // Get all active achievements
    const allAchievements = await db
      .select()
      .from(achievements)
      .where(eq(achievements.isActive, true));

    // Get user stats
    const score = await db
      .select()
      .from(participantScores)
      .where(eq(participantScores.userId, userId))
      .limit(1);

    if (!score.length) return 0;

    const userScore = score[0];
    let newlyUnlocked = 0;

    for (const achievement of allAchievements) {
      // Skip if already unlocked
      if (unlockedIds.includes(achievement.id)) continue;

      let unlocked = false;

      // Check criteria
      switch (achievement.criteriaType) {
        case 'events_participated':
          unlocked = userScore.totalEventsParticipated >= achievement.criteriaValue;
          break;
        case 'total_reduction':
          unlocked = (userScore.averageReduction || 0) * userScore.totalEventsParticipated >= achievement.criteriaValue;
          break;
        case 'reliability_score':
          unlocked = userScore.reliabilityScore >= achievement.criteriaValue;
          break;
        case 'compensation_earned':
          unlocked = userScore.totalCompensationEarned >= achievement.criteriaValue;
          break;
        case 'consecutive_events':
          // Would need additional tracking - skip for now
          break;
      }

      if (unlocked) {
        await db.insert(userAchievements).values({
          userId,
          achievementId: achievement.id,
          notified: false,
        });
        newlyUnlocked++;
      }
    }

    return newlyUnlocked;
  }

  /**
   * Get user's achievements
   */
  static async getUserAchievements(userId: number) {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const result = await db
      .select({
        achievement: achievements,
        unlockedAt: userAchievements.unlockedAt,
      })
      .from(userAchievements)
      .innerJoin(achievements, eq(userAchievements.achievementId, achievements.id))
      .where(eq(userAchievements.userId, userId))
      .orderBy(desc(userAchievements.unlockedAt));

    return result;
  }

  /**
   * Update leaderboard for a period
   */
  static async updateLeaderboard(period: 'daily' | 'weekly' | 'monthly' | 'all_time'): Promise<number> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const now = new Date();
    let periodStart: Date;
    let periodEnd: Date;

    switch (period) {
      case 'daily':
        periodStart = startOfDay(now);
        periodEnd = endOfDay(now);
        break;
      case 'weekly':
        periodStart = startOfWeek(now);
        periodEnd = endOfWeek(now);
        break;
      case 'monthly':
        periodStart = startOfMonth(now);
        periodEnd = endOfMonth(now);
        break;
      case 'all_time':
        periodStart = new Date(0);
        periodEnd = now;
        break;
    }

    // Get all participant scores
    const scores = await db
      .select()
      .from(participantScores)
      .orderBy(desc(participantScores.overallScore));

    // Calculate period-specific metrics if not all_time
    let periodMetrics: Map<number, any> = new Map();
    
    if (period !== 'all_time') {
      const periodResponses = await db
        .select()
        .from(drResponses)
        .where(
          and(
            gte(drResponses.createdAt, periodStart),
            lte(drResponses.createdAt, periodEnd)
          )
        );

      for (const response of periodResponses) {
        const existing = periodMetrics.get(response.userId) || {
          eventsParticipated: 0,
          totalReduction: 0,
          compensationEarned: 0,
        };

        periodMetrics.set(response.userId, {
          eventsParticipated: existing.eventsParticipated + 1,
          totalReduction: existing.totalReduction + (response.actualReduction || 0),
          compensationEarned: existing.compensationEarned + (response.compensation || 0),
        });
      }
    }

    // Delete existing entries for this period
    await db
      .delete(leaderboardEntries)
      .where(
        and(
          eq(leaderboardEntries.period, period),
          gte(leaderboardEntries.periodStart, periodStart)
        )
      );

    // Create new entries
    let rank = 1;
    for (const score of scores) {
      const metrics = period === 'all_time' 
        ? {
            eventsParticipated: score.totalEventsParticipated,
            totalReduction: (score.averageReduction || 0) * score.totalEventsParticipated,
            compensationEarned: score.totalCompensationEarned,
          }
        : (periodMetrics.get(score.userId) || {
            eventsParticipated: 0,
            totalReduction: 0,
            compensationEarned: 0,
          });

      // Skip if no activity in period
      if (period !== 'all_time' && metrics.eventsParticipated === 0) continue;

      const entry: InsertLeaderboardEntry = {
        userId: score.userId,
        period,
        periodStart,
        periodEnd,
        rank,
        score: score.overallScore,
        eventsParticipated: metrics.eventsParticipated,
        totalReduction: metrics.totalReduction,
        compensationEarned: metrics.compensationEarned,
        reliabilityScore: score.reliabilityScore,
        rewardAmount: this.calculateReward(rank, period),
        rewardPaid: false,
      };

      await db.insert(leaderboardEntries).values(entry);
      rank++;
    }

    return rank - 1;
  }

  /**
   * Calculate reward based on rank and period
   */
  private static calculateReward(rank: number, period: string): number {
    const baseRewards: Record<string, number[]> = {
      daily: [5000, 3000, 2000], // Top 3 daily rewards in cents
      weekly: [20000, 12000, 8000],
      monthly: [100000, 60000, 40000],
      all_time: [0, 0, 0], // No monetary rewards for all-time
    };

    const rewards = baseRewards[period] || [0, 0, 0];
    if (rank <= 3) {
      return rewards[rank - 1];
    }
    return 0;
  }

  /**
   * Get leaderboard for a period
   */
  static async getLeaderboard(period: 'daily' | 'weekly' | 'monthly' | 'all_time', limit: number = 100) {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const now = new Date();
    let periodStart: Date;

    switch (period) {
      case 'daily':
        periodStart = startOfDay(now);
        break;
      case 'weekly':
        periodStart = startOfWeek(now);
        break;
      case 'monthly':
        periodStart = startOfMonth(now);
        break;
      case 'all_time':
        periodStart = new Date(0);
        break;
    }

    return await db
      .select()
      .from(leaderboardEntries)
      .where(
        and(
          eq(leaderboardEntries.period, period),
          gte(leaderboardEntries.periodStart, periodStart)
        )
      )
      .orderBy(leaderboardEntries.rank)
      .limit(limit);
  }

  /**
   * Get user's rank in a period
   */
  static async getUserRank(userId: number, period: 'daily' | 'weekly' | 'monthly' | 'all_time') {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const now = new Date();
    let periodStart: Date;

    switch (period) {
      case 'daily':
        periodStart = startOfDay(now);
        break;
      case 'weekly':
        periodStart = startOfWeek(now);
        break;
      case 'monthly':
        periodStart = startOfMonth(now);
        break;
      case 'all_time':
        periodStart = new Date(0);
        break;
    }

    const result = await db
      .select()
      .from(leaderboardEntries)
      .where(
        and(
          eq(leaderboardEntries.userId, userId),
          eq(leaderboardEntries.period, period),
          gte(leaderboardEntries.periodStart, periodStart)
        )
      )
      .limit(1);

    return result.length > 0 ? result[0] : null;
  }

  /**
   * Initialize default achievements
   */
  static async initializeDefaultAchievements(): Promise<void> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const defaultAchievements = [
      {
        name: 'First Steps',
        description: 'Participate in your first DR event',
        icon: 'Footprints',
        category: 'milestone' as const,
        criteriaType: 'events_participated' as const,
        criteriaValue: 1,
        rewardPoints: 10,
        rewardBadge: 'bronze',
      },
      {
        name: 'Consistent Contributor',
        description: 'Participate in 10 DR events',
        icon: 'TrendingUp',
        category: 'participation' as const,
        criteriaType: 'events_participated' as const,
        criteriaValue: 10,
        rewardPoints: 50,
        rewardBadge: 'silver',
      },
      {
        name: 'Power Saver',
        description: 'Participate in 50 DR events',
        icon: 'Zap',
        category: 'participation' as const,
        criteriaType: 'events_participated' as const,
        criteriaValue: 50,
        rewardPoints: 200,
        rewardBadge: 'gold',
      },
      {
        name: 'Grid Champion',
        description: 'Participate in 100 DR events',
        icon: 'Award',
        category: 'participation' as const,
        criteriaType: 'events_participated' as const,
        criteriaValue: 100,
        rewardPoints: 500,
        rewardBadge: 'platinum',
      },
      {
        name: 'Reliable Partner',
        description: 'Achieve 80% reliability score',
        icon: 'CheckCircle',
        category: 'performance' as const,
        criteriaType: 'reliability_score' as const,
        criteriaValue: 80,
        rewardPoints: 100,
        rewardBadge: 'gold',
      },
      {
        name: 'Top Earner',
        description: 'Earn 100,000 TZS in compensation',
        icon: 'DollarSign',
        category: 'milestone' as const,
        criteriaType: 'compensation_earned' as const,
        criteriaValue: 10000000, // 100,000 TZS in cents
        rewardPoints: 300,
        rewardBadge: 'platinum',
      },
    ];

    for (const achievement of defaultAchievements) {
      // Check if already exists
      const existing = await db
        .select()
        .from(achievements)
        .where(eq(achievements.name, achievement.name))
        .limit(1);

      if (existing.length === 0) {
        await db.insert(achievements).values(achievement);
      }
    }
  }
}
