import {
  integer as int,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Biometric Credentials table - stores WebAuthn credentials for biometric authentication
 */
export const biometricCredentials = pgTable("biometric_credentials", {
  id: serial("id").primaryKey(),
  userId: int("user_id").notNull(),
  
  // WebAuthn credential details
  credentialId: varchar("credential_id", { length: 512 }).notNull().unique(),
  publicKey: text("public_key").notNull(),
  counter: int("counter").default(0).notNull(),
  
  // Device information
  deviceType: varchar("device_type", { length: 50 }), // platform, cross-platform
  deviceName: varchar("device_name", { length: 255 }),
  
  // Usage tracking
  lastUsed: timestamp("last_used"),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type BiometricCredential = typeof biometricCredentials.$inferSelect;
export type InsertBiometricCredential = typeof biometricCredentials.$inferInsert;
