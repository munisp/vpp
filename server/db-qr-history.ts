import { eq, and, desc } from "drizzle-orm";
import { getDb } from "./db";
import { qrCodeHistory, type InsertQRCodeHistory } from "../drizzle/qr-history-schema";

/**
 * Record a QR code scan
 */
export async function recordQRScan(data: {
  userId: number;
  paymentType: "merchant" | "p2p" | "bill" | "token";
  amount: string;
  currency: string;
  qrCodeData: string;
  merchantId?: string;
  merchantName?: string;
  recipientId?: string;
  recipientName?: string;
  billId?: string;
  billType?: string;
  reference?: string;
  description?: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  try {
    const result = await db.insert(qrCodeHistory).values({
      userId: data.userId,
      operationType: "scan",
      paymentType: data.paymentType,
      amount: data.amount,
      currency: data.currency,
      qrCodeData: data.qrCodeData,
      merchantId: data.merchantId || null,
      merchantName: data.merchantName || null,
      recipientId: data.recipientId || null,
      recipientName: data.recipientName || null,
      billId: data.billId || null,
      billType: data.billType || null,
      reference: data.reference || null,
      description: data.description || null,
      scannedAt: new Date(),
      status: "pending",
    });

    return result;
  } catch (error) {
    console.error("[QRHistory] Failed to record scan:", error);
    throw error;
  }
}

/**
 * Record a QR code generation
 */
export async function recordQRGeneration(data: {
  userId: number;
  paymentType: "merchant" | "p2p" | "bill" | "token";
  amount: string;
  currency: string;
  qrCodeData: string;
  qrCodeImage?: string;
  merchantId?: string;
  merchantName?: string;
  recipientId?: string;
  recipientName?: string;
  billId?: string;
  billType?: string;
  reference?: string;
  description?: string;
  expiresAt?: Date;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  try {
    const result = await db.insert(qrCodeHistory).values({
      userId: data.userId,
      operationType: "generate",
      paymentType: data.paymentType,
      amount: data.amount,
      currency: data.currency,
      qrCodeData: data.qrCodeData,
      qrCodeImage: data.qrCodeImage || null,
      merchantId: data.merchantId || null,
      merchantName: data.merchantName || null,
      recipientId: data.recipientId || null,
      recipientName: data.recipientName || null,
      billId: data.billId || null,
      billType: data.billType || null,
      reference: data.reference || null,
      description: data.description || null,
      generatedAt: new Date(),
      expiresAt: data.expiresAt || null,
      status: "pending",
    });

    return result;
  } catch (error) {
    console.error("[QRHistory] Failed to record generation:", error);
    throw error;
  }
}

/**
 * Get user's QR code history
 */
export async function getUserQRHistory(userId: number, limit: number = 50) {
  const db = await getDb();
  if (!db) return [];

  try {
    const history = await db
      .select()
      .from(qrCodeHistory)
      .where(eq(qrCodeHistory.userId, userId))
      .orderBy(desc(qrCodeHistory.createdAt))
      .limit(limit);

    return history;
  } catch (error) {
    console.error("[QRHistory] Failed to get user history:", error);
    return [];
  }
}

/**
 * Update QR code transaction status
 */
export async function updateQRStatus(
  id: number,
  userId: number,
  status: "pending" | "completed" | "failed" | "expired"
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  try {
    const updates: any = { status };
    
    if (status === "completed") {
      updates.completedAt = new Date();
    }

    await db
      .update(qrCodeHistory)
      .set(updates)
      .where(and(eq(qrCodeHistory.id, id), eq(qrCodeHistory.userId, userId)));
  } catch (error) {
    console.error("[QRHistory] Failed to update status:", error);
    throw error;
  }
}

/**
 * Get QR code history statistics for a user
 */
export async function getUserQRStats(userId: number) {
  const db = await getDb();
  if (!db) return { totalScans: 0, totalGenerations: 0, totalAmount: "0" };

  try {
    const history = await getUserQRHistory(userId, 1000);

    const scans = history.filter((h) => h.operationType === "scan");
    const generations = history.filter((h) => h.operationType === "generate");

    const totalAmount = history
      .filter((h) => h.status === "completed")
      .reduce((sum, h) => sum + parseFloat(h.amount), 0);

    return {
      totalScans: scans.length,
      totalGenerations: generations.length,
      totalAmount: totalAmount.toFixed(2),
    };
  } catch (error) {
    console.error("[QRHistory] Failed to get stats:", error);
    return { totalScans: 0, totalGenerations: 0, totalAmount: "0" };
  }
}
