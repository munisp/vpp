import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Lightweight sliding-window rate limiter.
 *
 * MULTI-INSTANCE CAVEAT: the default `InMemorySlidingWindowStore` keeps its
 * counters in this process. A deployment running N replicas behind a load
 * balancer therefore enforces N times the configured limit. That is acceptable
 * for the low-volume endpoints this module protects by default (the OAuth
 * login/callback surface), but any high-volume or money-path ceiling must use
 * a shared store: the `RateLimitStore` interface below is the plug point, and
 * server/services/rate-limit-store.ts already provides the Redis-backed,
 * replica-safe counters used by the global API and payment limiters mounted in
 * server/_core/index.ts. Do not "fix" multi-instance drift by silently raising
 * limits — back the store with Redis instead.
 *
 * Behaviour:
 *  - 429 with a JSON body and a `Retry-After` header (seconds until the
 *    oldest in-window hit expires).
 *  - `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` standard
 *    headers on every response.
 *  - Keyed by client IP (Express `req.ip`, which honours `trust proxy`).
 */

/** Plug point for shared/replicated counters (e.g. a Redis-backed store). */
export interface RateLimitStore {
  /**
   * Record one hit for `key` and return the number of hits inside the current
   * window plus how long until the window's oldest hit expires.
   */
  hit(key: string, windowMs: number): { totalHits: number; resetAfterMs: number };
}

/**
 * Default store: per-key timestamp log, pruned to the window on each hit.
 * A periodic sweep drops idle keys so the map cannot grow without bound.
 */
export class InMemorySlidingWindowStore implements RateLimitStore {
  private readonly hits = new Map<string, number[]>();
  private readonly sweeper: NodeJS.Timeout;

  /** Hard cap on retained timestamps per key; oldest are dropped beyond it. */
  private readonly maxEntriesPerKey: number;

  constructor(options: { sweepIntervalMs?: number; maxEntriesPerKey?: number } = {}) {
    this.maxEntriesPerKey = options.maxEntriesPerKey ?? 10_000;
    const sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
    this.sweeper = setInterval(() => this.sweep(), sweepIntervalMs);
    // Never keep a process alive just to sweep rate-limit state.
    this.sweeper.unref?.();
  }

  hit(key: string, windowMs: number): { totalHits: number; resetAfterMs: number } {
    const now = Date.now();
    const cutoff = now - windowMs;
    let timestamps = (this.hits.get(key) ?? []).filter(t => t > cutoff);
    timestamps.push(now);
    if (timestamps.length > this.maxEntriesPerKey) {
      timestamps = timestamps.slice(timestamps.length - this.maxEntriesPerKey);
    }
    this.hits.set(key, timestamps);
    return {
      totalHits: timestamps.length,
      resetAfterMs: timestamps[0] + windowMs - now,
    };
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, timestamps] of this.hits) {
      if (timestamps.length === 0 || timestamps[timestamps.length - 1] <= now - 3_600_000) {
        this.hits.delete(key);
      }
    }
  }

  /** Test/maintenance hook: stop the sweeper interval. */
  dispose(): void {
    clearInterval(this.sweeper);
  }
}

export interface RateLimiterOptions {
  windowMs: number;
  limit: number;
  store?: RateLimitStore;
  message?: string;
  keyGenerator?: (req: Request) => string;
}

const DEFAULT_MESSAGE = "Too many requests, please try again later.";

/**
 * Build the limiting middleware. When the store throws, the request is
 * refused with 503: a limit that cannot be counted is not a limit, and
 * silently admitting unmetered traffic is the failure mode this exists to
 * prevent.
 */
export function createRateLimiter(options: RateLimiterOptions): RequestHandler {
  const {
    windowMs,
    limit,
    message = DEFAULT_MESSAGE,
    keyGenerator = req => req.ip ?? req.socket.remoteAddress ?? "unknown",
  } = options;
  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error(`[RateLimit] limit must be a positive integer, got ${limit}`);
  }
  const store = options.store ?? new InMemorySlidingWindowStore();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyGenerator(req);
    let result: { totalHits: number; resetAfterMs: number };
    try {
      result = store.hit(key, windowMs);
    } catch (error) {
      console.error(
        `[RateLimit] counter store failed; refusing request instead of admitting it unmetered:`,
        error
      );
      res.setHeader("Retry-After", Math.ceil(windowMs / 1000));
      return res.status(503).json({
        error: "RATE_LIMIT_COUNTER_UNAVAILABLE",
        message: "This request cannot be rate limited right now, so it was refused. Please retry shortly.",
      });
    }

    const remaining = Math.max(0, limit - result.totalHits);
    res.setHeader("RateLimit-Limit", String(limit));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(Math.ceil(result.resetAfterMs / 1000)));

    if (result.totalHits > limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil(result.resetAfterMs / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({ error: "RATE_LIMITED", message });
    }
    return next();
  };
}

/** Parse a positive-integer env var, falling back when unset/invalid. */
export function envRpm(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    console.warn(`[RateLimit] ${name}="${raw}" is not a positive integer; using ${fallback}`);
    return fallback;
  }
  return parsed;
}

/**
 * Global API ceiling in requests per minute. index.ts applies it through the
 * replica-safe Redis store with a 15-minute window, so the per-minute figure
 * is scaled there (default 20 rpm == the historical 300 per 15 minutes).
 */
export const GLOBAL_LIMIT_RPM_ENV = "RATE_LIMIT_GLOBAL_RPM";
/** Auth/login ceiling (per minute), applied by this module's limiter. */
export const AUTH_LIMIT_RPM_ENV = "RATE_LIMIT_AUTH_RPM";
/** Payment initiation/webhook ceiling (per minute), scaled like the global one. */
export const PAYMENT_LIMIT_RPM_ENV = "RATE_LIMIT_PAYMENT_RPM";

/**
 * Rate limiter for the authentication surface (/api/oauth/callback and any
 * future login endpoints). Deliberately low-volume: a human signing in makes
 * a handful of requests; anything beyond this is a script.
 */
export function authRateLimiter(env: NodeJS.ProcessEnv = process.env): RequestHandler {
  return createRateLimiter({
    windowMs: 60_000,
    limit: envRpm(AUTH_LIMIT_RPM_ENV, 10, env),
    message: "Too many authentication attempts, please try again later.",
  });
}

/**
 * Standalone limiter factory for ad-hoc routes that are not covered by the
 * Redis-backed limiters in index.ts. Prefer the shared-store limiters for
 * anything high-volume or money-adjacent (see module docstring).
 */
export function localApiRateLimiter(
  envName: string,
  fallbackRpm: number,
  env: NodeJS.ProcessEnv = process.env
): RequestHandler {
  return createRateLimiter({ windowMs: 60_000, limit: envRpm(envName, fallbackRpm, env) });
}
