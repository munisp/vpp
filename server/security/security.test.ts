import { PassThrough } from "stream";
import type { NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiContentSecurityPolicy,
  buildSpaCspDirectives,
  spaSecurityHeaders,
  strictTransportSecurityHttpsOnly,
} from "./headers";
import { corsMiddleware, resolveAllowedOrigins, DEFAULT_DEV_ORIGINS } from "./cors";
import {
  authRateLimiter,
  createRateLimiter,
  envRpm,
  InMemorySlidingWindowStore,
} from "./rate-limit";
import { jsonBodyParser } from "./request-parsers";

/**
 * Security middleware tests. No HTTP server and no supertest: every
 * middleware is invoked directly with mock req/res objects, and the body
 * parser is exercised with a real readable stream so its size-limit path
 * runs for real.
 */

type MockRes = Response & {
  statusCode: number;
  body: unknown;
  headerMap: Map<string, string>;
};

function mockReq(overrides: Record<string, unknown> = {}): Request {
  return {
    headers: {},
    method: "GET",
    ip: "203.0.113.10",
    secure: false,
    socket: { remoteAddress: "203.0.113.10" },
    ...overrides,
  } as unknown as Request;
}

function mockRes(): MockRes {
  const headerMap = new Map<string, string>();
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headerMap,
    setHeader: vi.fn((key: string, value: string | number) => {
      headerMap.set(key.toLowerCase(), String(value));
      return res;
    }),
    getHeader: (key: string) => headerMap.get(key.toLowerCase()),
    removeHeader: vi.fn((key: string) => {
      headerMap.delete(key.toLowerCase());
    }),
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      res.body = body;
      return res;
    }),
    end: vi.fn(() => res),
  };
  return res as unknown as MockRes;
}

const nextSpy = () => vi.fn() as unknown as NextFunction & ReturnType<typeof vi.fn>;

const prodEnv = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
const devEnv = { NODE_ENV: "development" } as NodeJS.ProcessEnv;

describe("security headers", () => {
  it("sets nosniff, DENY frameguard and the referrer policy", () => {
    const res = mockRes();
    const next = nextSpy();
    spaSecurityHeaders(prodEnv)(mockReq(), res, next);
    expect(res.headerMap.get("x-content-type-options")).toBe("nosniff");
    expect(res.headerMap.get("x-frame-options")).toBe("DENY");
    expect(res.headerMap.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(next).toHaveBeenCalled();
  });

  it("removes X-Powered-By", () => {
    const res = mockRes();
    res.headerMap.set("x-powered-by", "Express");
    spaSecurityHeaders(prodEnv)(mockReq(), res, nextSpy());
    expect(res.headerMap.has("x-powered-by")).toBe(false);
  });

  it("enforces a CSP in production that allows the hashed inline SW script", () => {
    const res = mockRes();
    spaSecurityHeaders(prodEnv)(mockReq(), res, nextSpy());
    const csp = res.headerMap.get("content-security-policy");
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // The inline service-worker registration script in client/index.html.
    expect(csp).toContain("sha256-Atv8jWEPgP5lAyuGd5KaNF5AKK6Om4OJ1yL9uy9IHiQ=");
    // No wildcard script sources, no unsafe-inline for scripts.
    const scriptSrc = csp!.split(";").find(d => d.trim().startsWith("script-src"))!;
    expect(scriptSrc).not.toContain("*");
    expect(scriptSrc).not.toContain("unsafe-inline");
  });

  it("does not emit a CSP in development (Vite injects inline scripts)", () => {
    const res = mockRes();
    spaSecurityHeaders(devEnv)(mockReq(), res, nextSpy());
    expect(res.headerMap.has("content-security-policy")).toBe(false);
    // Non-CSP helmet headers still apply in development.
    expect(res.headerMap.get("x-content-type-options")).toBe("nosniff");
  });

  it("includes the analytics origin in script-src when configured", () => {
    const directives = buildSpaCspDirectives({
      NODE_ENV: "production",
      VITE_ANALYTICS_ENDPOINT: "https://analytics.example.com",
    } as NodeJS.ProcessEnv);
    expect(directives["script-src"]).toContain("https://analytics.example.com");
    expect(directives["connect-src"]).toContain("https://analytics.example.com");
  });

  it("always enforces a strict CSP on API responses", () => {
    const res = mockRes();
    const next = nextSpy();
    apiContentSecurityPolicy()(mockReq(), res, next);
    expect(res.headerMap.get("content-security-policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'"
    );
    expect(next).toHaveBeenCalled();
  });

  it("emits HSTS only when the request arrived over HTTPS", () => {
    const hsts = strictTransportSecurityHttpsOnly();

    const plain = mockRes();
    hsts(mockReq(), plain, nextSpy());
    expect(plain.headerMap.has("strict-transport-security")).toBe(false);

    const forwarded = mockRes();
    hsts(
      mockReq({ headers: { "x-forwarded-proto": "https" } }),
      forwarded,
      nextSpy()
    );
    expect(forwarded.headerMap.get("strict-transport-security")).toContain("max-age=");
    expect(forwarded.headerMap.get("strict-transport-security")).toContain("includeSubDomains");

    const secureReq = mockRes();
    hsts(mockReq({ secure: true }), secureReq, nextSpy());
    expect(secureReq.headerMap.has("strict-transport-security")).toBe(true);
  });
});

describe("CORS allowlist", () => {
  const allowlistEnv = {
    NODE_ENV: "production",
    CORS_ALLOWED_ORIGINS: "https://app.example.com, https://admin.example.com",
  } as NodeJS.ProcessEnv;

  it("echoes an allowlisted origin with credentials", () => {
    const res = mockRes();
    const next = nextSpy();
    corsMiddleware(allowlistEnv)(
      mockReq({ headers: { origin: "https://app.example.com" } }),
      res,
      next
    );
    expect(res.headerMap.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(res.headerMap.get("access-control-allow-credentials")).toBe("true");
    expect(res.headerMap.get("vary")).toBe("Origin");
    expect(next).toHaveBeenCalled();
  });

  it("answers preflights from allowlisted origins with 204", () => {
    const res = mockRes();
    corsMiddleware(allowlistEnv)(
      mockReq({
        method: "OPTIONS",
        headers: {
          origin: "https://app.example.com",
          "access-control-request-headers": "content-type,authorization",
        },
      }),
      res,
      nextSpy()
    );
    expect(res.statusCode).toBe(204);
    expect(res.headerMap.get("access-control-allow-methods")).toContain("POST");
    expect(res.headerMap.get("access-control-allow-headers")).toBe("content-type,authorization");
    expect(res.end).toHaveBeenCalled();
  });

  it("denies preflights from origins outside the allowlist", () => {
    const res = mockRes();
    const next = nextSpy();
    corsMiddleware(allowlistEnv)(
      mockReq({ method: "OPTIONS", headers: { origin: "https://evil.example.com" } }),
      res,
      next
    );
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toBe("CORS_ORIGIN_NOT_ALLOWED");
    expect(res.headerMap.has("access-control-allow-origin")).toBe(false);
    expect(next).not.toHaveBeenCalled();
  });

  it("passes disallowed simple requests through with no CORS headers", () => {
    const res = mockRes();
    const next = nextSpy();
    corsMiddleware(allowlistEnv)(
      mockReq({ headers: { origin: "https://evil.example.com" } }),
      res,
      next
    );
    expect(next).toHaveBeenCalled();
    expect(res.headerMap.has("access-control-allow-origin")).toBe(false);
  });

  it("fails closed in production when no allowlist is configured", () => {
    expect(resolveAllowedOrigins(prodEnv).origins).toBeUndefined();
    const res = mockRes();
    corsMiddleware(prodEnv)(
      mockReq({ method: "OPTIONS", headers: { origin: "https://anything.example.com" } }),
      res,
      nextSpy()
    );
    expect(res.statusCode).toBe(403);
  });

  it("defaults to localhost ports in development", () => {
    expect(resolveAllowedOrigins(devEnv).origins).toEqual(DEFAULT_DEV_ORIGINS);
    const res = mockRes();
    corsMiddleware(devEnv)(
      mockReq({ headers: { origin: "http://localhost:5173" } }),
      res,
      nextSpy()
    );
    expect(res.headerMap.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });

  it("never honours a wildcard origin, even if configured", () => {
    const env = {
      NODE_ENV: "production",
      CORS_ALLOWED_ORIGINS: "*",
    } as NodeJS.ProcessEnv;
    expect(resolveAllowedOrigins(env).origins).toBeUndefined();
  });

  it("ignores requests with no Origin header", () => {
    const res = mockRes();
    const next = nextSpy();
    corsMiddleware(allowlistEnv)(mockReq(), res, next);
    expect(next).toHaveBeenCalled();
    expect(res.headerMap.size).toBe(0);
  });
});

describe("rate limiter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function limitedEnv(extra: Record<string, unknown> = {}) {
    const store = new InMemorySlidingWindowStore();
    const limiter = createRateLimiter({ windowMs: 60_000, limit: 2, store, ...extra });
    return { limiter, store };
  }

  function hit(limiter: ReturnType<typeof createRateLimiter>, ip = "203.0.113.10") {
    const res = mockRes();
    const next = nextSpy();
    limiter(mockReq({ ip }), res, next);
    return { res, next };
  }

  it("admits requests up to the limit, then returns 429 with Retry-After", () => {
    const { limiter } = limitedEnv();

    expect(hit(limiter).next).toHaveBeenCalled();
    expect(hit(limiter).next).toHaveBeenCalled();

    const third = hit(limiter);
    expect(third.next).not.toHaveBeenCalled();
    expect(third.res.statusCode).toBe(429);
    expect((third.res.body as { error: string }).error).toBe("RATE_LIMITED");
    const retryAfter = Number(third.res.headerMap.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it("sets RateLimit-* headers on admitted requests", () => {
    const { limiter } = limitedEnv();
    const first = hit(limiter);
    expect(first.res.headerMap.get("ratelimit-limit")).toBe("2");
    expect(first.res.headerMap.get("ratelimit-remaining")).toBe("1");
    expect(first.res.headerMap.has("ratelimit-reset")).toBe(true);
  });

  it("slides the window: requests are admitted again after it expires", () => {
    const { limiter } = limitedEnv();
    hit(limiter);
    hit(limiter);
    expect(hit(limiter).res.statusCode).toBe(429);

    vi.advanceTimersByTime(61_000);
    expect(hit(limiter).next).toHaveBeenCalled();
  });

  it("counts keys independently", () => {
    const { limiter } = limitedEnv();
    hit(limiter, "203.0.113.1");
    hit(limiter, "203.0.113.1");
    expect(hit(limiter, "203.0.113.1").res.statusCode).toBe(429);
    expect(hit(limiter, "203.0.113.2").next).toHaveBeenCalled();
  });

  it("refuses with 503 when the counter store fails", () => {
    const limiter = createRateLimiter({
      windowMs: 60_000,
      limit: 2,
      store: {
        hit() {
          throw new Error("counter backend down");
        },
      },
    });
    const { res, next } = hit(limiter);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect((res.body as { error: string }).error).toBe("RATE_LIMIT_COUNTER_UNAVAILABLE");
  });

  it("auth limiter honours RATE_LIMIT_AUTH_RPM and defaults to 10/min", () => {
    const limited = authRateLimiter({ RATE_LIMIT_AUTH_RPM: "3" } as NodeJS.ProcessEnv);
    hit(limited);
    hit(limited);
    hit(limited);
    expect(hit(limited).res.statusCode).toBe(429);

    const defaulted = authRateLimiter({} as NodeJS.ProcessEnv);
    for (let i = 0; i < 10; i++) hit(defaulted);
    expect(hit(defaulted).res.statusCode).toBe(429);
  });

  it("parses RPM env vars with a loud fallback on garbage", () => {
    expect(envRpm("X_RPM", 7, { X_RPM: "42" } as NodeJS.ProcessEnv)).toBe(42);
    expect(envRpm("X_RPM", 7, {} as NodeJS.ProcessEnv)).toBe(7);
    expect(envRpm("X_RPM", 7, { X_RPM: "banana" } as NodeJS.ProcessEnv)).toBe(7);
    expect(envRpm("X_RPM", 7, { X_RPM: "0" } as NodeJS.ProcessEnv)).toBe(7);
  });

  it("throws at construction on a non-positive limit instead of failing open", () => {
    expect(() => createRateLimiter({ windowMs: 60_000, limit: 0 })).toThrow();
  });
});

describe("request body limits", () => {
  function streamRequest(body: string, contentLength?: number): Request {
    const stream = new PassThrough();
    const req = stream as unknown as Request & { headers: Record<string, string> };
    req.headers = {
      "content-type": "application/json",
      "content-length": String(contentLength ?? Buffer.byteLength(body)),
    };
    if (contentLength === undefined || contentLength <= Buffer.byteLength(body)) {
      stream.end(body);
    }
    return req as unknown as Request;
  }

  it("rejects payloads over the 1mb limit with 413", async () => {
    const res = mockRes();
    const next = nextSpy();
    // Declaring a length above the limit makes the parser refuse before
    // reading, which is exactly the resource-exhaustion guard being tested.
    jsonBodyParser()(streamRequest("{}", 2 * 1024 * 1024), res, next);
    await vi.waitFor(() => {
      expect(next).toHaveBeenCalled();
    });
    const err = (next as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      status: number;
      type: string;
    };
    expect(err).toBeTruthy();
    expect(err.status).toBe(413);
    expect(err.type).toBe("entity.too.large");
  });

  it("parses in-limit JSON and captures the raw body for signature checks", async () => {
    const res = mockRes();
    const next = nextSpy();
    const body = JSON.stringify({ amount: 42, currency: "KES" });
    const req = streamRequest(body) as Request & { rawBody?: Buffer; body?: unknown };
    jsonBodyParser()(req, res, next);
    await vi.waitFor(() => {
      expect(next).toHaveBeenCalled();
    });
    expect((next as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBeUndefined();
    expect(req.body).toEqual({ amount: 42, currency: "KES" });
    expect(req.rawBody?.toString()).toBe(body);
  });
});
