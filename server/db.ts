import { eq, and, desc, gte, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  InsertUser,
  users,
  assets,
  InsertAsset,
  Asset,
  telemetry,
  InsertTelemetry,
  Telemetry,
  contracts,
  InsertContract,
  Contract,
  trades,
  InsertTrade,
  Trade,
  marketPrices,
  InsertMarketPrice,
  MarketPrice,
  billings,
  InsertBilling,
  Billing,
  payments,
  InsertPayment,
  Payment,
  tokens,
  InsertToken,
  Token,
  alerts,
  InsertAlert,
  Alert,
  tradingPreferences,
  InsertTradingPreference,
  TradingPreference,
} from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

/** A positive integer of milliseconds, or the default when the value is unusable. */
function timeoutMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    console.warn(
      `[Database] ${name}=${raw} is not a whole number of milliseconds; using ${fallback}ms instead.`
    );
    return fallback;
  }
  return parsed;
}

export function statementTimeoutMs(): number {
  return timeoutMs('PG_STATEMENT_TIMEOUT_MS', 30_000);
}

export function idleTransactionTimeoutMs(): number {
  return timeoutMs('PG_IDLE_TRANSACTION_TIMEOUT_MS', 60_000);
}

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      // `timezone=UTC` is not optional: every timestamp column is
      // `timestamp without time zone` holding UTC, and `NOW()` is converted
      // with the *session* time zone. A non-UTC session would silently shift
      // every server-generated timestamp (payment, settlement, DR windows).
      //
      // Two timeouts alongside it, because this process holds money paths:
      // `statement_timeout` stops one pathological query from occupying a
      // connection until the pool is exhausted, and
      // `idle_in_transaction_session_timeout` kills a transaction whose client
      // stopped talking — that is the state that holds row locks on payments and
      // settlement rows indefinitely and blocks every writer behind it. Both are
      // deliberately far above normal request work (defaults 30s and 60s) and
      // overridable, since reporting and migrations legitimately run longer.
      _db = drizzle({
        connection: {
          connectionString: process.env.DATABASE_URL,
          options: [
            '-c timezone=UTC',
            `-c statement_timeout=${statementTimeoutMs()}`,
            `-c idle_in_transaction_session_timeout=${idleTransactionTimeoutMs()}`,
          ].join(' '),
        },
      });
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

// ============= User Functions =============

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "phone", "loginMethod", "timezone"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? undefined;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }
    if (user.country !== undefined) {
      values.country = user.country;
      updateSet.country = user.country;
    }
    if (user.currency !== undefined) {
      values.currency = user.currency;
      updateSet.currency = user.currency;
    }
    if (user.language !== undefined) {
      values.language = user.language;
      updateSet.language = user.language;
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onConflictDoUpdate({
      target: users.openId,
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getUserById(id: number) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// ============= Asset Functions =============

export async function createAsset(asset: InsertAsset): Promise<Asset> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.insert(assets).values(asset).returning({ id: assets.id });
  const insertedId = Number(result[0].id);
  const created = await getAssetById(insertedId);
  if (!created) throw new Error("Failed to create asset");
  return created;
}

export async function getAssetById(id: number): Promise<Asset | undefined> {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getUserAssets(userId: number): Promise<Asset[]> {
  const db = await getDb();
  if (!db) return [];

  return await db.select().from(assets).where(eq(assets.userId, userId)).orderBy(desc(assets.createdAt));
}

export async function updateAsset(id: number, updates: Partial<InsertAsset>): Promise<Asset | undefined> {
  const db = await getDb();
  if (!db) return undefined;

  await db.update(assets).set(updates).where(eq(assets.id, id));
  return await getAssetById(id);
}

export async function deleteAsset(id: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  await db.delete(assets).where(eq(assets.id, id));
  return true;
}

// ============= Telemetry Functions =============

export async function insertTelemetry(data: InsertTelemetry): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db.insert(telemetry).values(data);
}

export async function getLatestTelemetry(assetId: number): Promise<Telemetry | undefined> {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .select()
    .from(telemetry)
    .where(eq(telemetry.assetId, assetId))
    .orderBy(desc(telemetry.timestamp))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function getTelemetryRange(
  assetId: number,
  startTime: Date,
  endTime: Date
): Promise<Telemetry[]> {
  const db = await getDb();
  if (!db) return [];

  return await db
    .select()
    .from(telemetry)
    .where(
      and(
        eq(telemetry.assetId, assetId),
        gte(telemetry.timestamp, startTime),
        lte(telemetry.timestamp, endTime)
      )
    )
    .orderBy(telemetry.timestamp);
}

// ============= Contract Functions =============

export async function createContract(contract: InsertContract): Promise<Contract> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.insert(contracts).values(contract).returning({ id: contracts.id });
  const insertedId = Number(result[0].id);
  const created = await getContractById(insertedId);
  if (!created) throw new Error("Failed to create contract");
  return created;
}

export async function getContractById(id: number): Promise<Contract | undefined> {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.select().from(contracts).where(eq(contracts.id, id)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getUserActiveContract(userId: number): Promise<Contract | undefined> {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .select()
    .from(contracts)
    .where(and(eq(contracts.userId, userId), eq(contracts.status, "active")))
    .orderBy(desc(contracts.createdAt))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

// ============= Trading Functions =============

export async function createTrade(trade: InsertTrade): Promise<Trade> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.insert(trades).values(trade).returning({ id: trades.id });
  const insertedId = Number(result[0].id);
  const created = await getTradeById(insertedId);
  if (!created) throw new Error("Failed to create trade");
  return created;
}

export async function getTradeById(id: number): Promise<Trade | undefined> {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.select().from(trades).where(eq(trades.id, id)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getUserTrades(userId: number, limit: number = 50): Promise<Trade[]> {
  const db = await getDb();
  if (!db) return [];

  return await db
    .select()
    .from(trades)
    .where(eq(trades.userId, userId))
    .orderBy(desc(trades.timestamp))
    .limit(limit);
}

/**
 * Transition a trade to a new status. When `expectedCurrentStatus` is given the
 * update only applies to a trade still in that status, so concurrent callers
 * cannot both observe the transition. Returns true when this call performed it.
 */
export async function updateTradeStatus(
  id: number,
  status: "pending" | "executed" | "cancelled" | "failed",
  expectedCurrentStatus?: "pending" | "executed" | "cancelled" | "failed"
): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .update(trades)
    .set({ status })
    .where(
      expectedCurrentStatus
        ? and(eq(trades.id, id), eq(trades.status, expectedCurrentStatus))
        : eq(trades.id, id)
    );

  return (result.rowCount ?? 0) > 0;
}

// ============= Market Price Functions =============

export async function insertMarketPrice(price: InsertMarketPrice): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db.insert(marketPrices).values(price);
}

export async function getCurrentPrice(
  country: "nigeria" | "tanzania",
  priceType: "off_peak" | "shoulder" | "peak" | "super_peak"
): Promise<MarketPrice | undefined> {
  const db = await getDb();
  if (!db) return undefined;

  const now = new Date();
  const result = await db
    .select()
    .from(marketPrices)
    .where(
      and(
        eq(marketPrices.country, country),
        eq(marketPrices.priceType, priceType),
        lte(marketPrices.timestamp, now),
        gte(marketPrices.validUntil, now)
      )
    )
    .orderBy(desc(marketPrices.timestamp))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

// ============= Billing Functions =============

export async function createBilling(billing: InsertBilling): Promise<Billing> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.insert(billings).values(billing).returning({ id: billings.id });
  const insertedId = Number(result[0].id);
  const created = await getBillingById(insertedId);
  if (!created) throw new Error("Failed to create billing");
  return created;
}

export async function getBillingById(id: number): Promise<Billing | undefined> {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.select().from(billings).where(eq(billings.id, id)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getUserBillings(userId: number, limit: number = 12): Promise<Billing[]> {
  const db = await getDb();
  if (!db) return [];

  return await db
    .select()
    .from(billings)
    .where(eq(billings.userId, userId))
    .orderBy(desc(billings.periodEnd))
    .limit(limit);
}

export async function updateBillingStatus(
  id: number,
  status: "draft" | "issued" | "paid" | "overdue" | "cancelled",
  paidAt?: Date,
  paymentMethod?: string,
  transactionId?: string
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const updates: Partial<InsertBilling> = { status };
  if (paidAt) updates.paidAt = paidAt;
  if (paymentMethod) updates.paymentMethod = paymentMethod;
  if (transactionId) updates.transactionId = transactionId;

  await db.update(billings).set(updates).where(eq(billings.id, id));
}

// ============= Payment Functions =============

export async function createPayment(payment: InsertPayment): Promise<Payment> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.insert(payments).values(payment).returning({ id: payments.id });
  const insertedId = Number(result[0].id);
  const created = await getPaymentById(insertedId);
  if (!created) throw new Error("Failed to create payment");
  return created;
}

export async function getPaymentById(id: number): Promise<Payment | undefined> {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.select().from(payments).where(eq(payments.id, id)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

/**
 * Merge keys into a payment's JSON metadata, preserving anything already there.
 */
export async function updatePaymentMetadata(
  id: number,
  patch: Record<string, unknown>
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const existing = await getPaymentById(id);
  if (!existing) throw new Error(`Payment ${id} not found`);

  const current = existing.metadata ? JSON.parse(existing.metadata) : {};

  await db
    .update(payments)
    .set({ metadata: JSON.stringify({ ...current, ...patch }) })
    .where(eq(payments.id, id));
}

/**
 * Transition a payment to a new status. When `expectedCurrentStatus` is given
 * the update only applies while the payment is still in that status, which
 * makes repeated verifications and duplicate gateway callbacks idempotent.
 * Returns true when this call performed the transition.
 */
export async function updatePaymentStatus(
  id: number,
  status: "pending" | "completed" | "failed" | "refunded",
  transactionId?: string,
  expectedCurrentStatus?: "pending" | "completed" | "failed" | "refunded"
): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const updates: Partial<InsertPayment> = { status };
  if (transactionId) updates.transactionId = transactionId;

  const result = await db
    .update(payments)
    .set(updates)
    .where(
      expectedCurrentStatus
        ? and(eq(payments.id, id), eq(payments.status, expectedCurrentStatus))
        : eq(payments.id, id)
    );

  return (result.rowCount ?? 0) > 0;
}

// ============= Token Functions =============

export async function createToken(token: InsertToken): Promise<Token> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.insert(tokens).values(token).returning({ id: tokens.id });
  const insertedId = Number(result[0].id);
  const created = await getTokenById(insertedId);
  if (!created) throw new Error("Failed to create token");
  return created;
}

export async function getTokenById(id: number): Promise<Token | undefined> {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.select().from(tokens).where(eq(tokens.id, id)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

/**
 * Token already issued for a payment, if any. Used to keep token issuance
 * idempotent across retried verifications and duplicate gateway callbacks.
 */
export async function getTokenByPaymentId(paymentId: number): Promise<Token | undefined> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .select()
    .from(tokens)
    .where(eq(tokens.paymentId, paymentId))
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getTokenByCode(tokenCode: string): Promise<Token | undefined> {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.select().from(tokens).where(eq(tokens.tokenCode, tokenCode)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// ============= Alert Functions =============

export async function createAlert(alert: InsertAlert): Promise<Alert> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.insert(alerts).values(alert).returning({ id: alerts.id });
  const insertedId = Number(result[0].id);
  const created = await getAlertById(insertedId);
  if (!created) throw new Error("Failed to create alert");
  return created;
}

export async function getAlertById(id: number): Promise<Alert | undefined> {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.select().from(alerts).where(eq(alerts.id, id)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getUserAlerts(userId: number, limit: number = 50): Promise<Alert[]> {
  const db = await getDb();
  if (!db) return [];

  return await db
    .select()
    .from(alerts)
    .where(eq(alerts.userId, userId))
    .orderBy(desc(alerts.createdAt))
    .limit(limit);
}

export async function markAlertAsRead(id: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db.update(alerts).set({ isRead: true, readAt: new Date() }).where(eq(alerts.id, id));
}

export async function deleteAlert(id: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db.delete(alerts).where(eq(alerts.id, id));
}

// ============= Trading Preference Functions =============

export async function upsertTradingPreference(pref: InsertTradingPreference): Promise<TradingPreference> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .insert(tradingPreferences)
    .values(pref)
    .onConflictDoUpdate({
      target: tradingPreferences.userId,
      set: {
        tradingMode: pref.tradingMode,
        minExportPrice: pref.minExportPrice,
        maxImportPrice: pref.maxImportPrice,
        minBatteryLevel: pref.minBatteryLevel,
        maxBatteryLevel: pref.maxBatteryLevel,
        enableP2P: pref.enableP2P,
        enableNotifications: pref.enableNotifications,
        metadata: pref.metadata,
      },
    });

  const result = await db
    .select()
    .from(tradingPreferences)
    .where(eq(tradingPreferences.userId, pref.userId))
    .limit(1);

  if (result.length === 0) throw new Error("Failed to upsert trading preference");
  return result[0];
}

export async function getTradingPreference(userId: number): Promise<TradingPreference | undefined> {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .select()
    .from(tradingPreferences)
    .where(eq(tradingPreferences.userId, userId))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}
