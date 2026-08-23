/**
 * Analytics Data Aggregation
 * 
 * Functions for aggregating and analyzing platform data
 */

import { getDb } from './db';
import { trades, payments, telemetry, users, assets } from '../drizzle/schema';
import { sql, and, gte, lte, eq, desc } from 'drizzle-orm';

export interface RevenueData {
  date: string;
  revenue: number;
  transactions: number;
}

export interface EnergyFlowData {
  timestamp: string;
  generation: number;
  consumption: number;
  batteryCharge: number;
  gridExport: number;
  gridImport: number;
}

export interface UserEngagementMetrics {
  totalUsers: number;
  activeUsers: number;
  newUsersThisMonth: number;
  averageAssetsPerUser: number;
  tradingParticipation: number;
}

export interface SystemStatistics {
  totalRevenue: number;
  totalEnergyTraded: number;
  totalAssets: number;
  activeTrades: number;
  averagePrice: number;
}

/**
 * Get revenue data for a date range
 */
export async function getRevenueData(
  userId: number | null,
  startDate: Date,
  endDate: Date
): Promise<RevenueData[]> {
  const db = await getDb();
  if (!db) return [];

  try {
    // Group payments by date and sum amounts
    const conditions = [
      gte(payments.createdAt, startDate),
      lte(payments.createdAt, endDate),
      eq(payments.status, 'completed'),
    ];

    if (userId) {
      conditions.push(eq(payments.userId, userId));
    }

    const result = await db
      .select({
        date: sql<string>`DATE(${payments.createdAt})::text`,
        revenue: sql<number>`SUM(${payments.amount})`,
        transactions: sql<number>`COUNT(*)`,
      })
      .from(payments)
      .where(and(...conditions))
      .groupBy(sql`DATE(${payments.createdAt})`)
      .orderBy(sql`DATE(${payments.createdAt})`);

    return result.map(row => ({
      date: row.date,
      revenue: Number(row.revenue) / 100, // Convert cents to dollars
      transactions: Number(row.transactions),
    }));
  } catch (error) {
    console.error('[Analytics] Failed to get revenue data:', error);
    return [];
  }
}

/**
 * Get energy flow data for a date range
 */
export async function getEnergyFlowData(
  userId: number | null,
  startDate: Date,
  endDate: Date,
  interval: 'hour' | 'day' = 'day'
): Promise<EnergyFlowData[]> {
  const db = await getDb();
  if (!db) return [];

  try {
    const conditions = [
      gte(telemetry.timestamp, startDate),
      lte(telemetry.timestamp, endDate),
    ];

    // Note: Telemetry is linked to assets, not directly to users
    // To filter by user, we would need to join with assets table
    // For now, we'll aggregate all telemetry data

    const timeFormat = interval === 'hour' 
      ? sql`to_char(${telemetry.timestamp}, 'YYYY-MM-DD HH24:00:00')`
      : sql`DATE(${telemetry.timestamp})`;

    const result = await db
      .select({
        timestamp: sql<string>`${timeFormat}`,
        generation: sql<number>`AVG(${telemetry.power})`,
        consumption: sql<number>`AVG(${telemetry.energy})`,
        batteryCharge: sql<number>`AVG(${telemetry.stateOfCharge})`,
        gridExport: sql<number>`SUM(CASE WHEN ${telemetry.power} > 0 THEN ${telemetry.power} ELSE 0 END)`,
        gridImport: sql<number>`SUM(CASE WHEN ${telemetry.power} < 0 THEN ABS(${telemetry.power}) ELSE 0 END)`,
      })
      .from(telemetry)
      .where(and(...conditions))
      .groupBy(timeFormat)
      .orderBy(timeFormat);

    return result.map(row => ({
      timestamp: row.timestamp,
      generation: Number(row.generation) || 0,
      consumption: Number(row.consumption) || 0,
      batteryCharge: Number(row.batteryCharge) || 0,
      gridExport: Number(row.gridExport) || 0,
      gridImport: Number(row.gridImport) || 0,
    }));
  } catch (error) {
    console.error('[Analytics] Failed to get energy flow data:', error);
    return [];
  }
}

/**
 * Get user engagement metrics
 */
export async function getUserEngagementMetrics(): Promise<UserEngagementMetrics> {
  const db = await getDb();
  if (!db) {
    return {
      totalUsers: 0,
      activeUsers: 0,
      newUsersThisMonth: 0,
      averageAssetsPerUser: 0,
      tradingParticipation: 0,
    };
  }

  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // Total users
    const totalUsersResult = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(users);
    const totalUsers = Number(totalUsersResult[0]?.count || 0);

    // Active users (signed in within last 30 days)
    const activeUsersResult = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(users)
      .where(gte(users.lastSignedIn, thirtyDaysAgo));
    const activeUsers = Number(activeUsersResult[0]?.count || 0);

    // New users this month
    const newUsersResult = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(users)
      .where(gte(users.createdAt, monthStart));
    const newUsersThisMonth = Number(newUsersResult[0]?.count || 0);

    // Average assets per user
    const assetsResult = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(assets);
    const totalAssets = Number(assetsResult[0]?.count || 0);
    const averageAssetsPerUser = totalUsers > 0 ? totalAssets / totalUsers : 0;

    // Trading participation (users who have made trades)
    const tradingUsersResult = await db
      .select({ count: sql<number>`COUNT(DISTINCT ${trades.userId})` })
      .from(trades);
    const tradingUsers = Number(tradingUsersResult[0]?.count || 0);
    const tradingParticipation = totalUsers > 0 ? (tradingUsers / totalUsers) * 100 : 0;

    return {
      totalUsers,
      activeUsers,
      newUsersThisMonth,
      averageAssetsPerUser: Math.round(averageAssetsPerUser * 100) / 100,
      tradingParticipation: Math.round(tradingParticipation * 100) / 100,
    };
  } catch (error) {
    console.error('[Analytics] Failed to get user engagement metrics:', error);
    return {
      totalUsers: 0,
      activeUsers: 0,
      newUsersThisMonth: 0,
      averageAssetsPerUser: 0,
      tradingParticipation: 0,
    };
  }
}

/**
 * Get system-wide statistics
 */
export async function getSystemStatistics(): Promise<SystemStatistics> {
  const db = await getDb();
  if (!db) {
    return {
      totalRevenue: 0,
      totalEnergyTraded: 0,
      totalAssets: 0,
      activeTrades: 0,
      averagePrice: 0,
    };
  }

  try {
    // Total revenue from completed payments
    const revenueResult = await db
      .select({ total: sql<number>`SUM(${payments.amount})` })
      .from(payments)
      .where(eq(payments.status, 'completed'));
    const totalRevenue = Number(revenueResult[0]?.total || 0) / 100;

    // Total energy traded
    const energyResult = await db
      .select({ total: sql<number>`SUM(${trades.energy})` })
      .from(trades)
      .where(eq(trades.status, 'executed'));
    const totalEnergyTraded = Number(energyResult[0]?.total || 0);

    // Total assets
    const assetsResult = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(assets)
      .where(eq(assets.status, 'active'));
    const totalAssets = Number(assetsResult[0]?.count || 0);

    // Active trades
    const activeTradesResult = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(trades)
      .where(eq(trades.status, 'pending'));
    const activeTrades = Number(activeTradesResult[0]?.count || 0);

    // Average trade price
    const avgPriceResult = await db
      .select({ avg: sql<number>`AVG(${trades.price})` })
      .from(trades)
      .where(eq(trades.status, 'executed'));
    const averagePrice = Number(avgPriceResult[0]?.avg || 0) / 100;

    return {
      totalRevenue,
      totalEnergyTraded,
      totalAssets,
      activeTrades,
      averagePrice,
    };
  } catch (error) {
    console.error('[Analytics] Failed to get system statistics:', error);
    return {
      totalRevenue: 0,
      totalEnergyTraded: 0,
      totalAssets: 0,
      activeTrades: 0,
      averagePrice: 0,
    };
  }
}

/**
 * Get trading volume data for charts
 */
export async function getTradingVolumeData(
  userId: number | null,
  startDate: Date,
  endDate: Date
): Promise<Array<{ date: string; volume: number; count: number }>> {
  const db = await getDb();
  if (!db) return [];

  try {
    const conditions = [
      gte(trades.createdAt, startDate),
      lte(trades.createdAt, endDate),
      eq(trades.status, 'executed'),
    ];

    if (userId) {
      conditions.push(eq(trades.userId, userId));
    }

    const result = await db
      .select({
        date: sql<string>`DATE(${trades.createdAt})::text`,
        volume: sql<number>`SUM(${trades.energy})`,
        count: sql<number>`COUNT(*)`,
      })
      .from(trades)
      .where(and(...conditions))
      .groupBy(sql`DATE(${trades.createdAt})`)
      .orderBy(sql`DATE(${trades.createdAt})`);

    return result.map(row => ({
      date: row.date,
      volume: Number(row.volume) || 0,
      count: Number(row.count) || 0,
    }));
  } catch (error) {
    console.error('[Analytics] Failed to get trading volume data:', error);
    return [];
  }
}
