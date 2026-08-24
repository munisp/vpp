import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { initializeWebSocket } from "./websocket";
import { initScheduledReports } from "./scheduler";
import { startStatusUpdateJob } from "./qrStatusUpdater";
import { initScheduledReportJobs } from "./scheduledReports";
import { handleMpesaCallback, handleAirtelCallback, handleTigoCallback } from "../webhooks/payment-callbacks";
import { verifyWebhookSignature } from "../webhooks/verify-signature";
import { smsInboundRouter } from "../webhooks/sms-inbound";
import { gridProtocolRouter } from "../webhooks/grid-protocols";
import { webSocketService } from "../integration/websocket-service";
import { startControlFallbackSweeper } from "../services/control-delivery";
import { seedStrategyTemplates } from "../db-strategy-templates";
import { startFleetTelemetryRollup } from "../services/fleet-telemetry";
import { brokerConfigured, startOutboxRelay } from "../services/events/outbox";
import { consumerConfigured, startEventConsumer } from "../services/events/consumer";
import {
  assertSharedCountersAvailable,
  createRateLimitStore,
  SharedCounterUnavailableError,
} from "../services/rate-limit-store";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);

  // Behind nginx (see DEPLOYMENT.md): trust the first proxy hop so that
  // req.ip, rate limiting and secure-cookie detection work correctly.
  app.set("trust proxy", 1);

  // A limit kept in each replica's memory is multiplied by the replica count,
  // so production refuses to start without somewhere to keep shared counters.
  assertSharedCountersAvailable();

  // Security headers via helmet defaults (X-Content-Type-Options,
  // X-Frame-Options, Referrer-Policy, HSTS in prod, etc.). CSP is disabled
  // here on purpose: client/index.html ships an inline service-worker
  // registration script that a strict script-src would block, and the Vite
  // dev server also injects inline scripts. Enforce a CSP at the nginx layer
  // once the inline script is externalized.
  app.use(helmet({ contentSecurityPolicy: false }));

  // Global rate limit: 300 requests per 15 minutes per IP.
  // /api/grid is excluded and limited separately: it carries machine traffic
  // (charge point heartbeats, meter values, Modbus polls) from a small number
  // of protocol services, and every request is HMAC-authenticated.
  // Counters are shared across replicas via Redis. If Redis goes away the
  // general API keeps counting per replica rather than refusing everything,
  // and says so in the log; the payment limiter below makes the opposite trade.
  const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "RATE_LIMITED", message: "Too many requests, please try again later." },
    store: createRateLimitStore({
      limiter: "api",
      windowMs: 15 * 60 * 1000,
      onRedisFailure: "count_locally",
    }),
  });
  app.use("/api", (req, res, next) =>
    req.path.startsWith("/grid/") ? next() : globalLimiter(req, res, next)
  );

  const gridLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 6000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "RATE_LIMITED", message: "Too many grid protocol requests." },
    store: createRateLimitStore({
      limiter: "grid",
      windowMs: 60 * 1000,
      onRedisFailure: "count_locally",
    }),
  });
  app.use("/api/grid", gridLimiter);

  // Stricter limit for payment webhooks and payment tRPC procedures:
  // 30 requests per 15 minutes per IP. For webhooks it is chained after
  // signature verification so the verify-first order is preserved.
  // Money paths fail closed: if the shared counter cannot be read, the request
  // is refused rather than admitted unmetered.
  const paymentLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "RATE_LIMITED", message: "Too many requests, please try again later." },
    store: createRateLimitStore({
      limiter: "payments",
      windowMs: 15 * 60 * 1000,
      onRedisFailure: "refuse",
    }),
  });
  app.use("/api/trpc/payments", paymentLimiter);

  // Body parsers. Default limit reduced to 1mb: file/image uploads in this
  // platform go through S3 presigned URLs (see server/storage.ts), so no
  // route needs a large JSON body. The `verify` hook captures the raw body
  // bytes used by payment webhook signature verification.
  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    })
  );
  app.use(express.urlencoded({ limit: "1mb", extended: true }));
  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);

  // Health and readiness endpoints for Kubernetes
  app.get("/health", (req, res) => {
    res.status(200).json({ status: "healthy", timestamp: new Date().toISOString() });
  });

  app.get("/ready", async (req, res) => {
    try {
      // Check database connectivity
      const { getDb } = await import("../db");
      const db = await getDb();
      if (!db) {
        return res.status(503).json({ status: "not_ready", reason: "database_unavailable" });
      }
      res.status(200).json({ status: "ready", timestamp: new Date().toISOString() });
    } catch (error) {
      res.status(503).json({ status: "not_ready", reason: "database_error" });
    }
  });

  // Payment gateway webhooks. Order matters: signature verification runs
  // first, then the strict rate limiter, then the callback handler.
  app.post("/api/webhooks/mpesa", verifyWebhookSignature("mpesa"), paymentLimiter, handleMpesaCallback);
  app.post("/api/webhooks/airtel", verifyWebhookSignature("airtel"), paymentLimiter, handleAirtelCallback);
  app.post("/api/webhooks/tigo", verifyWebhookSignature("tigo"), paymentLimiter, handleTigoCallback);
  // Africa's Talking inbound SMS (feature-phone command channel). The AT
  // callback is authenticated by the shared AT webhook secret when configured.
  app.use("/api/webhooks/sms/inbound", verifyWebhookSignature("africas_talking"), smsInboundRouter);
  // Grid protocol ingest (OCPP 1.6J, OpenADR 2.0b, IEEE 2030.5, Modbus).
  // Each route verifies its own HMAC signature over the raw body captured by
  // the JSON body parser above.
  app.use("/api/grid", gridProtocolRouter);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // An unreadable shared counter on a money path is reported as the platform
  // being unable to meter the request, not as a client error and not as success.
  // Registered after the routes so it sees the errors their limiters raise.
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (error instanceof SharedCounterUnavailableError) {
        console.error(`[RateLimit] ${error.message}`);
        return res.status(503).json({
          error: error.code,
          message:
            "This request cannot be rate limited right now, so it was refused. Please retry shortly.",
        });
      }
      return next(error);
    }
  );

  // Initialize WebSocket server (single initialization to avoid duplicate handleUpgrade)
  initializeWebSocket(server);

  // Initialize scheduled reports
  initScheduledReports();
  
  // Initialize QR transaction status updater
  startStatusUpdateJob();
  
  // Initialize scheduled report jobs
  initScheduledReportJobs();

  // The strategy template library is static product content, not deployment
  // state, so it ships with the app: without this a fresh deployment shows an
  // empty Strategy Templates page and nothing to clone, and the library only
  // appeared if somebody remembered to run a script by hand. The seed skips
  // itself once any template exists, so it never overwrites edited content.
  seedStrategyTemplates().catch(error => {
    console.error("[StrategyTemplates] seeding the template library failed:", error);
  });

  // Expire control windows and deliver their fallbacks. Opt-in via
  // GRID_CONTROL_SWEEP_MS so a deployment running the sweep from a worker does
  // not run it twice; without it, expired setpoints only fall back when an
  // operator sweeps by hand.
  if (startControlFallbackSweeper()) {
    console.log(`[ControlFallback] sweeper started every ${process.env.GRID_CONTROL_SWEEP_MS}ms`);
  } else {
    console.warn(
      "[ControlFallback] GRID_CONTROL_SWEEP_MS is not set: expired control windows " +
        "will not fall back automatically in this process"
    );
  }

  // Roll up fleet telemetry aggregates. Opt-in via FLEET_TELEMETRY_ROLLUP_MS for
  // the same reason as the sweeper; without it the rolling series only advances
  // when an operator asks for it, and a stale series reads as a quiet fleet.
  if (startFleetTelemetryRollup()) {
    console.log(
      `[FleetTelemetry] rollup started every ${process.env.FLEET_TELEMETRY_ROLLUP_MS}ms`
    );
  } else {
    console.warn(
      "[FleetTelemetry] FLEET_TELEMETRY_ROLLUP_MS is not set: rolling fleet " +
        "aggregates will not advance automatically in this process"
    );
  }

  // Publish recorded events to Kafka. Opt-in via EVENT_OUTBOX_RELAY_MS so a
  // deployment relaying from a worker does not also relay in every API replica;
  // without it, events are recorded and never published, which is why this warns
  // rather than staying quiet — a growing outbox is the honest symptom, but only
  // if somebody is told about it.
  if (startOutboxRelay()) {
    console.log(`[EventOutbox] relay started every ${process.env.EVENT_OUTBOX_RELAY_MS}ms`);
  } else if (brokerConfigured()) {
    console.warn(
      "[EventOutbox] EVENT_OUTBOX_RELAY_MS is not set: recorded events will not be " +
        "published from this process and will accumulate as pending"
    );
  } else {
    console.warn(
      "[EventOutbox] KAFKA_BROKERS is not set: this deployment has no event stream, " +
        "so events are recorded in the outbox and never published"
    );
  }

  // Consume the topics this deployment reads back. Without EVENT_CONSUMER_TOPICS
  // the platform publishes events nothing reads, which is what the infrastructure
  // audit found; say so instead of letting the manifests imply otherwise.
  void startEventConsumer().then(
    started => {
      if (started) {
        console.log(
          `[EventConsumer] consuming ${process.env.EVENT_CONSUMER_TOPICS} as group ${
            process.env.EVENT_CONSUMER_GROUP ?? "vpp-event-inbox"
          }`
        );
      } else if (!consumerConfigured()) {
        console.warn(
          "[EventConsumer] EVENT_CONSUMER_TOPICS is empty: no published event is read " +
            "back by this platform"
        );
      }
    },
    error => console.error("[EventConsumer] failed to start:", error)
  );

  // Note: webSocketService.initialize removed - using single WebSocket server from initializeWebSocket
  
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });

  setupGracefulShutdown(server);
}

/**
 * Graceful shutdown on SIGTERM/SIGINT:
 *  1. stop accepting new connections (server.close),
 *  2. close the socket.io server (which also closes the underlying HTTP
 *     server, so close socket.io first),
 *  3. best-effort drain of the PostgreSQL pool (redis singletons register their
 *     own SIGTERM/SIGINT handlers — see server/integration/redis-cache.ts),
 *  4. exit 0; force-exit if cleanup takes longer than 10s.
 */
function setupGracefulShutdown(server: ReturnType<typeof createServer>) {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Shutdown] Received ${signal}, starting graceful shutdown...`);

    // Hard deadline: never hang longer than 10s.
    const forceExit = setTimeout(() => {
      console.error("[Shutdown] Graceful shutdown timed out after 10s, forcing exit.");
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    void (async () => {
      try {
        const { getIO } = await import("./websocket");
        getIO()?.close();
        console.log("[Shutdown] WebSocket server closed");
      } catch (error) {
        console.warn("[Shutdown] Error closing WebSocket server:", error);
      }

      try {
        const { getDb } = await import("../db");
        const db = await getDb();
        const pool = (db as unknown as { $client?: { end?: () => Promise<void> } })?.$client;
        if (pool?.end) {
          await pool.end();
          console.log("[Shutdown] Database connection pool drained");
        }
      } catch (error) {
        console.warn("[Shutdown] Error draining database pool:", error);
      }

      server.close(() => {
        clearTimeout(forceExit);
        console.log("[Shutdown] HTTP server closed, exiting.");
        process.exit(0);
      });
    })();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

startServer().catch(console.error);
