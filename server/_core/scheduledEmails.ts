import { sendEmail } from './emailService';
import { weeklyAnalyticsSummaryTemplate, monthlyAnalyticsSummaryTemplate } from './emailTemplates';
import { getDb } from '../db';
import { users, trades, payments, demandResponseEvents } from '../../drizzle/schema';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';

/**
 * Scheduled email service for sending periodic analytics summaries.
 * All KPIs are computed from REAL database aggregations. If any aggregation
 * query fails the email is ABORTED with a thrown error — canned numbers are
 * never sent to admins.
 */

interface PeriodStats {
  totalUsers: number;
  newUsers: number;
  activeUsers: number;
  totalTrades: number;
  totalEnergy: number; // watt-hours (matches trades.energy column)
  totalRevenueCents: number;
  totalDREvents: number;
  topTraders: Array<{ name: string; energy: number }>;
}

/**
 * Compute platform KPIs for a time window from the database.
 * Throws on any query failure — callers must not catch-and-send anyway.
 */
async function computePeriodStats(periodStart: Date, periodEnd: Date): Promise<PeriodStats> {
  const database = await getDb();
  if (!database) {
    throw new Error('[ScheduledEmails] Database not available — aborting analytics email');
  }

  const [userCountRow] = await database
    .select({ count: sql<number>`count(*)` })
    .from(users);

  const [newUsersRow] = await database
    .select({ count: sql<number>`count(*)` })
    .from(users)
    .where(and(gte(users.createdAt, periodStart), lt(users.createdAt, periodEnd)));

  const [tradeStatsRow] = await database
    .select({
      count: sql<number>`count(*)`,
      totalEnergy: sql<number>`coalesce(sum(${trades.energy}), 0)`,
    })
    .from(trades)
    .where(
      and(
        eq(trades.status, 'executed'),
        gte(trades.timestamp, periodStart),
        lt(trades.timestamp, periodEnd)
      )
    );

  const [revenueRow] = await database
    .select({ total: sql<number>`coalesce(sum(${payments.amount}), 0)` })
    .from(payments)
    .where(
      and(
        eq(payments.status, 'completed'),
        gte(payments.createdAt, periodStart),
        lt(payments.createdAt, periodEnd)
      )
    );

  const activeUserRows = await database
    .selectDistinct({ userId: trades.userId })
    .from(trades)
    .where(
      and(
        eq(trades.status, 'executed'),
        gte(trades.timestamp, periodStart),
        lt(trades.timestamp, periodEnd)
      )
    );

  const [drEventsRow] = await database
    .select({ count: sql<number>`count(*)` })
    .from(demandResponseEvents)
    .where(and(gte(demandResponseEvents.createdAt, periodStart), lt(demandResponseEvents.createdAt, periodEnd)));

  const topTraderRows = await database
    .select({
      userId: trades.userId,
      name: users.name,
      totalEnergy: sql<number>`coalesce(sum(${trades.energy}), 0)`,
    })
    .from(trades)
    .innerJoin(users, eq(users.id, trades.userId))
    .where(
      and(
        eq(trades.status, 'executed'),
        gte(trades.timestamp, periodStart),
        lt(trades.timestamp, periodEnd)
      )
    )
    .groupBy(trades.userId, users.name)
    .orderBy(desc(sql`coalesce(sum(${trades.energy}), 0)`))
    .limit(3);

  return {
    totalUsers: Number(userCountRow?.count ?? 0),
    newUsers: Number(newUsersRow?.count ?? 0),
    activeUsers: activeUserRows.length,
    totalTrades: Number(tradeStatsRow?.count ?? 0),
    totalEnergy: Number(tradeStatsRow?.totalEnergy ?? 0),
    totalRevenueCents: Number(revenueRow?.total ?? 0),
    totalDREvents: Number(drEventsRow?.count ?? 0),
    topTraders: topTraderRows.map((row) => ({
      name: row.name || `User #${row.userId}`,
      energy: Number(row.totalEnergy ?? 0),
    })),
  };
}

async function getAdminUsers() {
  const database = await getDb();
  if (!database) {
    throw new Error('[ScheduledEmails] Database not available — aborting analytics email');
  }
  return database.select().from(users).where(eq(users.role, 'admin'));
}

/**
 * Send weekly analytics summary to all admins
 * Should be scheduled to run every Monday morning
 */
export async function sendWeeklyAnalyticsSummary(): Promise<void> {
  console.log('[ScheduledEmails] Starting weekly analytics summary...');

  const admins = await getAdminUsers();
  if (admins.length === 0) {
    console.log('[ScheduledEmails] No admin users found');
    return;
  }

  // Calculate week range
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - 7);
  const weekStartStr = weekStart.toLocaleDateString();
  const weekEndStr = now.toLocaleDateString();

  // Real KPIs from the database — throws (aborts) on query failure
  const stats = await computePeriodStats(weekStart, now);
  const topTrader = stats.topTraders[0] ?? { name: 'No trades this week', energy: 0 };

  // Send email to each admin
  for (const admin of admins) {
    if (!admin.email) continue;

    const emailHtml = weeklyAnalyticsSummaryTemplate({
      adminName: admin.name || 'Admin',
      weekStart: weekStartStr,
      weekEnd: weekEndStr,
      totalUsers: stats.totalUsers,
      newUsers: stats.newUsers,
      totalTrades: stats.totalTrades,
      totalEnergy: stats.totalEnergy,
      totalRevenue: (stats.totalRevenueCents / 100).toFixed(2),
      topTrader: {
        name: topTrader.name,
        energy: topTrader.energy,
      },
    });

    await sendEmail({
      to: admin.email,
      subject: `📊 Weekly Analytics Summary - ${weekStartStr} to ${weekEndStr}`,
      html: emailHtml,
    });
  }

  console.log(`[ScheduledEmails] Weekly analytics summary sent to ${admins.length} admins`);
}

/**
 * Send monthly analytics summary to all admins
 * Should be scheduled to run on the 1st of each month
 */
export async function sendMonthlyAnalyticsSummary(): Promise<void> {
  console.log('[ScheduledEmails] Starting monthly analytics summary...');

  const admins = await getAdminUsers();
  if (admins.length === 0) {
    console.log('[ScheduledEmails] No admin users found');
    return;
  }

  // Calculate month range (previous calendar month)
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthName = monthStart.toLocaleString('default', { month: 'long' });
  const year = monthStart.getFullYear();

  // Real KPIs from the database — throws (aborts) on query failure
  const stats = await computePeriodStats(monthStart, monthEnd);

  // Send email to each admin
  for (const admin of admins) {
    if (!admin.email) continue;

    const emailHtml = monthlyAnalyticsSummaryTemplate({
      adminName: admin.name || 'Admin',
      month: monthName,
      year,
      totalUsers: stats.totalUsers,
      newUsers: stats.newUsers,
      activeUsers: stats.activeUsers,
      totalTrades: stats.totalTrades,
      totalEnergy: stats.totalEnergy,
      totalRevenue: (stats.totalRevenueCents / 100).toFixed(2),
      totalDREvents: stats.totalDREvents,
      topPerformers: stats.topTraders,
    });

    await sendEmail({
      to: admin.email,
      subject: `📈 Monthly Analytics Report - ${monthName} ${year}`,
      html: emailHtml,
    });
  }

  console.log(`[ScheduledEmails] Monthly analytics summary sent to ${admins.length} admins`);
}

/**
 * Manual trigger for testing scheduled emails
 * Uses the SAME real aggregations as the scheduled weekly summary.
 */
export async function sendTestWeeklySummary(adminEmail: string): Promise<boolean> {
  try {
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - 7);

    const stats = await computePeriodStats(weekStart, now);
    const topTrader = stats.topTraders[0] ?? { name: 'No trades this week', energy: 0 };

    const emailHtml = weeklyAnalyticsSummaryTemplate({
      adminName: 'Admin',
      weekStart: weekStart.toLocaleDateString(),
      weekEnd: now.toLocaleDateString(),
      totalUsers: stats.totalUsers,
      newUsers: stats.newUsers,
      totalTrades: stats.totalTrades,
      totalEnergy: stats.totalEnergy,
      totalRevenue: (stats.totalRevenueCents / 100).toFixed(2),
      topTrader: {
        name: topTrader.name,
        energy: topTrader.energy,
      },
    });

    const result = await sendEmail({
      to: adminEmail,
      subject: '📊 Test Weekly Analytics Summary',
      html: emailHtml,
    });

    return result.success;
  } catch (error) {
    console.error('[ScheduledEmails] Failed to send test weekly summary:', error);
    return false;
  }
}
