import { getDb } from './db';
import { payments, demandResponseEvents, drParticipants, drResponses, drForecasts, billings, trades } from '../drizzle/schema';
import { sql, eq, and, gte, lte, desc, count, sum, avg } from 'drizzle-orm';

/**
 * Admin Analytics Database Functions
 * Provides comprehensive analytics data for admin dashboard
 */

export interface PaymentMetrics {
  totalRevenue: number;
  totalTransactions: number;
  successRate: number;
  averageTransactionValue: number;
  gatewayBreakdown: {
    gateway: string;
    count: number;
    revenue: number;
  }[];
  dailyRevenue: {
    date: string;
    revenue: number;
    transactions: number;
  }[];
}

export interface DREventMetrics {
  totalEvents: number;
  totalParticipants: number;
  totalReduction: number;
  totalCompensation: number;
  averageParticipationRate: number;
  eventTypeBreakdown: {
    eventType: string;
    count: number;
    avgReduction: number;
  }[];
  performanceOverTime: {
    date: string;
    events: number;
    participants: number;
    reduction: number;
  }[];
}

export interface ForecastingMetrics {
  totalForecasts: number;
  averageAccuracy: number;
  forecastsByStatus: {
    status: string;
    count: number;
  }[];
  accuracyOverTime: {
    date: string;
    accuracy: number;
    forecasts: number;
  }[];
}

export interface SystemKPIs {
  totalUsers: number;
  activeUsers: number;
  totalAssets: number;
  activeAssets: number;
  totalEnergyTraded: number;
  platformRevenue: number;
  drParticipationRate: number;
  // No satisfaction/feedback data source exists in the schema, so this is
  // null and satisfactionAvailable is false — never a hardcoded value.
  averageUserSatisfaction: number | null;
  satisfactionAvailable: boolean;
}

/**
 * Get payment metrics for admin dashboard
 */
export async function getPaymentMetrics(
  startDate: Date,
  endDate: Date
): Promise<PaymentMetrics> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  // Total revenue and transactions
  const totals = await db
    .select({
      totalRevenue: sum(payments.amount),
      totalTransactions: count(payments.id),
      successfulTransactions: sql<number>`SUM(CASE WHEN ${payments.status} = 'completed' THEN 1 ELSE 0 END)`,
    })
    .from(payments)
    .where(
      and(
        gte(payments.createdAt, startDate),
        lte(payments.createdAt, endDate)
      )
    );

  const totalRevenue = Number(totals[0]?.totalRevenue || 0);
  const totalTransactions = Number(totals[0]?.totalTransactions || 0);
  const successfulTransactions = Number(totals[0]?.successfulTransactions || 0);
  const successRate = totalTransactions > 0 ? (successfulTransactions / totalTransactions) * 100 : 0;
  const averageTransactionValue = totalTransactions > 0 ? totalRevenue / totalTransactions : 0;

  // Gateway breakdown
  const gatewayStats = await db
    .select({
      gateway: payments.paymentMethod,
      count: count(payments.id),
      revenue: sum(payments.amount),
    })
    .from(payments)
    .where(
      and(
        gte(payments.createdAt, startDate),
        lte(payments.createdAt, endDate),
        eq(payments.status, 'completed')
      )
    )
    .groupBy(payments.paymentMethod);

  const gatewayBreakdown = gatewayStats.map((stat) => ({
    gateway: stat.gateway,
    count: Number(stat.count),
    revenue: Number(stat.revenue || 0),
  }));

  // Daily revenue
  const dailyStats = await db
    .select({
      date: sql<string>`DATE(${payments.createdAt})`,
      revenue: sum(payments.amount),
      transactions: count(payments.id),
    })
    .from(payments)
    .where(
      and(
        gte(payments.createdAt, startDate),
        lte(payments.createdAt, endDate),
        eq(payments.status, 'completed')
      )
    )
    .groupBy(sql`DATE(${payments.createdAt})`)
    .orderBy(sql`DATE(${payments.createdAt})`);

  const dailyRevenue = dailyStats.map((stat) => ({
    date: stat.date,
    revenue: Number(stat.revenue || 0),
    transactions: Number(stat.transactions),
  }));

  return {
    totalRevenue,
    totalTransactions,
    successRate,
    averageTransactionValue,
    gatewayBreakdown,
    dailyRevenue,
  };
}

/**
 * Get DR event metrics for admin dashboard
 */
export async function getDREventMetrics(
  startDate: Date,
  endDate: Date
): Promise<DREventMetrics> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  // Total events and participants
  const eventTotals = await db
    .select({
      totalEvents: count(demandResponseEvents.id),
      totalReduction: sum(demandResponseEvents.targetReduction),
    })
    .from(demandResponseEvents)
    .where(
      and(
        gte(demandResponseEvents.startTime, startDate),
        lte(demandResponseEvents.startTime, endDate)
      )
    );

  const participantTotals = await db
    .select({
      totalParticipants: count(drResponses.id),
      totalCompensation: sum(drResponses.compensation),
      avgReduction: avg(drResponses.actualReduction),
    })
    .from(drResponses)
    .innerJoin(
      demandResponseEvents,
      eq(drResponses.eventId, demandResponseEvents.id)
    )
    .where(
      and(
        gte(demandResponseEvents.startTime, startDate),
        lte(demandResponseEvents.startTime, endDate)
      )
    );

  const totalEvents = Number(eventTotals[0]?.totalEvents || 0);
  const totalReduction = Number(eventTotals[0]?.totalReduction || 0);
  const totalParticipants = Number(participantTotals[0]?.totalParticipants || 0);
  const totalCompensation = Number(participantTotals[0]?.totalCompensation || 0);
  const averageParticipationRate = totalEvents > 0 ? (totalParticipants / totalEvents) : 0;

  // Event type breakdown
  const eventTypeStats = await db
    .select({
      eventType: demandResponseEvents.eventType,
      count: count(demandResponseEvents.id),
      avgReduction: avg(demandResponseEvents.targetReduction),
    })
    .from(demandResponseEvents)
    .where(
      and(
        gte(demandResponseEvents.startTime, startDate),
        lte(demandResponseEvents.startTime, endDate)
      )
    )
    .groupBy(demandResponseEvents.eventType);

  const eventTypeBreakdown = eventTypeStats.map((stat) => ({
    eventType: stat.eventType,
    count: Number(stat.count),
    avgReduction: Number(stat.avgReduction || 0),
  }));

  // Performance over time
  const dailyPerformance = await db
    .select({
      date: sql<string>`DATE(${demandResponseEvents.startTime})`,
      events: count(demandResponseEvents.id),
      participants: sql<number>`COUNT(DISTINCT ${drResponses.userId})`,
      reduction: sum(drResponses.actualReduction),
    })
    .from(demandResponseEvents)
    .leftJoin(
      drResponses,
      eq(demandResponseEvents.id, drResponses.eventId)
    )
    .where(
      and(
        gte(demandResponseEvents.startTime, startDate),
        lte(demandResponseEvents.startTime, endDate)
      )
    )
    .groupBy(sql`DATE(${demandResponseEvents.startTime})`)
    .orderBy(sql`DATE(${demandResponseEvents.startTime})`);

  const performanceOverTime = dailyPerformance.map((stat) => ({
    date: stat.date,
    events: Number(stat.events),
    participants: Number(stat.participants),
    reduction: Number(stat.reduction || 0),
  }));

  return {
    totalEvents,
    totalParticipants,
    totalReduction,
    totalCompensation,
    averageParticipationRate,
    eventTypeBreakdown,
    performanceOverTime,
  };
}

/**
 * Get forecasting metrics for admin dashboard
 */
export async function getForecastingMetrics(
  startDate: Date,
  endDate: Date
): Promise<ForecastingMetrics> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  // Total forecasts and average accuracy
  const forecastTotals = await db
    .select({
      totalForecasts: count(drForecasts.id),
      averageAccuracy: avg(drForecasts.confidence),
    })
    .from(drForecasts)
    .where(
      and(
        gte(drForecasts.forecastDate, startDate),
        lte(drForecasts.forecastDate, endDate)
      )
    );

  const totalForecasts = Number(forecastTotals[0]?.totalForecasts || 0);
  const averageAccuracy = Number(forecastTotals[0]?.averageAccuracy || 0);

  // Forecasts by status
  const statusStats = await db
    .select({
      status: drForecasts.gridStatus,
      count: count(drForecasts.id),
    })
    .from(drForecasts)
    .where(
      and(
        gte(drForecasts.forecastDate, startDate),
        lte(drForecasts.forecastDate, endDate)
      )
    )
    .groupBy(drForecasts.gridStatus);

  const forecastsByStatus = statusStats.map((stat) => ({
    status: stat.status,
    count: Number(stat.count),
  }));

  // Accuracy over time
  const dailyAccuracy = await db
    .select({
      date: sql<string>`DATE(${drForecasts.forecastDate})`,
      accuracy: avg(drForecasts.confidence),
      forecasts: count(drForecasts.id),
    })
    .from(drForecasts)
    .where(
      and(
        gte(drForecasts.forecastDate, startDate),
        lte(drForecasts.forecastDate, endDate)
      )
    )
    .groupBy(sql`DATE(${drForecasts.forecastDate})`)
    .orderBy(sql`DATE(${drForecasts.forecastDate})`);

  const accuracyOverTime = dailyAccuracy.map((stat) => ({
    date: stat.date,
    accuracy: Number(stat.accuracy || 0),
    forecasts: Number(stat.forecasts),
  }));

  return {
    totalForecasts,
    averageAccuracy,
    forecastsByStatus,
    accuracyOverTime,
  };
}

/**
 * Get system-wide KPIs for admin dashboard
 */
export async function getSystemKPIs(): Promise<SystemKPIs> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  // User stats
  const { users, assets } = await import('../drizzle/schema');
  
  const userStats = await db
    .select({
      totalUsers: count(users.id),
      activeUsers: sql<number>`SUM(CASE WHEN ${users.lastSignedIn} >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN 1 ELSE 0 END)`,
    })
    .from(users);

  // Asset stats
  const assetStats = await db
    .select({
      totalAssets: count(assets.id),
      activeAssets: sql<number>`SUM(CASE WHEN ${assets.status} = 'active' THEN 1 ELSE 0 END)`,
    })
    .from(assets);

  // Trading stats
  const tradingStats = await db
    .select({
      totalEnergyTraded: sum(trades.energy),
    })
    .from(trades)
    .where(eq(trades.status, 'executed'));

  // Revenue stats
  const revenueStats = await db
    .select({
      platformRevenue: sum(payments.amount),
    })
    .from(payments)
    .where(eq(payments.status, 'completed'));

  // DR participation rate
  const drStats = await db
    .select({
      totalEnrolled: sql<number>`COUNT(DISTINCT ${drParticipants.userId})`,
    })
    .from(drParticipants);

  const totalUsers = Number(userStats[0]?.totalUsers || 0);
  const activeUsers = Number(userStats[0]?.activeUsers || 0);
  const totalAssets = Number(assetStats[0]?.totalAssets || 0);
  const activeAssets = Number(assetStats[0]?.activeAssets || 0);
  const totalEnergyTraded = Number(tradingStats[0]?.totalEnergyTraded || 0);
  const platformRevenue = Number(revenueStats[0]?.platformRevenue || 0);
  const totalEnrolled = Number(drStats[0]?.totalEnrolled || 0);
  const drParticipationRate = totalUsers > 0 ? (totalEnrolled / totalUsers) * 100 : 0;

  return {
    totalUsers,
    activeUsers,
    totalAssets,
    activeAssets,
    totalEnergyTraded,
    platformRevenue,
    drParticipationRate,
    // No satisfaction/feedback/rating source exists in drizzle/schema.ts, so
    // there is no real value to compute — report unavailable instead of a
    // fabricated constant.
    averageUserSatisfaction: null,
    satisfactionAvailable: false,
  };
}
