import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { ENV } from "./env";

export type NotificationPayload = { title: string; content: string };

const TITLE_MAX_LENGTH = 1200;
const CONTENT_MAX_LENGTH = 20000;

function validatePayload(input: NotificationPayload): NotificationPayload {
  if (typeof input.title !== "string" || !input.title.trim()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Notification title is required." });
  }
  if (typeof input.content !== "string" || !input.content.trim()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Notification content is required." });
  }

  const title = input.title.trim();
  const content = input.content.trim();
  if (title.length > TITLE_MAX_LENGTH) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Notification title must be at most ${TITLE_MAX_LENGTH} characters.` });
  }
  if (content.length > CONTENT_MAX_LENGTH) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Notification content must be at most ${CONTENT_MAX_LENGTH} characters.` });
  }
  return { title, content };
}

function signature(body: string): string | null {
  if (!ENV.ownerNotificationWebhookSecret) return null;
  return crypto
    .createHmac("sha256", ENV.ownerNotificationWebhookSecret)
    .update(body)
    .digest("hex");
}

/**
 * Dispatch an owner notification to a configured generic HTTPS webhook. An ntfy,
 * email, incident-management, or custom self-hosted bridge can implement the
 * receiving endpoint. Returns false only for a delivery failure so callers can
 * retain their existing fallback behavior.
 */
export async function notifyOwner(payload: NotificationPayload): Promise<boolean> {
  const validated = validatePayload(payload);
  if (!ENV.ownerNotificationWebhookUrl) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "OWNER_NOTIFICATION_WEBHOOK_URL is not configured.",
    });
  }

  const body = JSON.stringify(validated);
  const webhookSignature = signature(body);
  try {
    const response = await fetch(ENV.ownerNotificationWebhookUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(webhookSignature ? { "x-vpp-signature": `sha256=${webhookSignature}` } : {}),
      },
      body,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn(
        `[Notification] Webhook delivery failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`
      );
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[Notification] Webhook delivery error:", error);
    return false;
  }
}

export const __notificationTestables = { signature };
