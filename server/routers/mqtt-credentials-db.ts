/**
 * MQTT Broker Credentials Management
 * 
 * Handles secure storage and retrieval of MQTT broker connection credentials
 */

import { getDb } from '../db';
import { mqttBrokerCredentials } from '../../drizzle/schema';
import { eq } from 'drizzle-orm';

export interface MQTTCredentials {
  host: string;
  port: number;
  protocol: 'mqtt' | 'mqtts' | 'ws' | 'wss';
  username?: string;
  password?: string;
  clientId?: string;
  clean?: boolean;
  keepalive?: number;
  reconnectPeriod?: number;
  connectTimeout?: number;
  ca?: string; // CA certificate for TLS
  cert?: string; // Client certificate
  key?: string; // Client key
}

/**
 * Get MQTT broker credentials
 */
export async function getMQTTCredentials(environment: 'sandbox' | 'production' = 'production'): Promise<MQTTCredentials | null> {
  const db = await getDb();
  if (!db) {
    console.warn('[MQTT Credentials] Database not available');
    return null;
  }

  try {
    const result = await db
      .select()
      .from(mqttBrokerCredentials)
      .where(eq(mqttBrokerCredentials.environment, environment))
      .limit(1);

    if (result.length === 0) {
      return null;
    }

    const cred = result[0];
    return JSON.parse(cred.credentials) as MQTTCredentials;
  } catch (error: any) {
    console.error('[MQTT Credentials] Failed to get credentials:', error);
    return null;
  }
}

/**
 * Save or update MQTT broker credentials
 */
export async function saveMQTTCredentials(
  credentials: MQTTCredentials,
  environment: 'sandbox' | 'production' = 'production',
  isActive: boolean = true
): Promise<boolean> {
  const db = await getDb();
  if (!db) {
    console.warn('[MQTT Credentials] Database not available');
    return false;
  }

  try {
    const existing = await db
      .select()
      .from(mqttBrokerCredentials)
      .where(eq(mqttBrokerCredentials.environment, environment))
      .limit(1);

    const credentialsJson = JSON.stringify(credentials);

    if (existing.length > 0) {
      // Update existing
      await db
        .update(mqttBrokerCredentials)
        .set({
          credentials: credentialsJson,
          isActive: isActive ? 'true' : 'false',
          updatedAt: new Date(),
        })
        .where(eq(mqttBrokerCredentials.id, existing[0].id));
    } else {
      // Insert new
      await db.insert(mqttBrokerCredentials).values({
        environment,
        credentials: credentialsJson,
        isActive: isActive ? 'true' : 'false',
      });
    }

    console.log(`[MQTT Credentials] Saved ${environment} credentials`);
    return true;
  } catch (error: any) {
    console.error('[MQTT Credentials] Failed to save credentials:', error);
    return false;
  }
}

/**
 * Test MQTT broker connection
 */
export async function testMQTTConnection(credentials: MQTTCredentials): Promise<{ success: boolean; message: string }> {
  try {
    const mqtt = await import('mqtt');
    
    return new Promise((resolve) => {
      const client = mqtt.connect({
        host: credentials.host,
        port: credentials.port,
        protocol: credentials.protocol,
        username: credentials.username,
        password: credentials.password,
        clientId: credentials.clientId || `test_${Date.now()}`,
        connectTimeout: credentials.connectTimeout || 5000,
      });

      const timeout = setTimeout(() => {
        client.end(true);
        resolve({
          success: false,
          message: 'Connection timeout after 5 seconds',
        });
      }, 5000);

      client.on('connect', () => {
        clearTimeout(timeout);
        client.end(true);
        resolve({
          success: true,
          message: 'Successfully connected to MQTT broker',
        });
      });

      client.on('error', (error: Error) => {
        clearTimeout(timeout);
        client.end(true);
        resolve({
          success: false,
          message: `Connection error: ${error.message}`,
        });
      });
    });
  } catch (error: any) {
    return {
      success: false,
      message: `Failed to test connection: ${error.message}`,
    };
  }
}

/**
 * Delete MQTT broker credentials
 */
export async function deleteMQTTCredentials(environment: 'sandbox' | 'production'): Promise<boolean> {
  const db = await getDb();
  if (!db) {
    console.warn('[MQTT Credentials] Database not available');
    return false;
  }

  try {
    await db
      .delete(mqttBrokerCredentials)
      .where(eq(mqttBrokerCredentials.environment, environment));

    console.log(`[MQTT Credentials] Deleted ${environment} credentials`);
    return true;
  } catch (error: any) {
    console.error('[MQTT Credentials] Failed to delete credentials:', error);
    return false;
  }
}
