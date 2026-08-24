/**
 * SMS Command Channel Service (feature 11)
 *
 * Parses inbound SMS commands from feature-phone users (via the Africa's
 * Talking inbound webhook), executes them against real platform data, and
 * composes a reply. Every inbound message and its reply is persisted to
 * sms_command_log for audit.
 *
 * Phone -> user resolution:
 *   1. users.phone (normalized digit/suffix match) -> resolvedVia 'users_phone'
 *   2. most recent payments.phoneNumber            -> resolvedVia 'payments_phone'
 *   3. otherwise                                    -> resolvedVia 'unresolved'
 */

import { eq, desc, and, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  users,
  assets,
  telemetry,
  payments,
  billings,
  tokens,
  alerts,
} from "../../drizzle/schema";
import { smsCommandLog, type InsertSmsCommandLog } from "../../drizzle/trust-access-schema";
import { prepaidAccounts, prepaidTokens } from "../../drizzle/prepaid-schema";
import { prepaidBalance } from "./prepaid-accounting";
import { sendSMS } from "../_core/notifications";

export type SmsCommand =
  | "BALANCE"
  | "STATUS"
  | "TOKEN_LAST"
  | "TOKEN_RESEND"
  | "PREPAID_CREDIT"
  | "OUTAGE"
  | "HELP"
  | "UNKNOWN";

export interface SmsProcessResult {
  logId: number | null;
  userId: number | null;
  resolvedVia: "users_phone" | "payments_phone" | "unresolved";
  command: SmsCommand;
  reply: string;
  replySent: boolean;
  replyError: string | null;
}

/** Normalize a phone number to digits only. */
export function normalizePhone(phone: string): string {
  return phone.replace(/[^0-9]/g, "");
}

/** Compare two phone numbers by their last 9 significant digits (subscriber number). */
function phoneMatches(a: string, b: string): boolean {
  const da = normalizePhone(a);
  const db_ = normalizePhone(b);
  if (!da || !db_) return false;
  if (da === db_) return true;
  const suffixLen = 9;
  if (da.length >= suffixLen && db_.length >= suffixLen) {
    return da.slice(-suffixLen) === db_.slice(-suffixLen);
  }
  return false;
}

/** Parse the raw SMS text into a command. */
export function parseCommand(text: string): SmsCommand {
  const t = text.trim().toUpperCase().replace(/\s+/g, " ");
  if (t === "BALANCE" || t === "BAL") return "BALANCE";
  if (t === "STATUS") return "STATUS";
  // Resend is matched before the bare TOKEN commands so "TOKEN RESEND" is not
  // read as a request for the last token.
  if (t === "TOKEN RESEND" || t === "RESEND" || t === "RESEND TOKEN") return "TOKEN_RESEND";
  if (t === "TOKEN LAST" || t === "TOKEN" || t === "LAST TOKEN") return "TOKEN_LAST";
  if (t === "CREDIT" || t === "UNITS" || t === "PREPAID") return "PREPAID_CREDIT";
  if (t === "OUTAGE" || t.startsWith("OUTAGE ")) return "OUTAGE";
  if (t === "HELP" || t === "") return "HELP";
  return "UNKNOWN";
}

/**
 * Resolve a phone number to a platform user.
 * Never throws: returns { userId: null, resolvedVia: 'unresolved' } when no match.
 */
export async function resolveUserByPhone(phone: string): Promise<{
  userId: number | null;
  resolvedVia: "users_phone" | "payments_phone" | "unresolved";
}> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // 1. users.phone (normalized match done in JS to tolerate format differences)
  const usersWithPhone = await db
    .select({ id: users.id, phone: users.phone })
    .from(users)
    .where(isNotNull(users.phone));

  const direct = usersWithPhone.find((u) => u.phone && phoneMatches(u.phone, phone));
  if (direct) {
    return { userId: direct.id, resolvedVia: "users_phone" };
  }

  // 2. Most recent payment made from this phone number
  const paymentRows = await db
    .select({ userId: payments.userId, phoneNumber: payments.phoneNumber, createdAt: payments.createdAt })
    .from(payments)
    .where(isNotNull(payments.phoneNumber))
    .orderBy(desc(payments.createdAt))
    .limit(500);

  const viaPayment = paymentRows.find((p) => p.phoneNumber && phoneMatches(p.phoneNumber, phone));
  if (viaPayment) {
    return { userId: viaPayment.userId, resolvedVia: "payments_phone" };
  }

  return { userId: null, resolvedVia: "unresolved" };
}

/** BALANCE: net wallet balance from real payments vs paid billings. */
async function buildBalanceReply(userId: number): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const userRows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const currency = userRows[0]?.currency ?? "TZS";

  const paidRows = await db
    .select({ total: sql<string>`COALESCE(SUM(${payments.amount}), 0)` })
    .from(payments)
    .where(and(eq(payments.userId, userId), eq(payments.status, "completed")));
  const totalPaidCents = Number(paidRows[0]?.total ?? 0);

  const billedRows = await db
    .select({ total: sql<string>`COALESCE(SUM(${billings.totalValue}), 0)` })
    .from(billings)
    .where(and(eq(billings.userId, userId), eq(billings.status, "paid")));
  const totalBilledCents = Number(billedRows[0]?.total ?? 0);

  const balanceCents = totalPaidCents - totalBilledCents;
  const fmt = (cents: number) => `${currency} ${(cents / 100).toFixed(2)}`;

  return `VPP Balance: ${fmt(balanceCents)}. Total paid in: ${fmt(totalPaidCents)}. Total billed: ${fmt(totalBilledCents)}.`;
}

/** STATUS: latest telemetry summary across the user's assets. */
async function buildStatusReply(userId: number): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const userAssets = await db.select().from(assets).where(eq(assets.userId, userId));
  if (userAssets.length === 0) {
    return "VPP Status: no assets registered on your account. Contact your VPP agent to enrol your system.";
  }

  const assetIds = userAssets.map((a) => a.id);
  const latestRows = await db
    .select()
    .from(telemetry)
    .where(inArray(telemetry.assetId, assetIds))
    .orderBy(desc(telemetry.timestamp))
    .limit(200);

  const latestByAsset = new Map<number, (typeof latestRows)[number]>();
  for (const row of latestRows) {
    if (!latestByAsset.has(row.assetId)) latestByAsset.set(row.assetId, row);
  }

  const parts: string[] = [];
  for (const asset of userAssets.slice(0, 3)) {
    const t = latestByAsset.get(asset.id);
    if (!t) {
      parts.push(`${asset.name}: no data yet`);
      continue;
    }
    const powerW = t.power ?? 0;
    const volts = t.voltage != null ? (t.voltage / 1000).toFixed(0) : "?";
    const ageMin = Math.max(0, Math.round((Date.now() - new Date(t.timestamp).getTime()) / 60000));
    parts.push(`${asset.name} (${asset.status}): ${powerW}W, ${volts}V, ${ageMin}min ago`);
  }
  return `VPP Status: ${parts.join("; ")}`;
}

/** TOKEN LAST: last purchased token; code only revealed when active (really vended). */
async function buildTokenLastReply(userId: number): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const vend = await latestPrepaidVend(userId);
  if (vend) return describeVend(vend);

  const rows = await db
    .select()
    .from(tokens)
    .where(eq(tokens.userId, userId))
    .orderBy(desc(tokens.createdAt))
    .limit(1);

  const token = rows[0];
  if (!token) {
    return "VPP Token: no tokens found on your account. Buy credit via M-Pesa/Airtel/Tigo to receive a token.";
  }

  if (token.status === "pending_issuance") {
    return "VPP Token: your latest token is still being issued (pending). You will receive it by SMS shortly. Reply TOKEN LAST again in a few minutes.";
  }

  if (token.status === "active") {
    return `VPP Token: ${token.tokenCode}. Energy: ${token.energyKwh} kWh. Valid until ${new Date(token.validUntil).toISOString().slice(0, 10)}. Enter it on your meter.`;
  }

  // used or expired: do not re-vend an already consumed code as if new
  const when = token.usedAt
    ? new Date(token.usedAt).toISOString().slice(0, 10)
    : new Date(token.validUntil).toISOString().slice(0, 10);
  return `VPP Token: your last token (${token.energyKwh} kWh) is ${token.status.toUpperCase()} as of ${when}. Buy new credit to receive a fresh token.`;
}

/**
 * The customer's newest prepaid vend, if they have a prepaid account.
 *
 * Prepaid tokens are the vends that actually came from the OpenPAYGO encoder, so
 * they are preferred over the legacy `tokens` rows, which may still hold a
 * `PENDING_ISSUANCE_<id>` placeholder from before a vending keyring existed.
 */
async function latestPrepaidVend(userId: number): Promise<{
  code: string;
  energyWh: number;
  status: "issued" | "redeemed" | "void";
  redeemedAt: Date | null;
} | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = await db
    .select({
      code: prepaidTokens.tokenCode,
      energyWh: prepaidTokens.energyWh,
      status: prepaidTokens.status,
      redeemedAt: prepaidTokens.redeemedAt,
    })
    .from(prepaidTokens)
    .innerJoin(prepaidAccounts, eq(prepaidTokens.accountId, prepaidAccounts.id))
    .where(eq(prepaidAccounts.userId, userId))
    .orderBy(desc(prepaidTokens.issuedAt))
    .limit(1);

  return rows[0] ?? null;
}

function describeVend(vend: {
  code: string;
  energyWh: number;
  status: "issued" | "redeemed" | "void";
  redeemedAt: Date | null;
}): string {
  const kwh = (vend.energyWh / 1000).toFixed(2);
  if (vend.status === "issued") {
    return `VPP Token: ${vend.code}. Energy: ${kwh} kWh. Enter it on your meter.`;
  }
  if (vend.status === "redeemed") {
    const when = vend.redeemedAt ? new Date(vend.redeemedAt).toISOString().slice(0, 10) : "an earlier date";
    return `VPP Token: your last token (${kwh} kWh) was already entered on ${when} and cannot be used again. Buy credit to receive a new token.`;
  }
  return `VPP Token: your last token (${kwh} kWh) was cancelled and cannot be used. Contact your VPP agent.`;
}

/** TOKEN RESEND: re-send the last vended code. Never vends a new one. */
async function buildTokenResendReply(userId: number): Promise<string> {
  const vend = await latestPrepaidVend(userId);
  if (!vend) {
    return "VPP Token: there is no token on your prepaid account to resend. Buy credit via M-Pesa/Airtel/Tigo to receive one.";
  }
  return describeVend(vend);
}

/**
 * CREDIT: prepaid energy credit.
 *
 * Remaining credit is only stated where a meter measures it. On an account with
 * no meter integration the reply says the platform cannot see what is left,
 * rather than quoting the credited total as if it were the remaining balance.
 */
async function buildPrepaidCreditReply(userId: number): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const accounts = await db
    .select()
    .from(prepaidAccounts)
    .where(eq(prepaidAccounts.userId, userId))
    .orderBy(desc(prepaidAccounts.id))
    .limit(3);

  if (accounts.length === 0) {
    return "VPP Credit: no prepaid meter is registered to your account. Contact your VPP agent to enrol your meter.";
  }

  const parts = accounts.map((account) => {
    const balance = prepaidBalance({
      creditedWh: account.creditedWh,
      consumedWh: account.consumedWh,
      meterIntegrated: account.meterAssetId !== null,
    });
    const credited = (balance.creditedWh / 1000).toFixed(2);
    if (balance.remainingWh === null) {
      return `${account.meterSerial}: ${credited} kWh bought; remaining unknown (no meter reading reaching the platform)`;
    }
    return `${account.meterSerial}: ${(balance.remainingWh / 1000).toFixed(2)} kWh left of ${credited} kWh bought`;
  });

  return `VPP Credit: ${parts.join("; ")}.`;
}

/** OUTAGE: persist a real outage alert row for operations follow-up. */
async function buildOutageReply(userId: number | null, phone: string, rawText: string): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  if (userId == null) {
    // Cannot attribute an outage to an account; fail loud in the reply.
    return "VPP Outage: we could not match your phone number to an account, so no outage ticket was created. Please contact your VPP agent directly.";
  }

  const description = rawText.trim().replace(/^outage\s*/i, "").trim();
  await db.insert(alerts).values({
    userId,
    alertType: "system",
    severity: "error",
    title: "Outage reported via SMS",
    message: `Outage reported by SMS from ${phone}.${description ? ` Details: ${description}` : ""}`,
    metadata: JSON.stringify({ source: "sms_command", phoneNumber: phone, rawText }),
  });

  return "VPP Outage: thank you - your outage report has been logged and our operations team has been alerted. Reply STATUS for updates on your system.";
}

function buildHelpReply(): string {
  return [
    "VPP Commands:",
    "BALANCE - wallet balance",
    "STATUS - your system status",
    "TOKEN LAST - your last prepaid token",
    "TOKEN RESEND - resend that token",
    "CREDIT - prepaid energy left",
    "OUTAGE - report a power outage",
    "HELP - this message",
  ].join(" ");
}

/**
 * Process one inbound SMS end-to-end: resolve user, run command, persist the
 * log row, and send the reply via Africa's Talking. Returns the full result;
 * reply delivery failures are surfaced in the result AND persisted, never
 * silently swallowed.
 */
export async function processInboundSms(params: {
  from: string;
  text: string;
  providerMessageId?: string;
}): Promise<SmsProcessResult> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const { from, text } = params;
  if (!from || typeof text !== "string") {
    throw new Error("Inbound SMS requires 'from' and 'text'");
  }

  const command = parseCommand(text);
  const { userId, resolvedVia } = await resolveUserByPhone(from);

  let reply: string;
  switch (command) {
    case "BALANCE":
      reply = userId != null
        ? await buildBalanceReply(userId)
        : "VPP: phone number not linked to an account. Please register via the VPP app or your agent.";
      break;
    case "STATUS":
      reply = userId != null
        ? await buildStatusReply(userId)
        : "VPP: phone number not linked to an account. Please register via the VPP app or your agent.";
      break;
    case "TOKEN_LAST":
      reply = userId != null
        ? await buildTokenLastReply(userId)
        : "VPP: phone number not linked to an account. Please register via the VPP app or your agent.";
      break;
    case "TOKEN_RESEND":
      reply = userId != null
        ? await buildTokenResendReply(userId)
        : "VPP: phone number not linked to an account. Please register via the VPP app or your agent.";
      break;
    case "PREPAID_CREDIT":
      reply = userId != null
        ? await buildPrepaidCreditReply(userId)
        : "VPP: phone number not linked to an account. Please register via the VPP app or your agent.";
      break;
    case "OUTAGE":
      reply = await buildOutageReply(userId, from, text);
      break;
    case "HELP":
      reply = buildHelpReply();
      break;
    default:
      reply = `VPP: unknown command "${text.trim().slice(0, 30)}". ${buildHelpReply()}`;
  }

  const logValues: InsertSmsCommandLog = {
    userId,
    phoneNumber: from,
    resolvedVia,
    rawText: text,
    parsedCommand: command,
    replyText: reply,
    providerMessageId: params.providerMessageId ?? null,
  };

  const insertResult = await db.insert(smsCommandLog).values(logValues).returning({ id: smsCommandLog.id });
  const logId = Number(insertResult[0].id);

  // Real Africa's Talking reply send (delegates to the shared notifications helper).
  let replySent = false;
  let replyError: string | null = null;
  try {
    replySent = await sendSMS({ to: from, message: reply });
    if (!replySent) {
      replyError = "Africa's Talking send returned failure (see server logs)";
    }
  } catch (err: any) {
    replyError = err?.message || String(err);
  }

  if (!replySent) {
    console.error(`[SmsCommands] Reply NOT delivered to ${from} (log ${logId}): ${replyError}`);
    await db
      .update(smsCommandLog)
      .set({ replySent: false, replyError })
      .where(eq(smsCommandLog.id, logId));
  } else {
    await db
      .update(smsCommandLog)
      .set({ replySent: true })
      .where(eq(smsCommandLog.id, logId));
  }

  return { logId, userId, resolvedVia, command, reply, replySent, replyError };
}

/** User-facing: fetch the caller's own SMS command log. */
export async function getUserSmsLog(userId: number, limit: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(smsCommandLog)
    .where(eq(smsCommandLog.userId, userId))
    .orderBy(desc(smsCommandLog.createdAt))
    .limit(limit);
}

/** Admin: list SMS commands with optional filters. */
export async function listSmsCommands(filters: {
  limit: number;
  parsedCommand?: SmsCommand;
  phoneNumber?: string;
  resolvedVia?: "users_phone" | "payments_phone" | "unresolved";
}) {
  const db = await getDb();
  if (!db) return [];

  const conditions = [];
  if (filters.parsedCommand) conditions.push(eq(smsCommandLog.parsedCommand, filters.parsedCommand));
  if (filters.phoneNumber) conditions.push(eq(smsCommandLog.phoneNumber, filters.phoneNumber));
  if (filters.resolvedVia) conditions.push(eq(smsCommandLog.resolvedVia, filters.resolvedVia));

  return db
    .select()
    .from(smsCommandLog)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(smsCommandLog.createdAt))
    .limit(filters.limit);
}
