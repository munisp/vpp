import { sendEmail, sendBatchEmails } from './emailService';
import { weeklyAnalyticsSummaryTemplate, monthlyAnalyticsSummaryTemplate } from './emailTemplates';
import { getDb } from '../db';
import { users } from '../../drizzle/schema';
import { eq } from 'drizzle-orm';

/**
 * Scheduled email service for sending periodic analytics summaries
 * These functions should be called by a cron job or scheduler
 */

/**
 * Send weekly analytics summary to all admins
 * Should be scheduled to run every Monday morning
 */
export async function sendWeeklyAnalyticsSummary(): Promise<void> {
  try {
    console.log('[ScheduledEmails] Starting weekly analytics summary...');

    // Get all admin users
    const database = await getDb();
    if (!database) {
      console.log('[ScheduledEmails] Database not available');
      return;
    }
    const admins = await database.select().from(users).where(eq(users.role, 'admin'));
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

    // Fetch analytics data for the week
    // TODO: Implement proper analytics aggregation queries
    const userStats = { total: 150 };
    const tradingStats = { totalTrades: 45, totalEnergy: 125000 };
    const revenueStats = { total: 4500000 };
    const newUsersThisWeek = 12;
    const topTrader = { name: 'Top Trader', totalEnergy: 15000 };

    // Send email to each admin
    for (const admin of admins) {
      if (!admin.email) continue;

      const emailHtml = weeklyAnalyticsSummaryTemplate({
        adminName: admin.name || 'Admin',
        weekStart: weekStartStr,
        weekEnd: weekEndStr,
        totalUsers: userStats.total,
        newUsers: newUsersThisWeek,
        totalTrades: tradingStats.totalTrades,
        totalEnergy: tradingStats.totalEnergy,
        totalRevenue: (revenueStats.total / 100).toFixed(2),
        topTrader: {
          name: topTrader.name,
          energy: topTrader.totalEnergy,
        },
      });

      await sendEmail({
        to: admin.email,
        subject: `📊 Weekly Analytics Summary - ${weekStartStr} to ${weekEndStr}`,
        html: emailHtml,
      });
    }

    console.log(`[ScheduledEmails] Weekly analytics summary sent to ${admins.length} admins`);
  } catch (error) {
    console.error('[ScheduledEmails] Failed to send weekly analytics summary:', error);
  }
}

/**
 * Send monthly analytics summary to all admins
 * Should be scheduled to run on the 1st of each month
 */
export async function sendMonthlyAnalyticsSummary(): Promise<void> {
  try {
    console.log('[ScheduledEmails] Starting monthly analytics summary...');

    // Get all admin users
    const database = await getDb();
    if (!database) {
      console.log('[ScheduledEmails] Database not available');
      return;
    }
    const admins = await database.select().from(users).where(eq(users.role, 'admin'));
    if (admins.length === 0) {
      console.log('[ScheduledEmails] No admin users found');
      return;
    }

    // Calculate month range
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const monthName = lastMonth.toLocaleString('default', { month: 'long' });
    const year = lastMonth.getFullYear();

    // Fetch analytics data for the month
    // TODO: Implement proper analytics aggregation queries
    const userStats = { total: 150 };
    const tradingStats = { totalTrades: 180, totalEnergy: 500000 };
    const revenueStats = { total: 18000000 };
    const drStats = { total: 8 };
    const newUsersThisMonth = 45;
    const activeUsers = 120;
    const topPerformers = [
      { name: 'Trader 1', totalEnergy: 50000 },
      { name: 'Trader 2', totalEnergy: 45000 },
      { name: 'Trader 3', totalEnergy: 40000 },
    ];

    // Send email to each admin
    for (const admin of admins) {
      if (!admin.email) continue;

      const emailHtml = monthlyAnalyticsSummaryTemplate({
        adminName: admin.name || 'Admin',
        month: monthName,
        year,
        totalUsers: userStats.total,
        newUsers: newUsersThisMonth,
        activeUsers,
        totalTrades: tradingStats.totalTrades,
        totalEnergy: tradingStats.totalEnergy,
        totalRevenue: (revenueStats.total / 100).toFixed(2),
        totalDREvents: drStats.total,
        topPerformers: topPerformers.map((t: any) => ({
          name: t.name,
          energy: t.totalEnergy,
        })),
      });

      await sendEmail({
        to: admin.email,
        subject: `📈 Monthly Analytics Report - ${monthName} ${year}`,
        html: emailHtml,
      });
    }

    console.log(`[ScheduledEmails] Monthly analytics summary sent to ${admins.length} admins`);
  } catch (error) {
    console.error('[ScheduledEmails] Failed to send monthly analytics summary:', error);
  }
}

/**
 * Manual trigger for testing scheduled emails
 * Can be called via tRPC procedure for admin testing
 */
export async function sendTestWeeklySummary(adminEmail: string): Promise<boolean> {
  try {
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - 7);

    const emailHtml = weeklyAnalyticsSummaryTemplate({
      adminName: 'Admin',
      weekStart: weekStart.toLocaleDateString(),
      weekEnd: now.toLocaleDateString(),
      totalUsers: 150,
      newUsers: 12,
      totalTrades: 45,
      totalEnergy: 125000,
      totalRevenue: '45000.00',
      topTrader: {
        name: 'John Doe',
        energy: 15000,
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
