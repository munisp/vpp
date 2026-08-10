/**
 * MQTT Broker Integration for IoT Device Communication
 * 
 * Handles real-time data ingestion from solar inverters, batteries, and other energy assets
 */

import mqtt from 'mqtt';
import { getDb } from '../db';
import { telemetry, alerts, assets } from '../../drizzle/schema';
import { eq } from 'drizzle-orm';

export interface DeviceReading {
  deviceId: string;
  assetId: number;
  timestamp: Date;
  power: number; // Watts
  energy: number; // Wh
  voltage?: number; // Volts
  current?: number; // Amps
  frequency?: number; // Hz
  temperature?: number; // Celsius
  status: 'online' | 'offline' | 'error';
  metadata?: Record<string, any>;
}

export interface DeviceAlert {
  deviceId: string;
  assetId: number;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  timestamp: Date;
  resolved: boolean;
}

class MQTTBrokerService {
  private client: mqtt.MqttClient | null = null;
  private brokerUrl: string;
  private username: string;
  private password: string;
  private connected: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;

  // Callback handlers
  private onReadingCallback?: (reading: DeviceReading) => void;
  private onAlertCallback?: (alert: DeviceAlert) => void;

  constructor() {
    this.brokerUrl = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
    this.username = process.env.MQTT_USERNAME || '';
    this.password = process.env.MQTT_PASSWORD || '';
  }

  /**
   * Connect to MQTT broker
   */
  async connect(): Promise<void> {
    if (this.connected) {
      console.log('[MQTT] Already connected');
      return;
    }

    try {
      console.log('[MQTT] Connecting to broker:', this.brokerUrl);

      this.client = mqtt.connect(this.brokerUrl, {
        username: this.username,
        password: this.password,
        clientId: `vpp-server-${Math.random().toString(16).slice(2, 10)}`,
        clean: true,
        reconnectPeriod: 5000,
        connectTimeout: 30000,
      });

      this.client.on('connect', () => {
        console.log('[MQTT] Connected to broker');
        this.connected = true;
        this.reconnectAttempts = 0;
        this.subscribeToTopics();
      });

      this.client.on('error', (error) => {
        console.error('[MQTT] Connection error:', error.message);
        this.connected = false;
      });

      this.client.on('close', () => {
        console.log('[MQTT] Connection closed');
        this.connected = false;
      });

      this.client.on('reconnect', () => {
        this.reconnectAttempts++;
        console.log(`[MQTT] Reconnecting... (attempt ${this.reconnectAttempts})`);
        
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          console.error('[MQTT] Max reconnection attempts reached');
          this.client?.end();
        }
      });

      this.client.on('message', (topic, message) => {
        this.handleMessage(topic, message);
      });

    } catch (error: any) {
      console.error('[MQTT] Failed to connect:', error);
      throw new Error(`MQTT connection failed: ${error.message}`);
    }
  }

  /**
   * Subscribe to device topics
   */
  private subscribeToTopics(): void {
    if (!this.client) return;

    // Subscribe to device data topics
    this.client.subscribe('vpp/devices/+/data', (err) => {
      if (err) {
        console.error('[MQTT] Failed to subscribe to device data:', err);
      } else {
        console.log('[MQTT] Subscribed to device data topics');
      }
    });

    // Subscribe to device alert topics
    this.client.subscribe('vpp/devices/+/alerts', (err) => {
      if (err) {
        console.error('[MQTT] Failed to subscribe to device alerts:', err);
      } else {
        console.log('[MQTT] Subscribed to device alert topics');
      }
    });

    // Subscribe to device status topics
    this.client.subscribe('vpp/devices/+/status', (err) => {
      if (err) {
        console.error('[MQTT] Failed to subscribe to device status:', err);
      } else {
        console.log('[MQTT] Subscribed to device status topics');
      }
    });
  }

  /**
   * Handle incoming MQTT messages
   */
  private async handleMessage(topic: string, message: Buffer): Promise<void> {
    try {
      const payload = JSON.parse(message.toString());

      if (topic.includes('/data')) {
        await this.handleDeviceData(payload);
      } else if (topic.includes('/alerts')) {
        await this.handleDeviceAlert(payload);
      } else if (topic.includes('/status')) {
        await this.handleDeviceStatus(payload);
      }
    } catch (error: any) {
      console.error('[MQTT] Failed to handle message:', error);
    }
  }

  /**
   * Handle device data readings
   */
  private async handleDeviceData(payload: any): Promise<void> {
    try {
      const reading: DeviceReading = {
        deviceId: payload.deviceId,
        assetId: payload.assetId,
        timestamp: new Date(payload.timestamp || Date.now()),
        power: payload.power,
        energy: payload.energy,
        voltage: payload.voltage,
        current: payload.current,
        frequency: payload.frequency,
        temperature: payload.temperature,
        status: payload.status || 'online',
        metadata: payload.metadata,
      };

      // Store in database
      const db = await getDb();
      if (db) {
        await db.insert(telemetry).values({
          assetId: reading.assetId,
          timestamp: reading.timestamp,
          power: reading.power,
          energy: reading.energy,
          voltage: reading.voltage,
          current: reading.current,
          temperature: reading.temperature,
          metadata: reading.metadata ? JSON.stringify(reading.metadata) : null,
        });
      }

      // Trigger callback
      if (this.onReadingCallback) {
        this.onReadingCallback(reading);
      }

      console.log(`[MQTT] Stored reading for device ${reading.deviceId}`);
    } catch (error: any) {
      console.error('[MQTT] Failed to handle device data:', error);
    }
  }

  /**
   * Handle device alerts - store in database and send notifications
   */
  private async handleDeviceAlert(payload: any): Promise<void> {
    try {
      const alert: DeviceAlert = {
        deviceId: payload.deviceId,
        assetId: payload.assetId,
        severity: payload.severity || 'info',
        message: payload.message,
        timestamp: new Date(payload.timestamp || Date.now()),
        resolved: payload.resolved || false,
      };

      // Store alert in database
      const db = await getDb();
      if (db && alert.assetId) {
        // Get the asset to find the user
        const assetResult = await db
          .select()
          .from(assets)
          .where(eq(assets.id, alert.assetId))
          .limit(1);
        
        if (assetResult.length > 0) {
          const asset = assetResult[0];
          
          // Map severity to alert severity enum
          const severity = alert.severity === 'critical' ? 'critical' : 
                           alert.severity === 'warning' ? 'warning' : 'info';
          
          // Create alert record for the asset owner
          await db.insert(alerts).values({
            userId: asset.userId,
            alertType: 'maintenance',
            severity: severity as 'info' | 'warning' | 'error' | 'critical',
            title: `Device Alert: ${alert.deviceId}`,
            message: alert.message,
            isRead: false,
            metadata: JSON.stringify({
              deviceId: alert.deviceId,
              assetId: alert.assetId,
              originalSeverity: alert.severity,
              resolved: alert.resolved,
              timestamp: alert.timestamp.toISOString(),
            }),
          });
          
          console.log(`[MQTT] Stored alert for device ${alert.deviceId} (user ${asset.userId})`);
        }
      }

      // Trigger callback
      if (this.onAlertCallback) {
        this.onAlertCallback(alert);
      }

      console.log(`[MQTT] Alert from device ${alert.deviceId}: ${alert.message}`);
    } catch (error: any) {
      console.error('[MQTT] Failed to handle device alert:', error);
    }
  }

  /**
   * Handle device status updates - update database and trigger alerts for offline devices
   */
  private async handleDeviceStatus(payload: any): Promise<void> {
    try {
      console.log(`[MQTT] Device ${payload.deviceId} status: ${payload.status}`);
      
      const db = await getDb();
      if (db && payload.assetId) {
        // Update asset status in database
        const newStatus = payload.status === 'online' ? 'active' : 
                         payload.status === 'offline' ? 'inactive' : 'maintenance';
        
        await db.update(assets)
          .set({ status: newStatus })
          .where(eq(assets.id, payload.assetId));
        
        console.log(`[MQTT] Updated asset ${payload.assetId} status to ${newStatus}`);
        
        // If device went offline, create an alert
        if (payload.status === 'offline') {
          const assetResult = await db
            .select()
            .from(assets)
            .where(eq(assets.id, payload.assetId))
            .limit(1);
          
          if (assetResult.length > 0) {
            const asset = assetResult[0];
            
            await db.insert(alerts).values({
              userId: asset.userId,
              alertType: 'maintenance',
              severity: 'warning',
              title: 'Device Offline',
              message: `Device ${payload.deviceId} (${asset.name}) has gone offline.`,
              isRead: false,
              metadata: JSON.stringify({
                deviceId: payload.deviceId,
                assetId: payload.assetId,
                previousStatus: 'online',
                newStatus: 'offline',
                timestamp: new Date().toISOString(),
              }),
            });
            
            console.log(`[MQTT] Created offline alert for device ${payload.deviceId}`);
          }
        }
      }
    } catch (error: any) {
      console.error('[MQTT] Failed to handle device status:', error);
    }
  }

  /**
   * Publish command to device
   */
  async publishCommand(deviceId: string, command: string, params?: any): Promise<void> {
    if (!this.client || !this.connected) {
      throw new Error('MQTT client not connected');
    }

    const topic = `vpp/devices/${deviceId}/commands`;
    const payload = JSON.stringify({
      command,
      params,
      timestamp: new Date().toISOString(),
    });

    return new Promise((resolve, reject) => {
      this.client!.publish(topic, payload, { qos: 1 }, (err) => {
        if (err) {
          console.error(`[MQTT] Failed to publish command to ${deviceId}:`, err);
          reject(err);
        } else {
          console.log(`[MQTT] Published command to ${deviceId}: ${command}`);
          resolve();
        }
      });
    });
  }

  /**
   * Register callback for device readings
   */
  onReading(callback: (reading: DeviceReading) => void): void {
    this.onReadingCallback = callback;
  }

  /**
   * Register callback for device alerts
   */
  onAlert(callback: (alert: DeviceAlert) => void): void {
    this.onAlertCallback = callback;
  }

  /**
   * Disconnect from broker
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.end();
      this.connected = false;
      console.log('[MQTT] Disconnected from broker');
    }
  }

  /**
   * Get connection status
   */
  isConnected(): boolean {
    return this.connected;
  }
}

// Singleton instance
export const mqttBrokerService = new MQTTBrokerService();

// Auto-connect on module load
if (process.env.MQTT_BROKER_URL) {
  mqttBrokerService.connect().catch((error) => {
    console.error('[MQTT] Failed to auto-connect:', error);
  });
}
