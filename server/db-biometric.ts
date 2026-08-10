import { eq, and } from "drizzle-orm";
import { getDb } from "./db";
import { biometricCredentials, type InsertBiometricCredential } from "../drizzle/biometric-credentials-schema";

/**
 * Get all biometric credentials for a user
 */
export async function getUserBiometricCredentials(userId: number) {
  const db = await getDb();
  if (!db) return [];

  try {
    const credentials = await db
      .select()
      .from(biometricCredentials)
      .where(eq(biometricCredentials.userId, userId));
    
    return credentials;
  } catch (error) {
    console.error("[Biometric] Failed to get user credentials:", error);
    return [];
  }
}

/**
 * Get a specific biometric credential by ID
 */
export async function getBiometricCredentialById(id: number, userId: number) {
  const db = await getDb();
  if (!db) return null;

  try {
    const result = await db
      .select()
      .from(biometricCredentials)
      .where(
        and(
          eq(biometricCredentials.id, id),
          eq(biometricCredentials.userId, userId)
        )
      )
      .limit(1);
    
    return result[0] || null;
  } catch (error) {
    console.error("[Biometric] Failed to get credential:", error);
    return null;
  }
}

/**
 * Get a biometric credential by credential ID
 */
export async function getBiometricCredentialByCredentialId(credentialId: string) {
  const db = await getDb();
  if (!db) return null;

  try {
    const result = await db
      .select()
      .from(biometricCredentials)
      .where(eq(biometricCredentials.credentialId, credentialId))
      .limit(1);
    
    return result[0] || null;
  } catch (error) {
    console.error("[Biometric] Failed to get credential by credentialId:", error);
    return null;
  }
}

/**
 * Register a new biometric credential
 */
export async function registerBiometricCredential(credential: InsertBiometricCredential) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  try {
    const result = await db.insert(biometricCredentials).values(credential);
    return result;
  } catch (error) {
    console.error("[Biometric] Failed to register credential:", error);
    throw error;
  }
}

/**
 * Update last used timestamp for a credential
 */
export async function updateBiometricCredentialLastUsed(credentialId: string) {
  const db = await getDb();
  if (!db) return;

  try {
    await db
      .update(biometricCredentials)
      .set({ lastUsed: new Date() })
      .where(eq(biometricCredentials.credentialId, credentialId));
  } catch (error) {
    console.error("[Biometric] Failed to update last used:", error);
  }
}

/**
 * Update credential counter (for WebAuthn)
 */
export async function updateBiometricCredentialCounter(credentialId: string, counter: number) {
  const db = await getDb();
  if (!db) return;

  try {
    await db
      .update(biometricCredentials)
      .set({ counter })
      .where(eq(biometricCredentials.credentialId, credentialId));
  } catch (error) {
    console.error("[Biometric] Failed to update counter:", error);
  }
}

/**
 * Delete a biometric credential
 */
export async function deleteBiometricCredential(id: number, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  try {
    await db
      .delete(biometricCredentials)
      .where(
        and(
          eq(biometricCredentials.id, id),
          eq(biometricCredentials.userId, userId)
        )
      );
  } catch (error) {
    console.error("[Biometric] Failed to delete credential:", error);
    throw error;
  }
}

/**
 * Count biometric credentials for a user
 */
export async function countUserBiometricCredentials(userId: number) {
  const db = await getDb();
  if (!db) return 0;

  try {
    const credentials = await getUserBiometricCredentials(userId);
    return credentials.length;
  } catch (error) {
    console.error("[Biometric] Failed to count credentials:", error);
    return 0;
  }
}
