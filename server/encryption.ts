import crypto from 'crypto';
import { ENV } from './_core/env';

// Use JWT_SECRET as encryption key (32 bytes for AES-256)
const ENCRYPTION_KEY = crypto
  .createHash('sha256')
  .update(ENV.cookieSecret)
  .digest();

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Encrypt sensitive data
 */
export function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  // Return: iv:authTag:encrypted
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt sensitive data
 */
export function decrypt(encryptedData: string): string {
  const parts = encryptedData.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted data format');
  }
  
  const [ivHex, authTagHex, encrypted] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  
  const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

/**
 * Encrypt payment gateway credentials
 */
export function encryptCredentials(credentials: Record<string, any>): string {
  return encrypt(JSON.stringify(credentials));
}

/**
 * Decrypt payment gateway credentials
 */
export function decryptCredentials(encryptedData: string): Record<string, any> {
  const decrypted = decrypt(encryptedData);
  return JSON.parse(decrypted);
}

/**
 * Hash sensitive data (one-way, for verification)
 */
export function hash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Verify hashed data
 */
export function verifyHash(text: string, hashedText: string): boolean {
  return hash(text) === hashedText;
}
