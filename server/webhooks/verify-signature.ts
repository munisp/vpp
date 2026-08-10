/**
 * Payment webhook signature verification.
 *
 * Each payment provider webhook must present an HMAC-SHA256 signature of the
 * request body in the `x-webhook-signature` header (hex encoded), keyed with
 * the provider's shared secret.
 *
 * Fail-closed behavior:
 *  - Secret configured: missing or mismatched signature -> 401.
 *  - Secret NOT configured: in production the webhook is rejected with 503
 *    (a loud misconfiguration error); in development the request is allowed
 *    through with a warning so local testing remains possible.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { NextFunction, Request, Response } from 'express';

type WebhookProvider = 'mpesa' | 'airtel' | 'tigo' | 'africas_talking';

const SECRET_ENV: Record<WebhookProvider, string> = {
  mpesa: 'MPESA_WEBHOOK_SECRET',
  airtel: 'AIRTEL_WEBHOOK_SECRET',
  tigo: 'TIGO_WEBHOOK_SECRET',
  africas_talking: 'AFRICAS_TALKING_WEBHOOK_SECRET',
};

function requestBodyBytes(req: Request): Buffer {
  // Prefer the raw body captured by a body-parser `verify` hook when present;
  // otherwise re-serialize the parsed JSON body. Providers signing these
  // webhooks sign exactly this byte representation.
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (raw && Buffer.isBuffer(raw)) return raw;
  return Buffer.from(JSON.stringify(req.body ?? {}), 'utf8');
}

export function verifyWebhookSignature(provider: WebhookProvider) {
  const envName = SECRET_ENV[provider];

  return (req: Request, res: Response, next: NextFunction) => {
    const secret = process.env[envName];

    if (!secret) {
      if (process.env.NODE_ENV === 'production') {
        console.error(
          `[Webhook:${provider}] ${envName} is not configured; refusing to accept unsigned payment webhooks in production.`
        );
        return res.status(503).json({
          error: 'WEBHOOK_NOT_CONFIGURED',
          message: `Webhook signature verification for ${provider} is not configured.`,
        });
      }
      console.warn(
        `[Webhook:${provider}] ${envName} is not set; accepting unsigned webhook in development mode.`
      );
      return next();
    }

    const signatureHeader = req.header('x-webhook-signature');
    if (!signatureHeader) {
      return res.status(401).json({
        error: 'WEBHOOK_SIGNATURE_MISSING',
        message: 'Missing x-webhook-signature header.',
      });
    }

    const expected = createHmac('sha256', secret)
      .update(requestBodyBytes(req))
      .digest('hex');

    const provided = signatureHeader.trim().toLowerCase();
    const providedBuf = Buffer.from(provided, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');

    if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
      console.warn(`[Webhook:${provider}] Rejected webhook with invalid signature.`);
      return res.status(401).json({
        error: 'WEBHOOK_SIGNATURE_INVALID',
        message: 'Invalid webhook signature.',
      });
    }

    return next();
  };
}
