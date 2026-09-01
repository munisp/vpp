import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Explicit CORS allowlist for the HTTP API.
 *
 * The Express app previously mounted no CORS middleware at all, which already
 * fails closed for browsers but leaves the intended cross-origin posture
 * implicit. This module makes it explicit and configurable:
 *
 *  - Allowed origins come from CORS_ALLOWED_ORIGINS (comma-separated).
 *    ALLOWED_ORIGINS and CORS_ORIGINS are accepted as legacy fallbacks so an
 *    existing deployment configured for the WebSocket server
 *    (server/_core/websocket.ts) keeps the same allowlist here.
 *  - "*" is never honoured, even if configured: credentialed responses must
 *    never be reflected to arbitrary origins.
 *  - Production with no allowlist configured => deny cross-origin: preflights
 *    get 403 and simple requests get no CORS headers (fail closed, not
 *    allow-all).
 *  - Development with no allowlist configured => the local dev ports
 *    (localhost/127.0.0.1 on 3000/5173/4173) so `vite dev` keeps working.
 *  - Requests with no Origin header (same-origin navigation, curl, server-to-
 *    server) pass through untouched; CORS headers are only ever emitted in
 *    response to an Origin header that is on the allowlist.
 *  - Credentials are allowed deliberately: the session cookie is the auth
 *    mechanism, so Allow-Credentials is true *only* alongside an allowlisted,
 *    echoed origin (never with a wildcard).
 *
 * `resolveAllowedOrigins` is shared with server/_core/websocket.ts so the
 * WebSocket and HTTP surfaces cannot drift into different allowlists.
 */

export const DEFAULT_DEV_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];

export interface ResolvedCors {
  /** Explicitly allowlisted origins, or undefined to deny all cross-origin. */
  origins: string[] | undefined;
  /** True when `origins` came from the development defaults, not env config. */
  fromDevDefaults: boolean;
}

/**
 * Resolve the effective allowlist. Exported for tests and for
 * server/_core/websocket.ts. `env` is injectable.
 */
export function resolveAllowedOrigins(env: NodeJS.ProcessEnv = process.env): ResolvedCors {
  const raw =
    env.CORS_ALLOWED_ORIGINS || env.ALLOWED_ORIGINS || env.CORS_ORIGINS || "";
  const origins = raw
    .split(",")
    .map(o => o.trim())
    .filter(o => o.length > 0 && o !== "*");

  if (origins.length > 0) {
    return { origins, fromDevDefaults: false };
  }

  if (env.NODE_ENV === "production") {
    console.warn(
      "[CORS] No allowlist configured (CORS_ALLOWED_ORIGINS) — " +
        "cross-origin requests are denied (same-origin only)."
    );
    return { origins: undefined, fromDevDefaults: false };
  }

  return { origins: DEFAULT_DEV_ORIGINS, fromDevDefaults: true };
}

const ALLOWED_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
const DEFAULT_ALLOWED_HEADERS =
  "Content-Type,Authorization,X-Requested-With,traceparent,tracestate";

/**
 * Express middleware enforcing the allowlist. Mounted before the rate
 * limiters and routes in index.ts.
 */
export function corsMiddleware(
  env: NodeJS.ProcessEnv = process.env
): RequestHandler {
  const { origins, fromDevDefaults } = resolveAllowedOrigins(env);
  if (fromDevDefaults) {
    console.log(
      `[CORS] No CORS_ALLOWED_ORIGINS set; development defaults apply: ${origins!.join(", ")}`
    );
  }

  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;

    // No Origin header: not a cross-origin browser request. Pass through with
    // no CORS headers.
    if (!origin) return next();

    const allowed = origins !== undefined && origins.includes(origin);
    if (!allowed) {
      // Fail closed: preflights are refused outright; simple requests proceed
      // without any CORS headers so the browser blocks the response.
      if (req.method === "OPTIONS") {
        return res.status(403).json({
          error: "CORS_ORIGIN_NOT_ALLOWED",
          message: "Cross-origin requests from this origin are not allowed.",
        });
      }
      return next();
    }

    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    // The session cookie is the credential; only ever sent to allowlisted,
    // echoed origins (never a wildcard).
    res.setHeader("Access-Control-Allow-Credentials", "true");

    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
      const requestedHeaders = req.headers["access-control-request-headers"];
      res.setHeader(
        "Access-Control-Allow-Headers",
        typeof requestedHeaders === "string" && requestedHeaders.length > 0
          ? requestedHeaders
          : DEFAULT_ALLOWED_HEADERS
      );
      res.setHeader("Access-Control-Max-Age", "600");
      return res.status(204).end();
    }

    return next();
  };
}
