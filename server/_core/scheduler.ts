/**
 * Scheduled Report Generation Service
 * Automates monthly report generation and email delivery
 */

import cron from 'node-cron';
import { getDb } from '../db';
import { users } from '../../drizzle/schema';
import { generateRevenueReport, generateEnergyReport } from './export';
import { sendEmail } from './notifications';
import * as analyticsDb from '../analytics';

/**
 * Initialize scheduled report jobs
 */
export function initScheduledReports() {
  console.log('[Scheduler] Initializing scheduled report jobs');

  // Monthly revenue reports - Run on 1st of each month at 9 AM
  cron.schedule('0 9 1 * *', async () => {
    console.log('[Scheduler] Running monthly revenue report generation');
    await generateMonthlyRevenueReports();
  });

  // Monthly energy reports - Run on 1st of each month at 10 AM
  cron.schedule('0 10 1 * *', async () => {
    console.log('[Scheduler] Running monthly energy report generation');
    await generateMonthlyEnergyReports();
  });

  // Weekly summary reports - Run every Monday at 8 AM
  cron.schedule('0 8 * * 1', async () => {
    console.log('[Scheduler] Running weekly summary report generation');
    await generateWeeklySummaryReports();
  });

  console.log('[Scheduler] Scheduled report jobs initialized');
}

/**
 * Generate and send monthly revenue reports to all users
 */
async function generateMonthlyRevenueReports() {
  const db = await getDb();
  if (!db) {
    console.error('[Scheduler] Database not available');
    return;
  }

  try {
    // Get all active users
    const allUsers = await db.select().from(users);

    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endDate = new Date(now.getFullYear(), now.getMonth(), 0);

    for (const user of allUsers) {
      try {
        // Get revenue data for the user
        const revenueData = await analyticsDb.getRevenueData(user.id, startDate, endDate);

        if (revenueData.length === 0) {
          console.log(`[Scheduler] No revenue data for user ${user.id}, skipping`);
          continue;
        }

        const totalRevenue = revenueData.reduce((sum, item) => sum + item.revenue, 0);
        const totalPayments = revenueData.reduce((sum, item) => sum + item.transactions, 0);

        // Generate PDF report
        const pdfBuffer = await generateRevenueReport({
          startDate,
          endDate,
          totalRevenue,
          totalPayments,
          pendingPayments: 0,
          transactions: revenueData.map(item => ({
            date: new Date(item.date),
            amount: item.revenue,
            method: 'Trading',
            status: 'completed',
          })),
        });

        // Send email with PDF attachment
        if (user.email) {
          await sendEmail({
            to: user.email,
            subject: `Monthly Revenue Report - ${startDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`,
            html: getRevenueReportEmailTemplate(user.name || 'User', totalRevenue, startDate, endDate),
            attachments: [
              {
                filename: `revenue-report-${startDate.toISOString().slice(0, 7)}.pdf`,
                content: pdfBuffer,
                contentType: 'application/pdf',
              },
            ],
          });

          console.log(`[Scheduler] Sent revenue report to user ${user.id}`);
        }
      } catch (error) {
        console.error(`[Scheduler] Error generating revenue report for user ${user.id}:`, error);
      }
    }

    console.log('[Scheduler] Monthly revenue report generation completed');
  } catch (error) {
    console.error('[Scheduler] Error in monthly revenue report generation:', error);
  }
}

/**
 * Generate and send monthly energy reports to all users
 */
async function generateMonthlyEnergyReports() {
  const db = await getDb();
  if (!db) {
    console.error('[Scheduler] Database not available');
    return;
  }

  try {
    // Get all active users
    const allUsers = await db.select().from(users);

    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endDate = new Date(now.getFullYear(), now.getMonth(), 0);

    for (const user of allUsers) {
      try {
        // Get energy data for the user
        const energyData = await analyticsDb.getEnergyFlowData(user.id, startDate, endDate);

        if (energyData.length === 0) {
          console.log(`[Scheduler] No energy data for user ${user.id}, skipping`);
          continue;
        }

        const totalGeneration = energyData.reduce((sum, item) => sum + item.generation, 0);
        const totalConsumption = energyData.reduce((sum, item) => sum + item.consumption, 0);
        const totalTraded = energyData.reduce((sum, item) => sum + (item.gridExport - item.gridImport), 0);

        // Generate PDF report
        const pdfBuffer = await generateEnergyReport({
          startDate,
          endDate,
          totalGeneration,
          totalConsumption,
          totalTraded,
          dailyData: energyData.map(item => ({
            date: new Date(item.timestamp),
            generation: item.generation,
            consumption: item.consumption,
            traded: item.gridExport - item.gridImport,
          })),
        });

        // Send email with PDF attachment
        if (user.email) {
          await sendEmail({
            to: user.email,
            subject: `Monthly Energy Report - ${startDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`,
            html: getEnergyReportEmailTemplate(
              user.name || 'User',
              totalGeneration / 1000,
              totalConsumption / 1000,
              startDate,
              endDate
            ),
            attachments: [
              {
                filename: `energy-report-${startDate.toISOString().slice(0, 7)}.pdf`,
                content: pdfBuffer,
                contentType: 'application/pdf',
              },
            ],
          });

          console.log(`[Scheduler] Sent energy report to user ${user.id}`);
        }
      } catch (error) {
        console.error(`[Scheduler] Error generating energy report for user ${user.id}:`, error);
      }
    }

    console.log('[Scheduler] Monthly energy report generation completed');
  } catch (error) {
    console.error('[Scheduler] Error in monthly energy report generation:', error);
  }
}

/**
 * Generate and send weekly summary reports
 */
async function generateWeeklySummaryReports() {
  const db = await getDb();
  if (!db) {
    console.error('[Scheduler] Database not available');
    return;
  }

  try {
    // Get all active users
    const allUsers = await db.select().from(users);

    const now = new Date();
    const startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const endDate = now;

    for (const user of allUsers) {
      try {
        // Get summary data
        const revenueData = await analyticsDb.getRevenueData(user.id, startDate, endDate);
        const energyData = await analyticsDb.getEnergyFlowData(user.id, startDate, endDate);

        if (revenueData.length === 0 && energyData.length === 0) {
          continue;
        }

        const totalRevenue = revenueData.reduce((sum, item) => sum + item.revenue, 0);
        const totalGeneration = energyData.reduce((sum, item) => sum + item.generation, 0);
        const totalConsumption = energyData.reduce((sum, item) => sum + item.consumption, 0);

        // Send summary email
        if (user.email) {
          await sendEmail({
            to: user.email,
            subject: 'Weekly Energy Summary',
            html: getWeeklySummaryEmailTemplate(
              user.name || 'User',
              totalRevenue,
              totalGeneration / 1000,
              totalConsumption / 1000,
              startDate,
              endDate
            ),
          });

          console.log(`[Scheduler] Sent weekly summary to user ${user.id}`);
        }
      } catch (error) {
        console.error(`[Scheduler] Error generating weekly summary for user ${user.id}:`, error);
      }
    }

    console.log('[Scheduler] Weekly summary generation completed');
  } catch (error) {
    console.error('[Scheduler] Error in weekly summary generation:', error);
  }
}

/**
 * Email template for revenue reports
 */
function getRevenueReportEmailTemplate(
  userName: string,
  totalRevenue: number,
  startDate: Date,
  endDate: Date
): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background-color: #16a34a; color: white; padding: 20px; text-align: center; }
    .content { padding: 20px; background-color: #f9f9f9; }
    .stats { background-color: white; padding: 15px; margin: 15px 0; border-radius: 5px; }
    .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Monthly Revenue Report</h1>
      <p>${startDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</p>
    </div>
    <div class="content">
      <p>Dear ${userName},</p>
      <p>Your monthly revenue report for ${startDate.toLocaleDateString('en-US', { month: 'long' })} is ready.</p>
      
      <div class="stats">
        <h3>Summary</h3>
        <p><strong>Total Revenue:</strong> TZS ${(totalRevenue / 100).toLocaleString()}</p>
        <p><strong>Period:</strong> ${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}</p>
      </div>

      <p>Please find the detailed report attached to this email.</p>
      
      <p>Thank you for being part of the VPP community!</p>
    </div>
    <div class="footer">
      <p>© ${new Date().getFullYear()} VPP Consumer Platform. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
  `;
}

/**
 * Email template for energy reports
 */
function getEnergyReportEmailTemplate(
  userName: string,
  totalGeneration: number,
  totalConsumption: number,
  startDate: Date,
  endDate: Date
): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background-color: #16a34a; color: white; padding: 20px; text-align: center; }
    .content { padding: 20px; background-color: #f9f9f9; }
    .stats { background-color: white; padding: 15px; margin: 15px 0; border-radius: 5px; }
    .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Monthly Energy Report</h1>
      <p>${startDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</p>
    </div>
    <div class="content">
      <p>Dear ${userName},</p>
      <p>Your monthly energy report for ${startDate.toLocaleDateString('en-US', { month: 'long' })} is ready.</p>
      
      <div class="stats">
        <h3>Summary</h3>
        <p><strong>Total Generation:</strong> ${totalGeneration.toFixed(2)} kWh</p>
        <p><strong>Total Consumption:</strong> ${totalConsumption.toFixed(2)} kWh</p>
        <p><strong>Net Balance:</strong> ${(totalGeneration - totalConsumption).toFixed(2)} kWh</p>
        <p><strong>Period:</strong> ${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}</p>
      </div>

      <p>Please find the detailed report attached to this email.</p>
      
      <p>Thank you for contributing to a sustainable energy future!</p>
    </div>
    <div class="footer">
      <p>© ${new Date().getFullYear()} VPP Consumer Platform. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
  `;
}

/**
 * Email template for weekly summaries
 */
function getWeeklySummaryEmailTemplate(
  userName: string,
  totalRevenue: number,
  totalGeneration: number,
  totalConsumption: number,
  startDate: Date,
  endDate: Date
): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background-color: #16a34a; color: white; padding: 20px; text-align: center; }
    .content { padding: 20px; background-color: #f9f9f9; }
    .stats { background-color: white; padding: 15px; margin: 15px 0; border-radius: 5px; }
    .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Weekly Energy Summary</h1>
      <p>${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}</p>
    </div>
    <div class="content">
      <p>Dear ${userName},</p>
      <p>Here's your weekly energy summary:</p>
      
      <div class="stats">
        <h3>This Week</h3>
        <p><strong>Revenue:</strong> TZS ${(totalRevenue / 100).toLocaleString()}</p>
        <p><strong>Generation:</strong> ${totalGeneration.toFixed(2)} kWh</p>
        <p><strong>Consumption:</strong> ${totalConsumption.toFixed(2)} kWh</p>
        <p><strong>Net Balance:</strong> ${(totalGeneration - totalConsumption).toFixed(2)} kWh</p>
      </div>

      <p>Keep up the great work!</p>
    </div>
    <div class="footer">
      <p>© ${new Date().getFullYear()} VPP Consumer Platform. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
  `;
}
