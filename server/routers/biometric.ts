import { z } from 'zod';
import { protectedProcedure, router } from '../_core/trpc';
import { getDb } from '../db';
import { biometricCredentials } from '../../drizzle/schema';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';

export const biometricRouter = router({
  // Get all biometric credentials for the current user
  getMyCredentials: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];

    const credentials = await db
      .select()
      .from(biometricCredentials)
      .where(eq(biometricCredentials.userId, ctx.user.id));

    // Don't send sensitive data to client
    return credentials.map((cred) => ({
      id: cred.id,
      deviceType: cred.deviceType,
      deviceName: cred.deviceName,
      lastUsed: cred.lastUsed,
      createdAt: cred.createdAt,
    }));
  }),

  // Delete a specific biometric credential
  deleteCredential: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      // Verify the credential belongs to the user
      const credential = await db
        .select()
        .from(biometricCredentials)
        .where(eq(biometricCredentials.id, input.id))
        .limit(1);

      if (credential.length === 0 || credential[0].userId !== ctx.user.id) {
        throw new Error('Credential not found');
      }

      await db
        .delete(biometricCredentials)
        .where(eq(biometricCredentials.id, input.id));

      return { success: true };
    }),

  // Get biometric registration status
  getStatus: protectedProcedure
    .query(async ({ ctx }) => {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      const userId = ctx.user.id;

      const credentials = await db
        .select()
        .from(biometricCredentials)
        .where(eq(biometricCredentials.userId, userId));

      return {
        isRegistered: credentials.length > 0,
        credentialCount: credentials.length,
      };
    }),

  // Register biometric credential
  registerCredential: protectedProcedure
    .input(z.union([
      z.object({
        action: z.literal('get-options'),
      }),
      z.object({
        action: z.literal('verify'),
        credentialId: z.string(),
        attestationObject: z.string(),
        clientDataJSON: z.string(),
      }),
      z.object({
        action: z.literal('unregister'),
      }),
    ]))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      const userId = ctx.user.id;
      const user = ctx.user;

      if (input.action === 'get-options') {
        // Generate registration options
        const challenge = crypto.randomBytes(32).toString('base64url');

        // Store challenge in session or temporary storage
        // For simplicity, we'll return it directly
        // In production, store in Redis with expiration

        return {
          challenge,
          rpName: 'VPP Consumer Platform',
          rpId: process.env.VITE_APP_DOMAIN || 'localhost',
          userId: Buffer.from(userId.toString()).toString('base64url'),
          userName: user.email || user.name || `user_${userId}`,
          userDisplayName: user.name || user.email || `User ${userId}`,
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },  // ES256
            { type: 'public-key', alg: -257 }, // RS256
          ],
        };
      }

      if (input.action === 'verify') {
        // Verify and store credential
        // In production, implement full WebAuthn verification
        // For now, store the credential

        await db.insert(biometricCredentials).values({
          userId,
          credentialId: input.credentialId,
          publicKey: input.attestationObject, // Store public key extracted from attestation
          counter: 0,
          deviceType: 'platform', // platform authenticator
        });

        return { success: true };
      }

      if (input.action === 'unregister') {
        // Remove all credentials for user
        await db.delete(biometricCredentials).where(eq(biometricCredentials.userId, userId));
        return { success: true };
      }

      throw new Error('Invalid action');
    }),

  // Authenticate with biometric
  authenticate: protectedProcedure
    .input(z.union([
      z.object({
        action: z.literal('get-options'),
      }),
      z.object({
        action: z.literal('verify'),
        credentialId: z.string(),
        authenticatorData: z.string(),
        clientDataJSON: z.string(),
        signature: z.string(),
        userHandle: z.string().optional(),
      }),
    ]))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      const userId = ctx.user.id;

      if (input.action === 'get-options') {
        // Get user's registered credentials
        const credentials = await db
          .select()
          .from(biometricCredentials)
          .where(eq(biometricCredentials.userId, userId));

        if (credentials.length === 0) {
          throw new Error('No credentials registered');
        }

        // Generate authentication challenge
        const challenge = crypto.randomBytes(32).toString('base64url');

        return {
          challenge,
          rpId: process.env.VITE_APP_DOMAIN || 'localhost',
          allowCredentials: credentials.map(cred => ({
            type: 'public-key',
            id: cred.credentialId,
          })),
        };
      }

      if (input.action === 'verify') {
        // Verify signature
        // In production, implement full WebAuthn verification
        // For now, just check if credential exists

        const credential = await db
          .select()
          .from(biometricCredentials)
          .where(eq(biometricCredentials.credentialId, input.credentialId))
          .limit(1);

        if (credential.length === 0 || credential[0].userId !== userId) {
          throw new Error('Invalid credential');
        }

        // Update counter
        await db
          .update(biometricCredentials)
          .set({
            counter: credential[0].counter + 1,
            lastUsed: new Date(),
          })
          .where(eq(biometricCredentials.id, credential[0].id));

        return { success: true };
      }

      throw new Error('Invalid action');
    }),
});
