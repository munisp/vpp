import { eq, and, gte, lte, desc } from "drizzle-orm";
import { getDb } from "./db";
import {
  paymentCredentials,
  paymentGatewayLogs,
  InsertPaymentCredential,
  InsertPaymentGatewayLog,
} from "../drizzle/schema";
import { encryptCredentials, decryptCredentials } from "./encryption";

// Payment Credentials Management

export async function savePaymentCredentials(data: {
  gateway: "mpesa" | "airtel_money" | "tigo_pesa";
  environment: "sandbox" | "production";
  credentials: Record<string, any>;
  createdBy: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Encrypt credentials before storing
  const encryptedCredentials = encryptCredentials(data.credentials);

  // Check if credentials already exist for this gateway/environment
  const existing = await db
    .select()
    .from(paymentCredentials)
    .where(
      and(
        eq(paymentCredentials.gateway, data.gateway),
        eq(paymentCredentials.environment, data.environment)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    // Update existing
    await db
      .update(paymentCredentials)
      .set({
        credentials: encryptedCredentials,
        isValidated: "false",
        updatedAt: new Date(),
      })
      .where(eq(paymentCredentials.id, existing[0].id));

    return existing[0].id;
  } else {
    // Insert new
    const result = await db.insert(paymentCredentials).values({
      gateway: data.gateway,
      environment: data.environment,
      credentials: encryptedCredentials,
      createdBy: data.createdBy,
      isActive: "false",
      isValidated: "false",
    }).returning({ id: paymentCredentials.id });

    return result[0].id || 0;
  }
}

export async function getPaymentCredentials(
  gateway: "mpesa" | "airtel_money" | "tigo_pesa",
  environment: "sandbox" | "production"
) {
  const db = await getDb();
  if (!db) return null;

  const result = await db
    .select()
    .from(paymentCredentials)
    .where(
      and(
        eq(paymentCredentials.gateway, gateway),
        eq(paymentCredentials.environment, environment),
        eq(paymentCredentials.isActive, "true")
      )
    )
    .limit(1);

  if (result.length === 0) return null;

  const cred = result[0];

  // Decrypt credentials
  try {
    const decrypted = decryptCredentials(cred.credentials);
    return {
      ...cred,
      credentials: decrypted,
    };
  } catch (error) {
    console.error("Failed to decrypt credentials:", error);
    return null;
  }
}

export async function getPaymentCredentialsById(id: number) {
  const db = await getDb();
  if (!db) return null;

  const result = await db
    .select()
    .from(paymentCredentials)
    .where(eq(paymentCredentials.id, id))
    .limit(1);

  if (result.length === 0) return null;

  const cred = result[0];

  // Decrypt credentials
  try {
    const decrypted = decryptCredentials(cred.credentials);
    return {
      ...cred,
      credentials: decrypted,
    };
  } catch (error) {
    console.error("Failed to decrypt credentials:", error);
    return null;
  }
}

export async function getAllPaymentCredentials() {
  const db = await getDb();
  if (!db) return [];

  const results = await db.select().from(paymentCredentials);

  // Return without decrypted credentials (for listing)
  return results.map((cred) => ({
    id: cred.id,
    gateway: cred.gateway,
    environment: cred.environment,
    isActive: cred.isActive,
    isValidated: cred.isValidated,
    lastValidated: cred.lastValidated,
    validationError: cred.validationError,
    createdAt: cred.createdAt,
    updatedAt: cred.updatedAt,
  }));
}

export async function updateCredentialStatus(
  id: number,
  data: {
    isActive?: "true" | "false";
    isValidated?: "true" | "false";
    validationError?: string | null;
  }
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const updateData: any = { updatedAt: new Date() };

  if (data.isActive !== undefined) {
    updateData.isActive = data.isActive;
  }
  if (data.isValidated !== undefined) {
    updateData.isValidated = data.isValidated;
    updateData.lastValidated = new Date();
  }
  if (data.validationError !== undefined) {
    updateData.validationError = data.validationError;
  }

  await db
    .update(paymentCredentials)
    .set(updateData)
    .where(eq(paymentCredentials.id, id));
}

export async function deletePaymentCredentials(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db.delete(paymentCredentials).where(eq(paymentCredentials.id, id));
}

// Payment Gateway Logs

export async function logPaymentGatewayRequest(data: {
  paymentId?: number;
  gateway: "mpesa" | "airtel_money" | "tigo_pesa";
  requestType: string;
  requestPayload: Record<string, any>;
  responsePayload?: Record<string, any>;
  status: "pending" | "success" | "failed" | "timeout";
  errorMessage?: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.insert(paymentGatewayLogs).values({
    paymentId: data.paymentId || null,
    gateway: data.gateway,
    requestType: data.requestType,
    requestPayload: JSON.stringify(data.requestPayload),
    responsePayload: data.responsePayload
      ? JSON.stringify(data.responsePayload)
      : null,
    status: data.status,
    errorMessage: data.errorMessage || null,
  }).returning({ id: paymentGatewayLogs.id });

  return result[0].id || 0;
}

export async function getPaymentGatewayLogs(filters: {
  paymentId?: number;
  gateway?: "mpesa" | "airtel_money" | "tigo_pesa";
  status?: "pending" | "success" | "failed" | "timeout";
  limit?: number;
}) {
  const db = await getDb();
  if (!db) return [];

  let query = db.select().from(paymentGatewayLogs);

  const conditions = [];

  if (filters.paymentId) {
    conditions.push(eq(paymentGatewayLogs.paymentId, filters.paymentId));
  }
  if (filters.gateway) {
    conditions.push(eq(paymentGatewayLogs.gateway, filters.gateway));
  }
  if (filters.status) {
    conditions.push(eq(paymentGatewayLogs.status, filters.status));
  }

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as any;
  }

  const results = await query
    .orderBy(desc(paymentGatewayLogs.createdAt))
    .limit(filters.limit || 100);

  return results.map((log) => ({
    ...log,
    requestPayload: log.requestPayload ? JSON.parse(log.requestPayload) : null,
    responsePayload: log.responsePayload
      ? JSON.parse(log.responsePayload)
      : null,
  }));
}
