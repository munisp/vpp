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

  // Start simulating telemetry updates for demo purposes
  startTelemetrySimulation();

  console.log('[WebSocket] Server initialized');
  return io;
}

export function getIO(): SocketIOServer | null {
  return io;
}

// Simulate telemetry updates every 5 seconds for demo
function startTelemetrySimulation() {
  setInterval(async () => {
    if (!io) return;

    try {
      const db_instance = await db.getDb();
      if (!db_instance) return;

      // Get all users with assets - simplified for demo
      // In production, you would query users who have active assets
      const usersWithAssets = await db_instance.select({ id: users.id }).from(users).limit(100);

      for (const user of usersWithAssets) {
        // Check if user has assets
        const assets = await db.getUserAssets(user.id);
        if (assets.length === 0) continue;

        // Generate simulated telemetry data matching schema
        const power = Math.floor(Math.random() * 5000); // 0-5000W
        const voltage = Math.floor((220 + (Math.random() * 20 - 10)) * 1000); // in millivolts
        const current = Math.floor(Math.random() * 20 * 1000); // in milliamps
        const frequency = Math.floor((50 + (Math.random() * 0.5 - 0.25)) * 1000); // in millihertz
        const stateOfCharge = Math.floor(Math.random() * 10000); // 0-100% * 100
        const temperature = Math.floor((25 + Math.random() * 15) * 100); // in celsius * 100
        
        const simulatedData = {
          assetId: assets[0].id,
          timestamp: new Date(),
          power,
          energy: Math.floor(Math.random() * 50000), // cumulative Wh
          voltage,
          current,
          frequency,
          stateOfCharge,
          temperature,
          metadata: JSON.stringify({
            userId: user.id,
            powerGeneration: power,
            batteryLevel: stateOfCharge / 100,
            gridFlow: Math.random() * 2000 - 1000, // -1000 to 1000W (negative = import, positive = export)
          }),
        };

        // Save to database
        await db.insertTelemetry(simulatedData);

        // Emit to user's room
        io.to(`user:${user.id}`).emit('telemetry:update', simulatedData);
      }
    } catch (error) {
      console.error('[WebSocket] Error in telemetry simulation:', error);
    }
  }, 5000); // Update every 5 seconds
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
