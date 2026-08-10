import "dotenv/config";
import express from "express";
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
import { webSocketService } from "../integration/websocket-service";

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
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
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

  // Payment gateway webhooks
  app.post("/api/webhooks/mpesa", handleMpesaCallback);
  app.post("/api/webhooks/airtel", handleAirtelCallback);
  app.post("/api/webhooks/tigo", handleTigoCallback);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // Initialize WebSocket server (single initialization to avoid duplicate handleUpgrade)
  initializeWebSocket(server);

  // Initialize scheduled reports
  initScheduledReports();
  
  // Initialize QR transaction status updater
  startStatusUpdateJob();
  
  // Initialize scheduled report jobs
  initScheduledReportJobs();
  
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
}

startServer().catch(console.error);
