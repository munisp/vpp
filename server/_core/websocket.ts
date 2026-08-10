import { Server as HTTPServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { parse as parseCookieHeader } from 'cookie';
import * as db from '../db';
import { users } from '../../drizzle/schema';
import { sdk } from './sdk';
import { COOKIE_NAME } from '@shared/const';

let io: SocketIOServer | null = null;

/**
 * Allowed cross-origin clients for the WebSocket server.
 * Configured via ALLOWED_ORIGINS (comma-separated). When unset, no CORS
 * headers are emitted, which restricts connections to same-origin clients.
 * Origin '*' is never allowed.
 */
function resolveAllowedOrigins(): string[] | undefined {
  const raw = process.env.ALLOWED_ORIGINS || process.env.CORS_ORIGINS || '';
  const origins = raw
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0 && o !== '*');

  if (origins.length === 0) {
    if (process.env.NODE_ENV === 'production') {
      console.warn(
        '[WebSocket] ALLOWED_ORIGINS is not set — cross-origin WebSocket connections are disabled (same-origin only)'
      );
    }
    return undefined;
  }
  return origins;
}

/**
 * Authenticate a socket.io handshake using the same session cookie/JWT
 * verification as the HTTP API (sdk.verifySession). Returns the verified
 * user's database id, or null when the handshake is not authenticated.
 */
async function authenticateSocket(socket: Socket): Promise<number | null> {
  try {
    const cookieHeader = socket.handshake.headers.cookie;
    if (!cookieHeader) {
      console.warn('[WebSocket] Handshake rejected: no cookie header');
      return null;
    }

    const cookies = parseCookieHeader(cookieHeader);
    const sessionCookie = cookies[COOKIE_NAME];
    const session = await sdk.verifySession(sessionCookie);
    if (!session) {
      console.warn('[WebSocket] Handshake rejected: invalid session token');
      return null;
    }

    const user = await db.getUserByOpenId(session.openId);
    if (!user) {
      console.warn('[WebSocket] Handshake rejected: session user not found');
      return null;
    }

    return user.id;
  } catch (error) {
    console.error('[WebSocket] Handshake authentication error:', error);
    return null;
  }
}

export function initializeWebSocket(httpServer: HTTPServer) {
  const allowedOrigins = resolveAllowedOrigins();

  io = new SocketIOServer(httpServer, {
    ...(allowedOrigins
      ? {
          cors: {
            origin: allowedOrigins,
            methods: ['GET', 'POST'],
            credentials: true,
          },
        }
      : {}),
    path: '/api/socket.io',
  });

  // Handshake authentication middleware: reject unauthenticated connections.
  io.use(async (socket, next) => {
    const userId = await authenticateSocket(socket);
    if (userId === null) {
      next(new Error('Authentication required'));
      return;
    }
    socket.data.userId = userId;
    next();
  });

  io.on('connection', (socket) => {
    // Identity ALWAYS comes from the verified handshake session — any
    // client-supplied userId in event payloads is ignored.
    const userId = socket.data.userId as number;
    console.log('[WebSocket] Client connected:', socket.id, 'user:', userId);

    // Join user-specific room for personalized data
    socket.on('join', async () => {
      socket.join(`user:${userId}`);
      console.log(`[WebSocket] User ${userId} joined their room`);

      // Send initial telemetry data
      try {
        const telemetry = await db.getLatestTelemetry(userId);
        if (telemetry) {
          socket.emit('telemetry:update', telemetry);
        }
      } catch (error) {
        console.error('[WebSocket] Error fetching initial telemetry:', error);
      }
    });

    // Analytics data subscription
    socket.on('subscribe:analytics', async () => {
      socket.join(`analytics:${userId}`);
      console.log(`[WebSocket] User ${userId} subscribed to analytics updates`);
    });

    socket.on('unsubscribe:analytics', () => {
      socket.leave(`analytics:${userId}`);
      console.log(`[WebSocket] User ${userId} unsubscribed from analytics updates`);
    });

    socket.on('disconnect', () => {
      console.log('[WebSocket] Client disconnected:', socket.id);
    });
  });

  // Broadcast real telemetry from the database to connected clients.
  // Data is written by the MQTT-Fluvio bridge; this loop only reads persisted rows.
  startTelemetryBroadcast();

  console.log('[WebSocket] Server initialized');
  return io;
}

export function getIO(): SocketIOServer | null {
  return io;
}

/**
 * Broadcast real telemetry from the database to connected WebSocket clients.
 *
 * Runs every 5 seconds. For each user that has at least one asset it fetches
 * the most-recently persisted telemetry row and emits it to that user's room.
 * No values are generated or fabricated here — all data originates from real
 * device readings ingested through the MQTT-Fluvio pipeline.
 */
function startTelemetryBroadcast() {
  setInterval(async () => {
    if (!io) return;

    try {
      const db_instance = await db.getDb();
      if (!db_instance) return;

      const usersWithAssets = await db_instance
        .select({ id: users.id })
        .from(users)
        .limit(100);

      for (const user of usersWithAssets) {
        const assets = await db.getUserAssets(user.id);
        if (assets.length === 0) continue;

        // Fetch the latest real telemetry row for this user.
        // If no telemetry has been received yet (device offline / not yet
        // commissioned), nothing is emitted — the client retains its last state.
        const latest = await db.getLatestTelemetry(user.id);
        if (!latest) continue;

        io.to(`user:${user.id}`).emit('telemetry:update', latest);
      }
    } catch (error) {
      console.error('[WebSocket] Error in telemetry broadcast:', error);
    }
  }, 5000);
}

// Emit telemetry update to specific user
export async function emitTelemetryUpdate(userId: number, data: any) {
  if (!io) return;
  io.to(`user:${userId}`).emit('telemetry:update', data);
}

// Emit alert to specific user
export async function emitAlert(userId: number, alert: any) {
  if (!io) return;
  io.to(`user:${userId}`).emit('alert:new', alert);
}

// Emit trading update to specific user
export async function emitTradingUpdate(userId: number, trade: any) {
  if (!io) return;
  io.to(`user:${userId}`).emit('trading:update', trade);
}
