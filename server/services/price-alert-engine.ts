/**
 * Price Alert Evaluation Engine (feature 14)
 *
 * Extends the EXISTING priceAlerts feature (drizzle/price-alerts-schema.ts +
 * server/db-price-alerts.ts + server/routers/priceAlerts.ts):
 *  - The existing price_alerts table has no market scope (country/priceType),
 *    so scope lives in the companion table price_alert_market_scopes
 *    (1:1, in drizzle/trust-access-schema.ts).
 *  - checkPriceAlerts() is the scheduler-ready evaluation engine: it reads the
 *    latest marketPrices rows, matches active subscriptions, dedupes via the
 *    existing cooldown fields (shouldTriggerAlert / recordAlertTrigger from
 *    db-price-alerts), and dispatches via real web-push
 *    (server/_core/sendNotification.ts) and real SMS
 *    (server/_core/notifications.ts sendSMS) for opted-in users.
 *  - Every dispatch attempt is persisted to price_alert_dispatch_log.
 */

import { eq } from "drizzle-orm";
import { getDb, getCurrentPrice } from "../db";
import { users } from "../../drizzle/schema";
import { priceAlertMarketScopes, priceAlertDispatchLog } from "../../drizzle/trust-access-schema";
import {
  getAllActivePriceAlerts,
  createPriceAlert,
  deletePriceAlert,
  getPriceAlertById,
  getUserPriceAlerts,
  recordAlertTrigger,
  shouldTriggerAlert,
} from "../db-price-alerts";
import { sendPushNotification } from "../_core/sendNotification";
import { sendSMS } from "../_core/notifications";

type Country = "nigeria" | "tanzania";
type PriceType = "off_peak" | "shoulder" | "peak" | "super_peak";

const PRICE_TYPES: PriceType[] = ["off_peak", "shoulder", "peak", "super_peak"];

export interface DispatchResult {
  priceAlertId: number;
  userId: number;
  country: Country;
  priceType: PriceType;
  observedPrice: number;
  pushSent: boolean;
  smsSent: boolean;
  error: string | null;
}

export interface EvaluationSummary {
  evaluatedAt: string;
  activeAlerts: number;
  triggered: number;
  dispatched: DispatchResult[];
  skippedNoPrice: number;
  errors: Array<{ priceAlertId: number; error: string }>;
}

async function getAlertScope(priceAlertId: number): Promise<{ country: Country; priceType: PriceType } | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(priceAlertMarketScopes)
    .where(eq(priceAlertMarketScopes.priceAlertId, priceAlertId))
    .limit(1);
  return rows[0] ? { country: rows[0].country, priceType: rows[0].priceType } : null;
}

/**
 * Evaluate all active price alerts against the latest market prices and
 * dispatch notifications. Safe to call from a scheduler: dedupe is handled
 * by the per-subscription cooldown fields on price_alerts.
 */
export async function checkPriceAlerts(): Promise<EvaluationSummary> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const activeAlerts = await getAllActivePriceAlerts();
  const summary: EvaluationSummary = {
    evaluatedAt: new Date().toISOString(),
    activeAlerts: activeAlerts.length,
    triggered: 0,
    dispatched: [],
    skippedNoPrice: 0,
    errors: [],
  };

  for (const alert of activeAlerts) {
    try {
      // Market scope: companion table wins; otherwise fall back to the user's
      // country and evaluate all price types (legacy alerts created before
      // scopes existed).
      const scope = await getAlertScope(alert.id);
      let candidates: Array<{ country: Country; priceType: PriceType }>;
      if (scope) {
        candidates = [scope];
      } else {
        const userRows = await db.select({ country: users.country }).from(users).where(eq(users.id, alert.userId)).limit(1);
        const country = (userRows[0]?.country ?? "tanzania") as Country;
        candidates = PRICE_TYPES.map((priceType) => ({ country, priceType }));
      }

      // Find the first in-scope price that matches the threshold.
      let matched: { country: Country; priceType: PriceType; price: number } | null = null;
      let sawAnyPrice = false;
      for (const c of candidates) {
        const current = await getCurrentPrice(c.country, c.priceType);
        if (!current) continue;
        sawAnyPrice = true;
        if (shouldTriggerAlert(alert, current.price)) {
          matched = { country: c.country, priceType: c.priceType, price: current.price };
          break;
        }
      }
      if (!sawAnyPrice) summary.skippedNoPrice++;
      if (!matched) continue;

      summary.triggered++;

      // Dispatch: real web-push + real SMS (only for users who opted in).
      let pushSent = false;
      let smsSent = false;
      let smsTo: string | null = null;
      const errors: string[] = [];

      if (alert.notifyPush) {
        try {
          const result = await sendPushNotification(
            alert.userId,
            {
              title: `Price Alert: ${alert.name}`,
              body: `${matched.priceType.replace("_", " ")} price is now ${matched.price} cents/kWh (${matched.country}) - your "${alert.alertType}" threshold was hit.`,
              data: { type: "price_alert", priceAlertId: alert.id, priceType: matched.priceType, price: matched.price },
            },
            "pushSystemAlert"
          );
          pushSent = result.success && result.sentCount > 0;
          if (!pushSent) errors.push("push: no subscription accepted delivery");
        } catch (err: any) {
          errors.push(`push: ${err?.message || err}`);
        }
      }

      if (alert.notifySMS) {
        const userRows = await db.select({ phone: users.phone }).from(users).where(eq(users.id, alert.userId)).limit(1);
        smsTo = userRows[0]?.phone ?? null;
        if (!smsTo) {
          errors.push("sms: user opted in but has no phone number on file");
        } else {
          smsSent = await sendSMS({
            to: smsTo,
            message: `VPP Price Alert: ${alert.name}. ${matched.priceType.replace("_", " ")} price is ${matched.price} cents/kWh. Threshold: ${alert.alertType}.`,
          });
          if (!smsSent) errors.push("sms: Africa's Talking delivery failed");
        }
      }

      // Record the trigger on the existing table (cooldown + maxTriggers).
      await recordAlertTrigger(alert.id);

      await db.insert(priceAlertDispatchLog).values({
        priceAlertId: alert.id,
        userId: alert.userId,
        country: matched.country,
        priceType: matched.priceType,
        observedPrice: matched.price,
        pushSent,
        smsSent,
        smsTo,
        error: errors.length > 0 ? errors.join("; ") : null,
      });

      summary.dispatched.push({
        priceAlertId: alert.id,
        userId: alert.userId,
        country: matched.country,
        priceType: matched.priceType,
        observedPrice: matched.price,
        pushSent,
        smsSent,
        error: errors.length > 0 ? errors.join("; ") : null,
      });
    } catch (error: any) {
      console.error(`[PriceAlertEngine] Evaluation failed for alert ${alert.id}:`, error);
      summary.errors.push({ priceAlertId: alert.id, error: error?.message || String(error) });
    }
  }

  console.log(
    `[PriceAlertEngine] Evaluated ${summary.activeAlerts} alerts: ${summary.triggered} triggered, ${summary.dispatched.length} dispatched, ${summary.skippedNoPrice} skipped (no price), ${summary.errors.length} errors`
  );
  return summary;
}

/**
 * Subscribe: create a price alert plus its market scope.
 */
export async function subscribe(input: {
  userId: number;
  name: string;
  description?: string;
  alertType: "above" | "below" | "between";
  targetPrice?: number;
  minPrice?: number;
  maxPrice?: number;
  country: Country;
  priceType: PriceType;
  notifyPush: boolean;
  notifySMS: boolean;
  cooldownMinutes: number;
  maxTriggers?: number;
}): Promise<{ priceAlertId: number }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const priceAlertId = Number(await createPriceAlert({
    userId: input.userId,
    name: input.name,
    description: input.description,
    alertType: input.alertType,
    targetPrice: input.targetPrice,
    minPrice: input.minPrice,
    maxPrice: input.maxPrice,
    isActive: true,
    notifyEmail: false,
    notifyPush: input.notifyPush,
    notifySMS: input.notifySMS,
    cooldownMinutes: input.cooldownMinutes,
    maxTriggers: input.maxTriggers,
    triggerCount: 0,
  }));

  await db.insert(priceAlertMarketScopes).values({
    priceAlertId,
    country: input.country,
    priceType: input.priceType,
  });

  return { priceAlertId };
}

/**
 * Unsubscribe: verify ownership, then delete the alert and its scope.
 */
export async function unsubscribe(priceAlertId: number, userId: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const alert = await getPriceAlertById(priceAlertId);
  if (!alert || alert.userId !== userId) {
    throw new Error("Price alert subscription not found");
  }

  await db.delete(priceAlertMarketScopes).where(eq(priceAlertMarketScopes.priceAlertId, priceAlertId));
  await deletePriceAlert(priceAlertId);
}

/**
 * List the caller's subscriptions joined with their market scopes.
 */
export async function listMySubscriptions(userId: number) {
  const db = await getDb();
  if (!db) return [];

  const alerts = await getUserPriceAlerts(userId);
  if (alerts.length === 0) return [];

  const scopes = await db.select().from(priceAlertMarketScopes);
  const scopeByAlertId = new Map(scopes.map((s) => [s.priceAlertId, s]));

  return alerts.map((a) => ({
    ...a,
    scope: scopeByAlertId.get(a.id) ?? null,
  }));
}
