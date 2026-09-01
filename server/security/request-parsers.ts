import express from "express";
import type { RequestHandler } from "express";

/**
 * Request body parsers with explicit, tight size limits.
 *
 * The default express.json limit is 100kb; uploads in this platform go
 * through S3 presigned URLs (see server/storage.ts), so no route needs a
 * large JSON body and 1mb is a deliberate ceiling, not an accident of
 * defaults. Oversized payloads are rejected with 413 before the body is read.
 *
 * The `verify` hook captures the raw body bytes on `req.rawBody` — payment
 * and grid-protocol webhook signature verification (server/webhooks/*) needs
 * the exact bytes that were signed, which are lost once JSON is parsed.
 */

export const JSON_BODY_LIMIT = "1mb";

export type RequestWithRawBody = express.Request & { rawBody?: Buffer };

export function jsonBodyParser(): RequestHandler {
  return express.json({
    limit: JSON_BODY_LIMIT,
    verify: (req, _res, buf) => {
      (req as RequestWithRawBody).rawBody = buf;
    },
  });
}

export function urlencodedBodyParser(): RequestHandler {
  return express.urlencoded({ limit: JSON_BODY_LIMIT, extended: true });
}
