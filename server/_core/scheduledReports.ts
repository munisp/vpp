/**
 * Scheduled Reports Service
 * Automatically generates and emails PDF reports to users
 */

import { getDb } from "../db";
import { users } from "../../drizzle/schema";
import { getUserQRHistory, getUserQRStats } from "../db-qr-history";
import { getUserReferrals, getUserReferralStats } from "../db-referrals";
// PDF export functions are client-side only, not needed for email reports
import { sendEmail } from "./emailService";

/**
 * Generate and send weekly QR history report to a user
 */
async function sendWeeklyQRReport(userId: number, userEmail: string, userName: string) {
  try {
    const history = await getUserQRHistory(userId, 100);
    const stats = await getUserQRStats(userId);

    // Filter to last 7 days
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weeklyHistory = history.filter(h => new Date(h.createdAt) >= weekAgo);

    if (weeklyHistory.length === 0) {
      console.log(`[Scheduled Reports] No QR activity for user ${userId} in the past week`);
      return;
    }

    // Generate PDF (in production, this would save to temp file)
    // For now, we'll send a summary email
    const subject = `Weekly QR Transaction Report - ${new Date().toLocaleDateString()}`;
    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #333;">Weekly QR Transaction Report</h2>
        <p>Hi ${userName},</p>
        <p>Here's your QR code activity summary for the past week:</p>
        
        <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3 style="margin-top: 0;">Summary</h3>
          <p><strong>Total Transactions:</strong> ${weeklyHistory.length}</p>
          <p><strong>Total Scans:</strong> ${weeklyHistory.filter(h => h.operationType === 'scan').length}</p>
          <p><strong>Total Generations:</strong> ${weeklyHistory.filter(h => h.operationType === 'generate').length}</p>
          <p><strong>Completed:</strong> ${weeklyHistory.filter(h => h.status === 'completed').length}</p>
          <p><strong>Pending:</strong> ${weeklyHistory.filter(h => h.status === 'pending').length}</p>
        </div>

        <h3>Recent Transactions</h3>
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="background: #f0f0f0;">
              <th style="padding: 10px; text-align: left; border: 1px solid #ddd;">Date</th>
              <th style="padding: 10px; text-align: left; border: 1px solid #ddd;">Type</th>
              <th style="padding: 10px; text-align: left; border: 1px solid #ddd;">Amount</th>
              <th style="padding: 10px; text-align: left; border: 1px solid #ddd;">Status</th>
            </tr>
          </thead>
          <tbody>
            ${weeklyHistory.slice(0, 10).map(item => `
              <tr>
                <td style="padding: 10px; border: 1px solid #ddd;">${new Date(item.createdAt).toLocaleDateString()}</td>
                <td style="padding: 10px; border: 1px solid #ddd;">${item.operationType}</td>
                <td style="padding: 10px; border: 1px solid #ddd;">${item.amount} ${item.currency}</td>
                <td style="padding: 10px; border: 1px solid #ddd;">${item.status}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>

        <p style="margin-top: 20px;">
          <a href="https://vpp-platform.com/qr-history" style="background: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">
            View Full History
          </a>
        </p>

        <p style="color: #666; font-size: 12px; margin-top: 30px;">
          This is an automated weekly report. To manage your notification preferences, visit your account settings.
        </p>
      </div>
    `;

    await sendEmail({
      to: userEmail,
      subject,
      html: htmlContent,
    });

    console.log(`[Scheduled Reports] Weekly QR report sent to user ${userId}`);
  } catch (error) {
    console.error(`[Scheduled Reports] Failed to send weekly QR report to user ${userId}:`, error);
  }
}

/**
 * Generate and send monthly referral report to a user
 */
async function sendMonthlyReferralReport(userId: number, userEmail: string, userName: string) {
  try {
    const referrals = await getUserReferrals(userId);
    const stats = await getUserReferralStats(userId);

    // Filter to last 30 days
    const monthAgo = new Date();
    monthAgo.setDate(monthAgo.getDate() - 30);
    const monthlyReferrals = referrals.filter(r => new Date(r.createdAt) >= monthAgo);

    if (monthlyReferrals.length === 0 && stats.totalReferrals === 0) {
      console.log(`[Scheduled Reports] No referral activity for user ${userId} in the past month`);
      return;
    }

    const subject = `Monthly Referral Report - ${new Date().toLocaleDateString()}`;
    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #333;">Monthly Referral Report</h2>
        <p>Hi ${userName},</p>
        <p>Here's your referral program summary for the past month:</p>
        
        <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3 style="margin-top: 0;">Summary</h3>
          <p><strong>New Referrals This Month:</strong> ${monthlyReferrals.length}</p>
          <p><strong>Total Referrals:</strong> ${stats.totalReferrals}</p>
          <p><strong>Completed Referrals:</strong> ${stats.completedReferrals}</p>
          <p><strong>Pending Referrals:</strong> ${stats.pendingReferrals}</p>
          <p><strong>Total Rewards Earned:</strong> ${stats.totalRewardsEarned} Credits</p>
          <p><strong>Pending Rewards:</strong> ${stats.pendingRewards} Credits</p>
        </div>

        ${monthlyReferrals.length > 0 ? `
          <h3>Recent Referrals</h3>
          <table style="width: 100%; border-collapse: collapse;">
            <thead>
              <tr style="background: #f0f0f0;">
                <th style="padding: 10px; text-align: left; border: 1px solid #ddd;">Date</th>
                <th style="padding: 10px; text-align: left; border: 1px solid #ddd;">Code</th>
                <th style="padding: 10px; text-align: left; border: 1px solid #ddd;">Status</th>
                <th style="padding: 10px; text-align: left; border: 1px solid #ddd;">Reward</th>
              </tr>
            </thead>
            <tbody>
              ${monthlyReferrals.slice(0, 10).map(ref => `
                <tr>
                  <td style="padding: 10px; border: 1px solid #ddd;">${new Date(ref.createdAt).toLocaleDateString()}</td>
                  <td style="padding: 10px; border: 1px solid #ddd;">${ref.referralCode}</td>
                  <td style="padding: 10px; border: 1px solid #ddd;">${ref.status}</td>
                  <td style="padding: 10px; border: 1px solid #ddd;">${ref.rewardAmount} ${ref.rewardCurrency}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : ''}

        <p style="margin-top: 20px;">
          <a href="https://vpp-platform.com/referrals" style="background: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">
            View Referral Dashboard
          </a>
        </p>

        <p style="color: #666; font-size: 12px; margin-top: 30px;">
          This is an automated monthly report. To manage your notification preferences, visit your account settings.
        </p>
      </div>
    `;

    await sendEmail({
      to: userEmail,
      subject,
      html: htmlContent,
    });

    console.log(`[Scheduled Reports] Monthly referral report sent to user ${userId}`);
  } catch (error) {
    console.error(`[Scheduled Reports] Failed to send monthly referral report to user ${userId}:`, error);
  }
}

/**
 * Send weekly reports to all active users
 */
export async function sendWeeklyReportsToAll() {
  const db = await getDb();
  if (!db) {
    console.warn("[Scheduled Reports] Database not available");
    return;
  }

  try {
    const allUsers = await db.select().from(users);
    console.log(`[Scheduled Reports] Sending weekly reports to ${allUsers.length} users`);

    for (const user of allUsers) {
      if (user.email) {
        await sendWeeklyQRReport(user.id, user.email, user.name || "User");
      }
    }

    console.log("[Scheduled Reports] Weekly reports sent successfully");
  } catch (error) {
    console.error("[Scheduled Reports] Error sending weekly reports:", error);
  }
}

/**
 * Send monthly reports to all active users
 */
export async function sendMonthlyReportsToAll() {
  const db = await getDb();
  if (!db) {
    console.warn("[Scheduled Reports] Database not available");
    return;
  }

  try {
    const allUsers = await db.select().from(users);
    console.log(`[Scheduled Reports] Sending monthly reports to ${allUsers.length} users`);

    for (const user of allUsers) {
      if (user.email) {
        await sendMonthlyReferralReport(user.id, user.email, user.name || "User");
      }
    }

    console.log("[Scheduled Reports] Monthly reports sent successfully");
  } catch (error) {
    console.error("[Scheduled Reports] Error sending monthly reports:", error);
  }
}

/**
 * Initialize scheduled report jobs
 * Weekly reports: Every Monday at 9 AM
 * Monthly reports: 1st of each month at 9 AM
 */
export function initScheduledReportJobs() {
  console.log("[Scheduled Reports] Initializing report jobs");

  // Weekly reports - every Monday at 9 AM
  // For demo purposes, run every hour
  setInterval(async () => {
    const now = new Date();
    // Check if it's Monday (1) and 9 AM
    if (now.getDay() === 1 && now.getHours() === 9) {
      await sendWeeklyReportsToAll();
    }
  }, 60 * 60 * 1000); // Check every hour

  // Monthly reports - 1st of month at 9 AM
  // For demo purposes, run every hour
  setInterval(async () => {
    const now = new Date();
    // Check if it's 1st of month and 9 AM
    if (now.getDate() === 1 && now.getHours() === 9) {
      await sendMonthlyReportsToAll();
    }
  }, 60 * 60 * 1000); // Check every hour

  console.log("[Scheduled Reports] Report jobs initialized");
}
