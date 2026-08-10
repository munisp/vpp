import { Server as HTTPServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import * as db from '../db';
import { users } from '../../drizzle/schema';

let io: SocketIOServer | null = null;

export function initializeWebSocket(httpServer: HTTPServer) {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
    path: '/api/socket.io',
  });

  io.on('connection', (socket) => {
    console.log('[WebSocket] Client connected:', socket.id);

    // Join user-specific room for personalized data
    socket.on('join', async (userId: number) => {
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
    socket.on('subscribe:analytics', async (userId: number) => {
      socket.join(`analytics:${userId}`);
      console.log(`[WebSocket] User ${userId} subscribed to analytics updates`);
    });

    socket.on('unsubscribe:analytics', (userId: number) => {
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
