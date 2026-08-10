/**
 * WebSocket Service for Real-Time Data Streaming
 * 
 * Provides real-time asset data updates to connected clients
 */

import { Server as SocketIOServer } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { mqttBrokerService, DeviceReading, DeviceAlert } from './mqtt-broker';

export class WebSocketService {
  private io: SocketIOServer | null = null;
  private connectedClients: Map<string, Set<number>> = new Map(); // socketId -> Set of assetIds

  /**
   * Initialize WebSocket server
   */
  initialize(httpServer: HTTPServer): void {
    this.io = new SocketIOServer(httpServer, {
      cors: {
        origin: process.env.CORS_ORIGIN || '*',
        methods: ['GET', 'POST'],
      },
      path: '/api/socket.io',
    });

    this.setupEventHandlers();
    this.setupMQTTForwarding();

    console.log('[WebSocket] Server initialized');
  }

  /**
   * Setup Socket.IO event handlers
   */
  private setupEventHandlers(): void {
    if (!this.io) return;

    this.io.on('connection', (socket) => {
      console.log(`[WebSocket] Client connected: ${socket.id}`);

      // Handle asset subscription
      socket.on('subscribe:asset', (assetId: number) => {
        console.log(`[WebSocket] Client ${socket.id} subscribed to asset ${assetId}`);
        
        // Join asset-specific room
        socket.join(`asset:${assetId}`);
        
        // Track subscription
        if (!this.connectedClients.has(socket.id)) {
          this.connectedClients.set(socket.id, new Set());
        }
        this.connectedClients.get(socket.id)!.add(assetId);
      });

      // Handle asset unsubscription
      socket.on('unsubscribe:asset', (assetId: number) => {
        console.log(`[WebSocket] Client ${socket.id} unsubscribed from asset ${assetId}`);
        
        socket.leave(`asset:${assetId}`);
        
        const subscriptions = this.connectedClients.get(socket.id);
        if (subscriptions) {
          subscriptions.delete(assetId);
        }
      });

      // Handle user-specific subscription
      socket.on('subscribe:user', (userId: number) => {
        console.log(`[WebSocket] Client ${socket.id} subscribed to user ${userId}`);
        socket.join(`user:${userId}`);
      });

      // Handle disconnection
      socket.on('disconnect', () => {
        console.log(`[WebSocket] Client disconnected: ${socket.id}`);
        this.connectedClients.delete(socket.id);
      });
    });
  }

  /**
   * Setup MQTT to WebSocket forwarding
   */
  private setupMQTTForwarding(): void {
    // Forward device readings to WebSocket clients
    mqttBrokerService.onReading((reading: DeviceReading) => {
      this.broadcastAssetReading(reading);
    });

    // Forward device alerts to WebSocket clients
    mqttBrokerService.onAlert((alert: DeviceAlert) => {
      this.broadcastAssetAlert(alert);
    });
  }

  /**
   * Broadcast asset reading to subscribed clients
   */
  private broadcastAssetReading(reading: DeviceReading): void {
    if (!this.io) return;

    this.io.to(`asset:${reading.assetId}`).emit('asset:reading', {
      assetId: reading.assetId,
      timestamp: reading.timestamp,
      power: reading.power,
      energy: reading.energy,
      voltage: reading.voltage,
      current: reading.current,
      frequency: reading.frequency,
      temperature: reading.temperature,
      status: reading.status,
    });
  }

  /**
   * Broadcast asset alert to subscribed clients
   */
  private broadcastAssetAlert(alert: DeviceAlert): void {
    if (!this.io) return;

    this.io.to(`asset:${alert.assetId}`).emit('asset:alert', {
      assetId: alert.assetId,
      severity: alert.severity,
      message: alert.message,
      timestamp: alert.timestamp,
    });
  }

  /**
   * Broadcast notification to specific user
   */
  broadcastUserNotification(userId: number, notification: any): void {
    if (!this.io) return;

    this.io.to(`user:${userId}`).emit('notification', notification);
  }

  /**
   * Broadcast system-wide message
   */
  broadcastSystemMessage(message: any): void {
    if (!this.io) return;

    this.io.emit('system:message', message);
  }

  /**
   * Get connected clients count
   */
  getConnectedClientsCount(): number {
    return this.connectedClients.size;
  }

  /**
   * Get subscriptions for an asset
   */
  getAssetSubscribers(assetId: number): number {
    if (!this.io) return 0;
    
    const room = this.io.sockets.adapter.rooms.get(`asset:${assetId}`);
    return room ? room.size : 0;
  }
}

// Singleton instance
export const webSocketService = new WebSocketService();
