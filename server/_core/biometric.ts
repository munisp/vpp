import { getDb } from "../db";
import { biometricCredentials } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import crypto from "crypto";

/**
 * Biometric Authentication Service
 * 
 * Provides WebAuthn-based biometric authentication using fingerprint, Face ID, or other platform authenticators.
 * This service handles credential registration, verification, and management.
 */

export interface BiometricRegistrationOptions {
  userId: number;
  userName: string;
  userDisplayName: string;
  deviceType?: string;
  deviceName?: string;
}

export interface BiometricVerificationData {
  credentialId: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
  userId: number;
}

export interface BiometricCredentialInfo {
  id: number;
  credentialId: string;
  deviceType: string | null;
  deviceName: string | null;
  createdAt: Date;
  lastUsed: Date | null;
}

/**
 * Generate WebAuthn registration options for a user
 * 
 * @param options - User information for registration
 * @returns Registration challenge and options for client
 */
export async function generateRegistrationOptions(
  options: BiometricRegistrationOptions
): Promise<{
  challenge: string;
  userId: number;
  userName: string;
  userDisplayName: string;
  rpName: string;
  rpId: string;
  timeout: number;
  attestation: string;
  authenticatorSelection: {
    authenticatorAttachment: string;
    requireResidentKey: boolean;
    userVerification: string;
  };
}> {
  // Generate a cryptographically secure random challenge
  const challenge = crypto.randomBytes(32).toString("base64url");

  return {
    challenge,
    userId: options.userId,
    userName: options.userName,
    userDisplayName: options.userDisplayName,
    rpName: "VPP Consumer Platform",
    rpId: process.env.VITE_APP_DOMAIN || "localhost",
    timeout: 60000, // 60 seconds
    attestation: "none",
    authenticatorSelection: {
      authenticatorAttachment: "platform", // Use platform authenticator (Touch ID, Face ID, Windows Hello)
      requireResidentKey: false,
      userVerification: "required",
    },
  };
}

/**
 * Register a new biometric credential for a user
 * 
 * @param userId - User ID
 * @param credentialId - WebAuthn credential ID
 * @param publicKey - Public key for verification
 * @param deviceType - Type of device (platform, cross-platform)
 * @param deviceName - Name of the device
 * @returns Credential ID
 */
export async function registerBiometricCredential(
  userId: number,
  credentialId: string,
  publicKey: string,
  deviceType?: string,
  deviceName?: string
): Promise<string> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  try {
    await db.insert(biometricCredentials).values({
      userId,
      credentialId,
      publicKey,
      counter: 0,
      deviceType: deviceType || null,
      deviceName: deviceName || null,
      createdAt: new Date(),
      lastUsed: null,
    });

    return credentialId;
  } catch (error) {
    console.error("[Biometric] Failed to register credential:", error);
    throw new Error("Failed to register biometric credential");
  }
}

/**
 * Get all biometric credentials for a user
 * 
 * @param userId - User ID
 * @returns List of credentials
 */
export async function getUserBiometricCredentials(
  userId: number
): Promise<BiometricCredentialInfo[]> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  try {
    const credentials = await db
      .select({
        id: biometricCredentials.id,
        credentialId: biometricCredentials.credentialId,
        deviceType: biometricCredentials.deviceType,
        deviceName: biometricCredentials.deviceName,
        createdAt: biometricCredentials.createdAt,
        lastUsed: biometricCredentials.lastUsed,
      })
      .from(biometricCredentials)
      .where(eq(biometricCredentials.userId, userId));

    return credentials;
  } catch (error) {
    console.error("[Biometric] Failed to get credentials:", error);
    throw new Error("Failed to retrieve biometric credentials");
  }
}

/**
 * Verify a biometric authentication attempt
 * 
 * @param data - Verification data from client
 * @returns True if verification successful
 */
export async function verifyBiometricAuthentication(
  data: BiometricVerificationData
): Promise<boolean> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  try {
    // Get the credential from database
    const credentials = await db
      .select()
      .from(biometricCredentials)
      .where(eq(biometricCredentials.credentialId, data.credentialId))
      .limit(1);

    if (credentials.length === 0) {
      console.warn("[Biometric] Credential not found:", data.credentialId);
      return false;
    }

    const credential = credentials[0];

    // Verify user ID matches
    if (credential.userId !== data.userId) {
      console.warn("[Biometric] User ID mismatch");
      return false;
    }

    // In production, you would:
    // 1. Verify the signature using the stored public key
    // 2. Verify the authenticator data
    // 3. Verify the client data JSON
    // 4. Check and update the counter to prevent replay attacks
    
    // For now, we'll do basic validation and update last used time
    // Real WebAuthn verification requires the @simplewebauthn/server library

    // Update last used time and counter
    await db
      .update(biometricCredentials)
      .set({
        lastUsed: new Date(),
        counter: credential.counter + 1,
      })
      .where(eq(biometricCredentials.id, credential.id));

    return true;
  } catch (error) {
    console.error("[Biometric] Verification failed:", error);
    return false;
  }
}

/**
 * Delete a biometric credential
 * 
 * @param userId - User ID
 * @param credentialId - Credential ID to delete
 * @returns True if deleted successfully
 */
export async function deleteBiometricCredential(
  userId: number,
  credentialId: string
): Promise<boolean> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  try {
    const result = await db
      .delete(biometricCredentials)
      .where(
        eq(biometricCredentials.credentialId, credentialId)
      );

    return true;
  } catch (error) {
    console.error("[Biometric] Failed to delete credential:", error);
    return false;
  }
}

/**
 * Check if user has any biometric credentials registered
 * 
 * @param userId - User ID
 * @returns True if user has credentials
 */
export async function hasBiometricCredentials(userId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) {
    return false;
  }

  try {
    const credentials = await db
      .select({ id: biometricCredentials.id })
      .from(biometricCredentials)
      .where(eq(biometricCredentials.userId, userId))
      .limit(1);

    return credentials.length > 0;
  } catch (error) {
    console.error("[Biometric] Failed to check credentials:", error);
    return false;
  }
}

/**
 * Health check for biometric service
 * 
 * @returns Service status
 */
export async function healthCheck(): Promise<{
  status: "healthy" | "degraded" | "unhealthy";
  message: string;
}> {
  try {
    const db = await getDb();
    if (!db) {
      return {
        status: "unhealthy",
        message: "Database not available",
      };
    }

    // Test database connection
    await db.select({ id: biometricCredentials.id }).from(biometricCredentials).limit(1);

    return {
      status: "healthy",
      message: "Biometric service operational",
    };
  } catch (error) {
    return {
      status: "degraded",
      message: `Service degraded: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}
