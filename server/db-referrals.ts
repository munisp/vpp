import { eq, and, ne, or, desc, sql } from "drizzle-orm";
import { getDb } from "./db";
import { referrals, referralRewards, users } from "../drizzle/schema";
import crypto from "crypto";

/**
 * Referral Program Database Helpers
 * 
 * Provides functions for managing user referrals, tracking rewards, and processing referral bonuses.
 */

/**
 * Generate a unique referral code for a user
 * 
 * @param userId - User ID
 * @returns Unique referral code
 */
export function generateReferralCode(userId: number): string {
  const randomPart = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `REF-${userId}-${randomPart}`;
}

/**
 * Create a referral code for a user
 * 
 * @param referrerId - User ID of the referrer
 * @param expiresInDays - Number of days until expiration (default: 90)
 * @returns Referral record
 */
export async function createReferralCode(
  referrerId: number,
  expiresInDays: number = 90
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const referralCode = generateReferralCode(referrerId);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + expiresInDays);

  await db.insert(referrals).values({
    referrerId,
    referralCode,
    status: "pending",
    rewardType: "credits",
    rewardAmount: 1000, // 1000 credits default
    rewardCurrency: "CREDITS",
    expiresAt,
  });

  // Get the created referral
  const created = await db
    .select()
    .from(referrals)
    .where(eq(referrals.referralCode, referralCode))
    .limit(1);

  return {
    id: created[0]?.id || 0,
    referralCode,
    expiresAt,
  };
}

/**
 * Get user's referral code
 * 
 * @param userId - User ID
 * @returns Referral code or null
 */
export async function getUserReferralCode(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .select()
    .from(referrals)
    .where(
      and(
        eq(referrals.referrerId, userId),
        eq(referrals.status, "pending"),
        or(
          sql`${referrals.expiresAt} IS NULL`,
          sql`${referrals.expiresAt} > NOW()`
        )
      )
    )
    .orderBy(desc(referrals.createdAt))
    .limit(1);

  return result[0] || null;
}

/**
 * Apply a referral code when a new user signs up
 * 
 * @param referralCode - Referral code
 * @param refereeId - New user ID
 * @param refereeEmail - New user email
 * @returns Updated referral record
 */
export async function applyReferralCode(
  referralCode: string,
  refereeId: number,
  refereeEmail?: string
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Find the referral
  const result = await db
    .select()
    .from(referrals)
    .where(eq(referrals.referralCode, referralCode))
    .limit(1);

  if (result.length === 0) {
    throw new Error("Invalid referral code");
  }

  const referral = result[0];

  // Check if expired
  if (referral.expiresAt && referral.expiresAt < new Date()) {
    throw new Error("Referral code has expired");
  }

  // Check if already used
  if (referral.status !== "pending") {
    throw new Error("Referral code already used");
  }

  // Update referral with referee information
  await db
    .update(referrals)
    .set({
      refereeId,
      refereeEmail: refereeEmail || null,
      status: "completed",
      completedAt: new Date(),
    })
    .where(eq(referrals.id, referral.id));

  return referral;
}

/**
 * Process referral reward (give reward to referrer)
 * 
 * @param referralId - Referral ID
 * @returns Reward record
 */
export async function processReferralReward(referralId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Get referral
  const result = await db
    .select()
    .from(referrals)
    .where(eq(referrals.id, referralId))
    .limit(1);

  if (result.length === 0) {
    throw new Error("Referral not found");
  }

  const referral = result[0];

  if (referral.status === "rewarded") {
    throw new Error("Reward already processed");
  }

  return await db.transaction(async (tx) => {
    // Claim the referral before crediting: the conditional update is the lock
    // that stops concurrent callers from both inserting a reward row.
    const claim = await tx
      .update(referrals)
      .set({
        status: "rewarded",
        rewardedAt: new Date(),
      })
      .where(and(eq(referrals.id, referral.id), ne(referrals.status, "rewarded")));

    if (Number(claim[0].affectedRows) === 0) {
      throw new Error("Reward already processed");
    }

    const insert = await tx.insert(referralRewards).values({
      referralId: referral.id,
      userId: referral.referrerId,
      rewardType: referral.rewardType,
      amount: referral.rewardAmount,
      currency: referral.rewardCurrency,
      status: "pending",
      description: `Referral reward for inviting user ${referral.refereeId}`,
    });

    const rewardId = Number(insert[0].insertId);
    if (!Number.isInteger(rewardId) || rewardId <= 0) {
      throw new Error("Failed to persist referral reward");
    }

    return {
      id: rewardId,
      amount: referral.rewardAmount,
      currency: referral.rewardCurrency,
    };
  });
}

/**
 * Get all referrals made by a user
 * 
 * @param userId - User ID
 * @returns List of referrals
 */
export async function getUserReferrals(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db
    .select()
    .from(referrals)
    .where(eq(referrals.referrerId, userId))
    .orderBy(desc(referrals.createdAt));
}

/**
 * Get all rewards earned by a user through referrals
 * 
 * @param userId - User ID
 * @returns List of rewards
 */
export async function getUserReferralRewards(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db
    .select()
    .from(referralRewards)
    .where(eq(referralRewards.userId, userId))
    .orderBy(desc(referralRewards.createdAt));
}

/**
 * Get referral statistics for a user
 * 
 * @param userId - User ID
 * @returns Referral statistics
 */
export async function getUserReferralStats(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const allReferrals = await db
    .select()
    .from(referrals)
    .where(eq(referrals.referrerId, userId));

  const totalReferrals = allReferrals.length;
  const completedReferrals = allReferrals.filter(r => r.status === "completed" || r.status === "rewarded").length;
  const pendingReferrals = allReferrals.filter(r => r.status === "pending").length;

  const rewards = await db
    .select()
    .from(referralRewards)
    .where(eq(referralRewards.userId, userId));

  const totalRewardsEarned = rewards.reduce((sum, reward) => sum + reward.amount, 0);
  const pendingRewards = rewards.filter(r => r.status === "pending").length;

  return {
    totalReferrals,
    completedReferrals,
    pendingReferrals,
    totalRewardsEarned,
    pendingRewards,
  };
}

/**
 * Validate a referral code
 * 
 * @param referralCode - Referral code to validate
 * @returns True if valid, false otherwise
 */
export async function validateReferralCode(referralCode: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  try {
    const result = await db
      .select()
      .from(referrals)
      .where(eq(referrals.referralCode, referralCode))
      .limit(1);

    if (result.length === 0) return false;

    const referral = result[0];

    // Check if expired
    if (referral.expiresAt && referral.expiresAt < new Date()) {
      return false;
    }

    // Check if already used
    if (referral.status !== "pending") {
      return false;
    }

    return true;
  } catch (error) {
    console.error("[Referrals] Validation error:", error);
    return false;
  }
}

/**
 * Get referral by code
 * 
 * @param referralCode - Referral code
 * @returns Referral record or null
 */
export async function getReferralByCode(referralCode: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .select()
    .from(referrals)
    .where(eq(referrals.referralCode, referralCode))
    .limit(1);

  return result[0] || null;
}

/**
 * Mark expired referrals
 * 
 * @returns Number of referrals marked as expired
 */
export async function markExpiredReferrals(): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .update(referrals)
    .set({ status: "expired" })
    .where(
      and(
        eq(referrals.status, "pending"),
        sql`${referrals.expiresAt} < NOW()`
      )
    );

  // Count expired referrals
  const expired = await db
    .select()
    .from(referrals)
    .where(eq(referrals.status, "expired"));

  return expired.length;
}
