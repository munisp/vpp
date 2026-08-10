import { eq, and, or, lt } from "drizzle-orm";
import { priceAlerts, InsertPriceAlert } from "../drizzle/schema";
import { getDb } from "./db";

/**
 * Get all price alerts for a user
 */
export async function getUserPriceAlerts(userId: number) {
  const db = await getDb();
  if (!db) return [];
  
  return await db.select().from(priceAlerts).where(eq(priceAlerts.userId, userId));
}

/**
 * Get active price alerts for a user
 */
export async function getActivePriceAlerts(userId: number) {
  const db = await getDb();
  if (!db) return [];
  
  return await db.select().from(priceAlerts).where(
    and(
      eq(priceAlerts.userId, userId),
      eq(priceAlerts.isActive, true)
    )
  );
}

/**
 * Get all active price alerts (for monitoring service)
 */
export async function getAllActivePriceAlerts() {
  const db = await getDb();
  if (!db) return [];
  
  return await db.select().from(priceAlerts).where(eq(priceAlerts.isActive, true));
}

/**
 * Get price alert by ID
 */
export async function getPriceAlertById(id: number) {
  const db = await getDb();
  if (!db) return null;
  
  const result = await db.select().from(priceAlerts).where(eq(priceAlerts.id, id)).limit(1);
  return result.length > 0 ? result[0] : null;
}

/**
 * Create new price alert
 */
export async function createPriceAlert(data: InsertPriceAlert) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const result = await db.insert(priceAlerts).values(data);
  return result[0].insertId;
}

/**
 * Update price alert
 */
export async function updatePriceAlert(id: number, data: Partial<InsertPriceAlert>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  await db.update(priceAlerts).set(data).where(eq(priceAlerts.id, id));
}

/**
 * Delete price alert
 */
export async function deletePriceAlert(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  await db.delete(priceAlerts).where(eq(priceAlerts.id, id));
}

/**
 * Record alert trigger
 */
export async function recordAlertTrigger(id: number) {
  const db = await getDb();
  if (!db) return;
  
  const alert = await getPriceAlertById(id);
  if (!alert) return;
  
  const newTriggerCount = (alert.triggerCount || 0) + 1;
  const updates: any = {
    lastTriggeredAt: new Date(),
    triggerCount: newTriggerCount,
  };
  
  // Auto-disable if max triggers reached
  if (alert.maxTriggers && newTriggerCount >= alert.maxTriggers) {
    updates.isActive = false;
  }
  
  await db.update(priceAlerts).set(updates).where(eq(priceAlerts.id, id));
}

/**
 * Check if alert should trigger based on current price
 */
export function shouldTriggerAlert(alert: any, currentPrice: number): boolean {
  // Check cooldown period
  if (alert.lastTriggeredAt) {
    const cooldownMs = (alert.cooldownMinutes || 60) * 60 * 1000;
    const timeSinceLastTrigger = Date.now() - new Date(alert.lastTriggeredAt).getTime();
    if (timeSinceLastTrigger < cooldownMs) {
      return false;
    }
  }
  
  // Check price conditions
  switch (alert.alertType) {
    case "above":
      return currentPrice >= (alert.targetPrice || 0);
    case "below":
      return currentPrice <= (alert.targetPrice || 0);
    case "between":
      return currentPrice >= (alert.minPrice || 0) && currentPrice <= (alert.maxPrice || Infinity);
    default:
      return false;
  }
}
