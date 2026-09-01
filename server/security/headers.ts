import helmet from "helmet";
import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * HTTP security headers.
 *
 * Layered deliberately:
 *  - `spaSecurityHeaders()` is helmet with an enforced Content-Security-Policy
 *    tuned for the production SPA bundle (hashed inline service-worker
 *    registration script, Google Fonts, optional Umami analytics origin).
 *    In development the CSP is left off because the Vite dev server injects
 *    inline scripts and uses `eval`-style transforms that a strict CSP breaks;
 *    every other helmet header still applies.
 *  - `apiContentSecurityPolicy()` enforces a maximally strict CSP on /api
 *    responses in every environment: API responses are JSON and must never be
 *    rendered as documents, so `default-src 'none'` cannot break a client but
 *    does neuter content-sniffing / XSS-via-reflected-response attacks.
 *  - `strictTransportSecurityHttpsOnly()` emits HSTS only when the request
 *    actually arrived over HTTPS (honouring X-Forwarded-Proto from the
 *    terminating proxy, which index.ts trusts with `trust proxy = 1`). Local
 *    development over plain http:// therefore never receives an HSTS header
 *    that would pin the browser to a TLS endpoint that does not exist.
 *
 * `x-powered-by` is removed twice on purpose: helmet strips it here and
 * index.ts also calls `app.disable("x-powered-by")` so the header stays off
 * even if this middleware chain is ever reordered.
 */

/**
 * SHA-256 (base64) of the inline service-worker registration <script> in
 * client/index.html. A strict script-src would otherwise block it, which is
 * why the previous configuration disabled CSP entirely. If that inline script
 * changes, this hash must be recomputed:
 *   sha256 of the exact bytes between <script> and </script>.
 */
const INLINE_SERVICE_WORKER_SCRIPT_HASH =
  "'sha256-Atv8jWEPgP5lAyuGd5KaNF5AKK6Om4OJ1yL9uy9IHiQ='";

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Build the enforced SPA Content-Security-Policy directives. Exported for
 * tests. `env` is injectable so tests do not have to mutate process.env.
 */
export function buildSpaCspDirectives(
  env: NodeJS.ProcessEnv = process.env
): Record<string, string[]> {
  // Umami analytics script is loaded from VITE_ANALYTICS_ENDPOINT at build
  // time (client/index.html). Allow that origin when configured; when the env
  // var is absent the analytics script tag renders with a literal placeholder
  // URL and fails to load on its own — the CSP does not need to (and must not)
  // widen for it.
  const analyticsOrigin = originOf(env.VITE_ANALYTICS_ENDPOINT);
  const scriptSrc = ["'self'", INLINE_SERVICE_WORKER_SCRIPT_HASH];
  if (analyticsOrigin) scriptSrc.push(analyticsOrigin);

  const connectSrc = ["'self'"];
  if (analyticsOrigin) connectSrc.push(analyticsOrigin);

  return {
    "default-src": ["'self'"],
    "script-src": scriptSrc,
    // React/style-injection libraries emit inline styles; Google Fonts CSS is
    // linked from index.html.
    "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    "font-src": ["'self'", "https://fonts.gstatic.com"],
    // User-uploaded images come back from S3/CDN over https; the PWA uses
    // data:/blob: for generated QR codes and canvas exports.
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "connect-src": connectSrc,
    "worker-src": ["'self'"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "frame-ancestors": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
  };
}

/**
 * Helmet with the repo's header posture. CSP is enforced in production and
 * intentionally disabled in development (Vite dev server injects inline
 * scripts/eval). HSTS is disabled here and handled by
 * `strictTransportSecurityHttpsOnly` so it is only emitted over TLS.
 */
export function spaSecurityHeaders(
  env: NodeJS.ProcessEnv = process.env
): RequestHandler {
  const isProduction = env.NODE_ENV === "production";
  return helmet({
    contentSecurityPolicy: isProduction
      ? { useDefaults: false, directives: buildSpaCspDirectives(env) }
      : false,
    xFrameOptions: { action: "deny" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    hsts: false,
  });
}

/**
 * Enforce a strict CSP on API responses. These are JSON payloads; no script,
 * style, or framing capability is ever legitimate here. Applied in every
 * environment — unlike the SPA policy there are no dev-tooling assets under
 * /api that this could break.
 */
export function apiContentSecurityPolicy(): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'"
    );
    next();
  };
}

/**
 * Emit HSTS only for requests that arrived over HTTPS. With
 * `app.set("trust proxy", 1)` (index.ts) `req.secure` already honours
 * X-Forwarded-Proto; the header is also checked directly so the middleware is
 * correct even when mounted without proxy trust. Plain-HTTP requests (local
 * dev, health checks behind an internal LB) get no header.
 */
export function strictTransportSecurityHttpsOnly(
  maxAgeSeconds = 31_536_000
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const forwardedProto = req.headers["x-forwarded-proto"];
    const isHttps =
      req.secure ||
      (typeof forwardedProto === "string" &&
        forwardedProto.split(",")[0].trim().toLowerCase() === "https");
    if (isHttps) {
      res.setHeader(
        "Strict-Transport-Security",
        `max-age=${maxAgeSeconds}; includeSubDomains`
      );
    }
    next();
  };
}
