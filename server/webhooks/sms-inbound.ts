/**
 * Africa's Talking Inbound SMS Webhook (feature 11)
 *
 * Ready-to-mount express router. The lead wires it into server/_core/index.ts,
 * e.g.: app.use('/api/webhooks/sms/inbound', smsInboundRouter)
 *
 * Africa's Talking POSTs application/x-www-form-urlencoded with fields:
 *   from, to, text, date, id, linkId
 * (express.urlencoded is already enabled globally in server/_core/index.ts.)
 *
 * Handler style follows server/webhooks/payment-callbacks.ts: always answer
 * 200 to the provider, process the command, persist the log row, and reply
 * via a real Africa's Talking send.
 */

import { Router, type Request, type Response } from "express";
import { processInboundSms } from "../services/sms-commands";

export const smsInboundRouter = Router();

smsInboundRouter.post("/", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const from = typeof body.from === "string" ? body.from : "";
  const text = typeof body.text === "string" ? body.text : "";
  const providerMessageId = typeof body.id === "string" ? body.id : undefined;

  if (!from || !text) {
    console.warn("[SmsInbound] Rejected payload missing from/text:", {
      hasFrom: Boolean(from),
      hasText: Boolean(text),
    });
    // Still 200: returning an error code would make Africa's Talking retry
    // an unprocessable payload forever.
    res.status(200).json({ status: "rejected", reason: "missing from/text" });
    return;
  }

  try {
    const result = await processInboundSms({ from, text, providerMessageId });
    console.log(
      `[SmsInbound] ${result.command} from ${from} -> user ${result.userId ?? "unresolved"} (${result.resolvedVia}), replySent=${result.replySent}`
    );
    res.status(200).json({
      status: "ok",
      command: result.command,
      replySent: result.replySent,
    });
  } catch (error: any) {
    console.error("[SmsInbound] Failed to process inbound SMS:", error);
    // 200 so the provider does not storm us with retries; the failure is
    // logged loudly above for operational follow-up.
    res.status(200).json({ status: "error", message: error?.message || "processing failed" });
  }
});
