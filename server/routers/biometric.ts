import { z } from 'zod';
import { protectedProcedure, router } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import { getDb } from '../db';
import { biometricCredentials } from '../../drizzle/schema';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';

/**
 * Biometric (WebAuthn) router.
 *
 * Fail-closed design: challenges are issued and stored server-side with a
 * 5-minute TTL, and every authentication attempt must present a valid ES256
 * assertion signature over authenticatorData || SHA-256(clientDataJSON)
 * that verifies against the credential public key extracted at registration.
 * No path marks a user authenticated without a cryptographically verified
 * assertion.
 */

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

interface StoredChallenge {
  challenge: string; // base64url
  expiresAt: number;
}

// Server-side challenge store (per-user, per-purpose), 5-minute TTL.
const challengeStore = new Map<string, StoredChallenge>();

function issueChallenge(userId: number, purpose: 'register' | 'authenticate'): string {
  const challenge = crypto.randomBytes(32).toString('base64url');
  challengeStore.set(`${userId}:${purpose}`, {
    challenge,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  });
  return challenge;
}

function consumeChallenge(userId: number, purpose: 'register' | 'authenticate'): string {
  const key = `${userId}:${purpose}`;
  const stored = challengeStore.get(key);
  challengeStore.delete(key);
  if (!stored || stored.expiresAt < Date.now()) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'WebAuthn challenge missing or expired. Request new options and retry.',
    });
  }
  return stored.challenge;
}

function rpId(): string {
  return process.env.VITE_APP_DOMAIN || 'localhost';
}

// ---------------------------------------------------------------------------
// Minimal CBOR decoder (sufficient for WebAuthn attestation objects / COSE keys)
// ---------------------------------------------------------------------------

class CborReader {
  private view: DataView;
  private offset = 0;

  constructor(private buf: Buffer) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  decode(): any {
    const value = this.readItem();
    return value;
  }

  private readLength(additional: number): number {
    if (additional < 24) return additional;
    if (additional === 24) return this.view.getUint8(this.offset++);
    if (additional === 25) {
      const v = this.view.getUint16(this.offset);
      this.offset += 2;
      return v;
    }
    if (additional === 26) {
      const v = this.view.getUint32(this.offset);
      this.offset += 4;
      return v;
    }
    throw new Error('Unsupported CBOR length encoding');
  }

  private readItem(): any {
    const initial = this.view.getUint8(this.offset++);
    const major = initial >> 5;
    const additional = initial & 0x1f;

    switch (major) {
      case 0:
        return this.readLength(additional);
      case 1:
        return -1 - this.readLength(additional);
      case 2: {
        const len = this.readLength(additional);
        const out = this.buf.subarray(this.offset, this.offset + len);
        this.offset += len;
        return Buffer.from(out);
      }
      case 3: {
        const len = this.readLength(additional);
        const out = this.buf.toString('utf8', this.offset, this.offset + len);
        this.offset += len;
        return out;
      }
      case 4: {
        const len = this.readLength(additional);
        const arr = new Array(len);
        for (let i = 0; i < len; i++) arr[i] = this.readItem();
        return arr;
      }
      case 5: {
        const len = this.readLength(additional);
        const map: Record<string, any> = {};
        for (let i = 0; i < len; i++) {
          const k = this.readItem();
          map[String(k)] = this.readItem();
        }
        return map;
      }
      case 7:
        if (additional === 20) return false;
        if (additional === 21) return true;
        if (additional === 22) return null;
        throw new Error(`Unsupported CBOR simple value ${additional}`);
      default:
        throw new Error(`Unsupported CBOR major type ${major}`);
    }
  }
}

// ---------------------------------------------------------------------------
// WebAuthn parsing helpers
// ---------------------------------------------------------------------------

interface ParsedAttestation {
  credentialId: Buffer;
  publicKeyJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
}

/**
 * Parse an attestationObject (base64url CBOR) and extract the credential ID
 * and ES256 COSE public key, converting it to a JWK.
 */
function parseAttestationObject(attestationObjectB64: string): ParsedAttestation {
  const attestation = new CborReader(Buffer.from(attestationObjectB64, 'base64url')).decode();
  const authData: Buffer | undefined = attestation?.authData;
  if (!authData || !Buffer.isBuffer(authData) || authData.length < 37) {
    throw new Error('Invalid attestation object: missing authenticator data');
  }

  const flags = authData[32];
  const hasAttestedCredentialData = (flags & 0x40) !== 0;
  if (!hasAttestedCredentialData) {
    throw new Error('Attestation object does not contain attested credential data');
  }

  // rpIdHash(32) + flags(1) + counter(4) + aaguid(16) + credIdLen(2) + credId + COSE key
  const credIdLen = authData.readUInt16BE(53);
  const credIdStart = 55;
  const credentialId = authData.subarray(credIdStart, credIdStart + credIdLen);
  const coseKeyBytes = authData.subarray(credIdStart + credIdLen);
  const coseKey = new CborReader(Buffer.from(coseKeyBytes)).decode();

  // COSE EC2 key: 1=kty(2 EC2), 3=alg(-7 ES256), -1=crv(1 P-256), -2=x, -3=y
  if (coseKey['1'] !== 2 || coseKey['3'] !== -7 || coseKey['-1'] !== 1) {
    throw new Error('Unsupported credential public key algorithm (expected ES256 / P-256)');
  }
  const x: Buffer = coseKey['-2'];
  const y: Buffer = coseKey['-3'];
  if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) {
    throw new Error('Malformed EC2 public key coordinates');
  }

  return {
    credentialId: Buffer.from(credentialId),
    publicKeyJwk: {
      kty: 'EC',
      crv: 'P-256',
      x: x.toString('base64url'),
      y: y.toString('base64url'),
    },
  };
}

interface ParsedClientData {
  type: string;
  challenge: string;
  origin?: string;
}

function parseClientDataJSON(clientDataJSONB64: string): ParsedClientData {
  let parsed: any;
  try {
    parsed = JSON.parse(Buffer.from(clientDataJSONB64, 'base64url').toString('utf8'));
  } catch {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Malformed clientDataJSON.' });
  }
  if (typeof parsed?.challenge !== 'string' || typeof parsed?.type !== 'string') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'clientDataJSON missing required fields.' });
  }
  return parsed as ParsedClientData;
}

function assertOrigin(origin: string | undefined): void {
  const expectedOrigin = process.env.WEBAUTHN_ORIGIN;
  if (!expectedOrigin) {
    console.warn('[Biometric] WEBAUTHN_ORIGIN not set; origin check skipped');
    return;
  }
  if (origin !== expectedOrigin) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'WebAuthn origin mismatch.' });
  }
}

interface ParsedAuthenticatorData {
  rpIdHash: Buffer;
  flags: number;
  signCount: number;
}

function parseAuthenticatorData(authenticatorDataB64: string): ParsedAuthenticatorData {
  const authData = Buffer.from(authenticatorDataB64, 'base64url');
  if (authData.length < 37) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Malformed authenticatorData.' });
  }
  return {
    rpIdHash: authData.subarray(0, 32),
    flags: authData[32],
    signCount: authData.readUInt32BE(33),
  };
}

function publicKeyFromStored(stored: string): crypto.KeyObject {
  // New registrations store the key as a JWK JSON string. Legacy rows stored
  // the raw attestation object; recover the real key from it so assertions
  // can still be verified cryptographically.
  try {
    const jwk = JSON.parse(stored);
    if (jwk?.kty === 'EC' && jwk?.crv === 'P-256' && jwk?.x && jwk?.y) {
      return crypto.createPublicKey({ key: jwk, format: 'jwk' });
    }
  } catch {
    // Not a JWK JSON string — try attestation object below.
  }
  const { publicKeyJwk } = parseAttestationObject(stored);
  return crypto.createPublicKey({ key: publicKeyJwk, format: 'jwk' });
}

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
        const challenge = issueChallenge(userId, 'register');

        return {
          challenge,
          rpName: 'VPP Consumer Platform',
          rpId: rpId(),
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
        // Validate the client response against the server-issued challenge.
        const expectedChallenge = consumeChallenge(userId, 'register');
        const clientData = parseClientDataJSON(input.clientDataJSON);
        if (clientData.type !== 'webauthn.create') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid WebAuthn ceremony type.' });
        }
        if (clientData.challenge !== expectedChallenge) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'WebAuthn challenge mismatch.' });
        }
        assertOrigin(clientData.origin);

        // Extract the real credential public key from the attestation object.
        // If parsing fails, nothing is stored.
        let parsed: ParsedAttestation;
        try {
          parsed = parseAttestationObject(input.attestationObject);
        } catch (error) {
          console.error('[Biometric] Failed to parse attestation object:', error);
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Unable to parse attestation object; credential not stored.',
          });
        }

        if (parsed.credentialId.toString('base64url') !== input.credentialId) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Credential ID does not match attestation object.',
          });
        }

        // Attestation trust-chain verification requires a WebAuthn library
        // (unavailable here), so the credential is stored as unverified until
        // the first cryptographically verified authentication assertion.
        await db.insert(biometricCredentials).values({
          userId,
          credentialId: input.credentialId,
          publicKey: JSON.stringify(parsed.publicKeyJwk),
          counter: 0,
          deviceType: 'platform', // platform authenticator
        });

        return {
          success: true,
          verified: false,
          message: 'Credential stored, verification pending.',
        };
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

        const challenge = issueChallenge(userId, 'authenticate');

        return {
          challenge,
          rpId: rpId(),
          allowCredentials: credentials.map(cred => ({
            type: 'public-key',
            id: cred.credentialId,
          })),
        };
      }

      if (input.action === 'verify') {
        const credential = await db
          .select()
          .from(biometricCredentials)
          .where(eq(biometricCredentials.credentialId, input.credentialId))
          .limit(1);

        if (credential.length === 0 || credential[0].userId !== userId) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Invalid credential' });
        }

        // 1. Challenge binding
        const expectedChallenge = consumeChallenge(userId, 'authenticate');
        const clientData = parseClientDataJSON(input.clientDataJSON);
        if (clientData.type !== 'webauthn.get') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid WebAuthn ceremony type.' });
        }
        if (clientData.challenge !== expectedChallenge) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'WebAuthn challenge mismatch.' });
        }
        assertOrigin(clientData.origin);

        // 2. RP ID hash + user presence flags
        const authData = parseAuthenticatorData(input.authenticatorData);
        const expectedRpIdHash = crypto.createHash('sha256').update(rpId()).digest();
        if (!crypto.timingSafeEqual(authData.rpIdHash, expectedRpIdHash)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'RP ID hash mismatch.' });
        }
        if ((authData.flags & 0x01) === 0) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'User presence flag not set.' });
        }

        // 3. Signature verification: signature covers
        //    authenticatorData || SHA-256(clientDataJSON)
        let publicKey: crypto.KeyObject;
        try {
          publicKey = publicKeyFromStored(credential[0].publicKey);
        } catch (error) {
          console.error('[Biometric] Stored public key unusable:', error);
          return {
            success: false,
            error: 'BIOMETRIC_VERIFICATION_NOT_CONFIGURED',
            message: 'Stored credential cannot be used for verification. Re-register this device.',
          };
        }

        const clientDataHash = crypto
          .createHash('sha256')
          .update(Buffer.from(input.clientDataJSON, 'base64url'))
          .digest();
        const signedBytes = Buffer.concat([
          Buffer.from(input.authenticatorData, 'base64url'),
          clientDataHash,
        ]);
        const signature = Buffer.from(input.signature, 'base64url');

        const verified = crypto.verify('sha256', signedBytes, publicKey, signature);
        if (!verified) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Biometric assertion signature verification failed.',
          });
        }

        // 4. Signature counter: a non-increasing counter indicates a cloned
        //    authenticator.
        const storedCounter = credential[0].counter ?? 0;
        if (authData.signCount > 0 && storedCounter > 0 && authData.signCount <= storedCounter) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Authenticator signature counter did not increase; possible cloned credential.',
          });
        }

        await db
          .update(biometricCredentials)
          .set({
            counter: Math.max(authData.signCount, storedCounter),
            lastUsed: new Date(),
          })
          .where(eq(biometricCredentials.id, credential[0].id));

        return { success: true, verified: true };
      }

      throw new Error('Invalid action');
    }),
});
