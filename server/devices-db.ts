/**
 * Device Management Database Functions
 */

import { eq, desc, and } from 'drizzle-orm';
import { getDb } from './db';
import { devices, deviceCommands, deviceLogs, type InsertDevice, type InsertDeviceCommand, type InsertDeviceLog } from '../drizzle/schema';

/**
 * Get all devices
 */
export async function getAllDevices() {
  const db = await getDb();
  if (!db) return [];
  
  return await db
    .select()
    .from(devices)
    .orderBy(desc(devices.createdAt));
}

/**
 * Get device by ID
 */
export async function getDeviceById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  
  const result = await db
    .select()
    .from(devices)
    .where(eq(devices.id, id))
    .limit(1);
  
  return result[0];
}

/**
 * Get devices by asset ID
 */
export async function getDevicesByAssetId(assetId: number) {
  const db = await getDb();
  if (!db) return [];
  
  return await db
    .select()
    .from(devices)
    .where(eq(devices.assetId, assetId));
}

/**
 * Create new device
 */
export async function createDevice(device: InsertDevice) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  
  const result = await db
    .insert(devices)
    .values(device)
    .returning({ id: devices.id });
  
  return result[0].id;
}

/**
 * Update device
 */
export async function updateDevice(id: number, updates: Partial<InsertDevice>) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  
  await db
    .update(devices)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(devices.id, id));
}

/**
 * Delete device
 */
export async function deleteDevice(id: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  
  await db
    .delete(devices)
    .where(eq(devices.id, id));
}

/**
 * Update device status
 */
export async function updateDeviceStatus(
  id: number,
  status: 'online' | 'offline' | 'error' | 'maintenance',
  lastSeen?: Date
) {
  const db = await getDb();
  if (!db) return;
  
  await db
    .update(devices)
    .set({
      status,
      lastSeen: lastSeen || new Date(),
      updatedAt: new Date(),
    })
    .where(eq(devices.id, id));
}

/**
 * Create device command
 */
export async function createDeviceCommand(command: InsertDeviceCommand) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  
  const result = await db
    .insert(deviceCommands)
    .values(command)
    .returning({ id: deviceCommands.id });
  
  return result[0].id;
}

/**
 * Get device commands
 */
export async function getDeviceCommands(deviceId: number, limit = 50) {
  const db = await getDb();
  if (!db) return [];
  
  return await db
    .select()
    .from(deviceCommands)
    .where(eq(deviceCommands.deviceId, deviceId))
    .orderBy(desc(deviceCommands.createdAt))
    .limit(limit);
}

/**
 * Update command status
 */
export async function updateCommandStatus(
  id: number,
  status: 'pending' | 'sent' | 'acknowledged' | 'failed',
  response?: string
) {
  const db = await getDb();
  if (!db) return;
  
  const updates: any = { status };
  
  if (status === 'sent') {
    updates.sentAt = new Date();
  } else if (status === 'acknowledged') {
    updates.acknowledgedAt = new Date();
    if (response) updates.response = response;
  }
  
  await db
    .update(deviceCommands)
    .set(updates)
    .where(eq(deviceCommands.id, id));
}

/**
 * Create device log
 */
export async function createDeviceLog(log: InsertDeviceLog) {
  const db = await getDb();
  if (!db) return;
  
  await db
    .insert(deviceLogs)
    .values(log);
}

/**
 * Get device logs
 */
export async function getDeviceLogs(deviceId: number, limit = 100) {
  const db = await getDb();
  if (!db) return [];
  
  return await db
    .select()
    .from(deviceLogs)
    .where(eq(deviceLogs.deviceId, deviceId))
    .orderBy(desc(deviceLogs.createdAt))
    .limit(limit);
}

/**
 * Get device statistics
 */
export async function getDeviceStats() {
  const db = await getDb();
  if (!db) return {
    total: 0,
    online: 0,
    offline: 0,
    error: 0,
    maintenance: 0,
  };
  
  const allDevices = await db.select().from(devices);
  
  return {
    total: allDevices.length,
    online: allDevices.filter(d => d.status === 'online').length,
    offline: allDevices.filter(d => d.status === 'offline').length,
    error: allDevices.filter(d => d.status === 'error').length,
    maintenance: allDevices.filter(d => d.status === 'maintenance').length,
  };
}
