/**
 * MQTT Service for IoT Device Integration
 * 
 * Handles communication with smart meters, inverters, and other IoT devices
 */

import mqtt from 'mqtt';
import { getDb } from '../db';
import { telemetry, assets } from '../../drizzle/schema';
import { eq } from 'drizzle-orm';

// MQTT Configuration
const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
const MQTT_USERNAME = process.env.MQTT_USERNAME || '';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || '';

// Topic structure: vpp/{userId}/{assetId}/{metric}
const TOPIC_PREFIX = 'vpp';

interface DeviceMessage {
  deviceId: string;
  timestamp: number;
  power?: number;
  energy?: number;
  voltage?: number;
  current?: number;
  frequency?: number;
  stateOfCharge?: number;
  temperature?: number;
  metadata?: Record<string, any>;
}

class MQTTService {
  private client: mqtt.MqttClient | null = null;
  private connected = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;

  /**
   * Initialize MQTT connection
   */
  async connect(): Promise<void> {
    if (this.connected) {
      console.log('[MQTT] Already connected');
      return;
    }

    try {
      console.log('[MQTT] Connecting to broker:', MQTT_BROKER_URL);

      this.client = mqtt.connect(MQTT_BROKER_URL, {
        username: MQTT_USERNAME,
        password: MQTT_PASSWORD,
        clientId: `vpp-server-${Math.random().toString(16).slice(2, 8)}`,
        clean: true,
        reconnectPeriod: 5000,
        connectTimeout: 30000,
      });

      this.client.on('connect', () => {
        console.log('[MQTT] Connected successfully');
        this.connected = true;
        this.reconnectAttempts = 0;
        this.subscribeToTopics();
      });

      this.client.on('error', (error) => {
        console.error('[MQTT] Connection error:', error.message);
        this.connected = false;
      });

      this.client.on('reconnect', () => {
        this.reconnectAttempts++;
        console.log(`[MQTT] Reconnecting... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
        
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          console.error('[MQTT] Max reconnection attempts reached');
          this.client?.end();
        }
      });

      this.client.on('close', () => {
        console.log('[MQTT] Connection closed');
        this.connected = false;
      });

      this.client.on('message', (topic, payload) => {
        this.handleMessage(topic, payload);
      });

    } catch (error) {
      console.error('[MQTT] Failed to connect:', error);
      throw error;
    }
  }

  /**
   * Subscribe to device topics
   */
  private subscribeToTopics(): void {
    if (!this.client) return;

    // Subscribe to all device telemetry
    const topics = [
      `${TOPIC_PREFIX}/+/+/telemetry`,
      `${TOPIC_PREFIX}/+/+/status`,
    ];

    topics.forEach(topic => {
      this.client?.subscribe(topic, { qos: 1 }, (err) => {
        if (err) {
          console.error(`[MQTT] Failed to subscribe to ${topic}:`, err);
        } else {
          console.log(`[MQTT] Subscribed to ${topic}`);
        }
      });
    });
  }

  /**
   * Handle incoming MQTT messages
   */
  private async handleMessage(topic: string, payload: Buffer): Promise<void> {
    try {
      const parts = topic.split('/');
      if (parts.length < 4) {
        console.warn('[MQTT] Invalid topic format:', topic);
        return;
      }

      const [prefix, userId, assetId, messageType] = parts;

      if (prefix !== TOPIC_PREFIX) {
        return;
      }

      const message: DeviceMessage = JSON.parse(payload.toString());

      if (messageType === 'telemetry') {
        await this.storeTelemetry(parseInt(assetId), message);
      } else if (messageType === 'status') {
        await this.updateDeviceStatus(parseInt(assetId), message);
      }

    } catch (error) {
      console.error('[MQTT] Error handling message:', error);
    }
  }

  /**
   * Store telemetry data in database
   */
  private async storeTelemetry(assetId: number, message: DeviceMessage): Promise<void> {
    const db = await getDb();
    if (!db) {
      console.warn('[MQTT] Database not available, skipping telemetry storage');
      return;
    }

    try {
      // Verify asset exists
      const asset = await db
        .select()
        .from(assets)
        .where(eq(assets.id, assetId))
        .limit(1);

      if (!asset.length) {
        console.warn(`[MQTT] Asset ${assetId} not found, ignoring telemetry`);
        return;
      }

      await db.insert(telemetry).values({
        assetId,
        timestamp: new Date(message.timestamp),
        power: message.power,
        energy: message.energy,
        voltage: message.voltage,
        current: message.current,
        frequency: message.frequency,
        stateOfCharge: message.stateOfCharge,
        temperature: message.temperature,
        metadata: message.metadata ? JSON.stringify(message.metadata) : null,
      });

      console.log(`[MQTT] Stored telemetry for asset ${assetId}`);
    } catch (error) {
      console.error('[MQTT] Failed to store telemetry:', error);
    }
  }

  /**
   * Update device status
   */
  private async updateDeviceStatus(assetId: number, message: DeviceMessage): Promise<void> {
    const db = await getDb();
    if (!db) return;

    try {
      const status = message.metadata?.status || 'active';
      
      await db
        .update(assets)
        .set({
          status: status as 'active' | 'inactive' | 'maintenance' | 'fault',
          updatedAt: new Date(),
        })
        .where(eq(assets.id, assetId));

      console.log(`[MQTT] Updated status for asset ${assetId}: ${status}`);
    } catch (error) {
      console.error('[MQTT] Failed to update device status:', error);
    }
  }

  /**
   * Publish command to device
   */
  async publishCommand(userId: number, assetId: number, command: string, payload: any): Promise<void> {
    if (!this.connected || !this.client) {
      throw new Error('MQTT client not connected');
    }

    const topic = `${TOPIC_PREFIX}/${userId}/${assetId}/command/${command}`;
    const message = JSON.stringify(payload);

    return new Promise((resolve, reject) => {
      this.client!.publish(topic, message, { qos: 1 }, (err) => {
        if (err) {
          console.error(`[MQTT] Failed to publish command to ${topic}:`, err);
          reject(err);
        } else {
          console.log(`[MQTT] Published command to ${topic}`);
          resolve();
        }
      });
    });
  }

  /**
   * Disconnect from MQTT broker
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await new Promise<void>((resolve) => {
        this.client!.end(false, {}, () => {
          console.log('[MQTT] Disconnected');
          this.connected = false;
          resolve();
        });
      });
    }
  }

  /**
   * Check connection status
   */
  isConnected(): boolean {
    return this.connected;
  }
}

// Singleton instance
export const mqttService = new MQTTService();

// Auto-connect on module load (optional - can be disabled for testing)
if (process.env.NODE_ENV !== 'test') {
  mqttService.connect().catch(err => {
    console.error('[MQTT] Failed to auto-connect:', err);
  });
}
