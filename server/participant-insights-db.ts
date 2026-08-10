import { getDb } from './db';
import { 
  drParticipants, 
  drResponses, 
  demandResponseEvents,
  drCompensation,
  achievements,
  userAchievements,
  leaderboardEntries,
  payments,
  trades
} from '../drizzle/schema';
import { eq, and, gte, lte, desc, sql, sum, count, avg } from 'drizzle-orm';

/**
 * Get participant's DR performance trends
 */
export async function getParticipantPerformanceTrends(
  userId: number,
  startDate: Date,
  endDate: Date
) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  // Get monthly performance
  const monthlyPerformance = await db
    .select({
      month: sql<string>`DATE_FORMAT(${demandResponseEvents.startTime}, '%Y-%m')`,
      eventsParticipated: count(drResponses.id),
      totalReduction: sum(drResponses.actualReduction),
      avgAccuracy: avg(sql<number>`(${drResponses.actualReduction} / ${demandResponseEvents.targetReduction}) * 100`),
    })
    .from(drResponses)
    .innerJoin(demandResponseEvents, eq(drResponses.eventId, demandResponseEvents.id))
    .where(
      and(
        eq(drResponses.userId, userId),
        gte(demandResponseEvents.startTime, startDate),
        lte(demandResponseEvents.startTime, endDate)
      )
    )
    .groupBy(sql`DATE_FORMAT(${demandResponseEvents.startTime}, '%Y-%m')`)
    .orderBy(sql`DATE_FORMAT(${demandResponseEvents.startTime}, '%Y-%m')`);

  return monthlyPerformance.map(row => ({
    month: row.month,
    eventsParticipated: Number(row.eventsParticipated || 0),
    totalReduction: Number(row.totalReduction || 0),
    avgAccuracy: Number(row.avgAccuracy || 0),
  }));
}

/**
 * Get participant's earnings forecast
 */
export async function getEarningsForecast(userId: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  // Get historical earnings (last 3 months)
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

  const historicalEarnings = await db
    .select({
      month: sql<string>`DATE_FORMAT(${drCompensation.paidAt}, '%Y-%m')`,
      earnings: sum(drCompensation.amount),
    })
    .from(drCompensation)
    .where(
      and(
        eq(drCompensation.userId, userId),
        gte(drCompensation.paidAt, threeMonthsAgo)
      )
    )
    .groupBy(sql`DATE_FORMAT(${drCompensation.paidAt}, '%Y-%m')`)
    .orderBy(sql`DATE_FORMAT(${drCompensation.paidAt}, '%Y-%m')`);

  const monthlyAvg = historicalEarnings.length > 0
    ? historicalEarnings.reduce((sum, row) => sum + Number(row.earnings || 0), 0) / historicalEarnings.length
    : 0;

  // Forecast next 3 months based on average
  const forecast = [];
  const now = new Date();
  for (let i = 1; i <= 3; i++) {
    const forecastDate = new Date(now);
    forecastDate.setMonth(now.getMonth() + i);
    forecast.push({
      month: forecastDate.toISOString().slice(0, 7),
      forecastEarnings: monthlyAvg,
      confidence: 'medium' as const,
    });
  }

  return {
    historical: historicalEarnings.map(row => ({
      month: row.month,
      earnings: Number(row.earnings || 0),
    })),
    forecast,
    monthlyAverage: monthlyAvg,
  };
}

/**
 * Calculate participant's carbon impact
 */
export async function getCarbonImpact(userId: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  // Get total energy reduction
  const totalReduction = await db
    .select({
      total: sum(drResponses.actualReduction),
    })
    .from(drResponses)
    .where(eq(drResponses.userId, userId));

  const kWhReduced = Number(totalReduction[0]?.total || 0);
  
  // Carbon emission factor for Tanzania grid: ~0.5 kg CO2/kWh
  const carbonFactor = 0.5;
  const carbonSaved = kWhReduced * carbonFactor;

  // Equivalent metrics
  const treesEquivalent = carbonSaved / 21; // 1 tree absorbs ~21 kg CO2/year
  const milesNotDriven = carbonSaved / 0.404; // 1 mile driven = ~0.404 kg CO2

  return {
    totalEnergyReduced: kWhReduced,
    carbonSaved, // kg CO2
    treesEquivalent: Math.round(treesEquivalent),
    milesNotDriven: Math.round(milesNotDriven),
  };
}

/**
 * Get peer comparison (anonymized)
 */
export async function getPeerComparison(userId: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  // Get user's current month performance
  const currentMonth = new Date().toISOString().slice(0, 7);
  
  const userPerformance = await db
    .select({
      eventsParticipated: count(drResponses.id),
      totalReduction: sum(drResponses.actualReduction),
    })
    .from(drResponses)
    .innerJoin(demandResponseEvents, eq(drResponses.eventId, demandResponseEvents.id))
    .where(
      and(
        eq(drResponses.userId, userId),
        sql`DATE_FORMAT(${demandResponseEvents.startTime}, '%Y-%m') = ${currentMonth}`
      )
    );

  const userEvents = Number(userPerformance[0]?.eventsParticipated || 0);
  const userReduction = Number(userPerformance[0]?.totalReduction || 0);

  // Get platform averages
  const platformAvg = await db
    .select({
      avgEvents: avg(sql<number>`event_count`),
      avgReduction: avg(sql<number>`total_reduction`),
    })
    .from(
      sql`(
        SELECT 
          COUNT(${drResponses.id}) as event_count,
          SUM(${drResponses.actualReduction}) as total_reduction
        FROM ${drResponses}
        WHERE ${drResponses.userId} = ${userId}
        INNER JOIN ${demandResponseEvents} ON ${drResponses.eventId} = ${demandResponseEvents.id}
        AND DATE_FORMAT(${demandResponseEvents.startTime}, '%Y-%m') = ${currentMonth}
      ) as user_stats`
    );

  const avgEvents = Number(platformAvg[0]?.avgEvents || 0);
  const avgReduction = Number(platformAvg[0]?.avgReduction || 0);

  return {
    userEvents,
    userReduction,
    platformAvgEvents: avgEvents,
    platformAvgReduction: avgReduction,
    percentileEvents: userEvents > avgEvents ? 75 : userEvents > avgEvents * 0.5 ? 50 : 25,
    percentileReduction: userReduction > avgReduction ? 75 : userReduction > avgReduction * 0.5 ? 50 : 25,
  };
}

/**
 * Get participant's achievement timeline
 */
export async function getAchievementTimeline(userId: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const timeline = await db
    .select({
      id: userAchievements.id,
      achievementName: achievements.name,
      achievementDescription: achievements.description,
      category: achievements.category,
      icon: achievements.icon,
      unlockedAt: userAchievements.unlockedAt,
    })
    .from(userAchievements)
    .innerJoin(achievements, eq(userAchievements.achievementId, achievements.id))
    .where(eq(userAchievements.userId, userId))
    .orderBy(desc(userAchievements.unlockedAt));

  return timeline;
}

/**
 * Get participant's energy savings tracker
 */
export async function getEnergySavingsTracker(userId: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  // Get last 12 months of savings
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

  const monthlySavings = await db
    .select({
      month: sql<string>`DATE_FORMAT(${demandResponseEvents.startTime}, '%Y-%m')`,
      energySaved: sum(drResponses.actualReduction),
      compensation: sum(drCompensation.amount),
    })
    .from(drResponses)
    .innerJoin(demandResponseEvents, eq(drResponses.eventId, demandResponseEvents.id))
    .leftJoin(drCompensation, eq(drResponses.id, drCompensation.responseId))
    .where(
      and(
        eq(drResponses.userId, userId),
        gte(demandResponseEvents.startTime, twelveMonthsAgo)
      )
    )
    .groupBy(sql`DATE_FORMAT(${demandResponseEvents.startTime}, '%Y-%m')`)
    .orderBy(sql`DATE_FORMAT(${demandResponseEvents.startTime}, '%Y-%m')`);

  return monthlySavings.map(row => ({
    month: row.month,
    energySaved: Number(row.energySaved || 0),
    compensation: Number(row.compensation || 0),
  }));
}

/**
 * Get participant's overall stats
 */
export async function getParticipantOverallStats(userId: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  // Total events participated
  const eventStats = await db
    .select({
      totalEvents: count(drResponses.id),
      totalReduction: sum(drResponses.actualReduction),
    })
    .from(drResponses)
    .where(eq(drResponses.userId, userId));

  // Total earnings
  const earningsStats = await db
    .select({
      totalEarnings: sum(drCompensation.amount),
    })
    .from(drCompensation)
    .where(eq(drCompensation.userId, userId));

  // Current rank
  const rankStats = await db
    .select({
      rank: leaderboardEntries.rank,
      score: leaderboardEntries.score,
    })
    .from(leaderboardEntries)
    .where(
      and(
        eq(leaderboardEntries.userId, userId),
        eq(leaderboardEntries.period, 'all_time')
      )
    )
    .limit(1);

  // Achievement count
  const achievementCount = await db
    .select({
      count: count(userAchievements.id),
    })
    .from(userAchievements)
    .where(eq(userAchievements.userId, userId));

  return {
    totalEventsParticipated: Number(eventStats[0]?.totalEvents || 0),
    totalEnergyReduced: Number(eventStats[0]?.totalReduction || 0),
    totalEarnings: Number(earningsStats[0]?.totalEarnings || 0),
    currentRank: Number(rankStats[0]?.rank || 0),
    currentScore: Number(rankStats[0]?.score || 0),
    achievementsUnlocked: Number(achievementCount[0]?.count || 0),
  };
}
