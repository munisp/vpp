/**
 * Device Management Router
 * Admin-only endpoints for IoT device management
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { randomBytes, scrypt } from 'crypto';
import { promisify } from 'util';
import { adminProcedure, router } from '../_core/trpc';
import * as devicesDb from '../devices-db';
import { getDb } from '../db';
import { assets } from '../../drizzle/schema';
import { eq } from 'drizzle-orm';
import { mqttService } from '../_core/mqtt';
import { isUniqueViolation } from '../pg-errors';

const scryptAsync = promisify(scrypt);

/**
 * Commands that change what the hardware exports or imports. These belong to the
 * bounded control path (`controlWindows`), which records a validity window, a
 * fallback and a delivery state for every setpoint.
 */
const SETPOINT_COMMANDS = new Set([
  'set_power',
  'set_setpoint',
  'setpoint',
  'set_limit',
  'charge',
  'discharge',
  'curtail',
  'clear_setpoint',
]);

export const devicesRouter = router({
  /**
   * List all devices
   */
  list: adminProcedure.query(async () => {
    const devices = await devicesDb.getAllDevices();
    return { devices };
  }),

  /**
   * Get device by ID
   */
  getById: adminProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const device = await devicesDb.getDeviceById(input.id);
      if (!device) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Device not found',
        });
      }
      return device;
    }),

  /**
   * Get devices by asset
   */
  getByAsset: adminProcedure
    .input(z.object({ assetId: z.number() }))
    .query(async ({ input }) => {
      const devices = await devicesDb.getDevicesByAssetId(input.assetId);
      return { devices };
    }),

  /**
   * Register new device
   */
  register: adminProcedure
    .input(z.object({
      assetId: z.number(),
      deviceId: z.string(),
      deviceType: z.enum(['smart_meter', 'inverter', 'battery_controller', 'sensor']),
      manufacturer: z.string().optional(),
      model: z.string().optional(),
      firmwareVersion: z.string().optional(),
      telemetryInterval: z.number().default(5),
    }))
    .mutation(async ({ input }) => {
      // Generate MQTT credentials
      const mqttClientId = `device-${input.assetId}-${Date.now()}`;
      const mqttUsername = input.deviceId;
      const mqttPassword = generateSecurePassword();

      let deviceId: number;
      try {
        deviceId = await devicesDb.createDevice({
          assetId: input.assetId,
          deviceId: input.deviceId,
          deviceType: input.deviceType,
          manufacturer: input.manufacturer,
          model: input.model,
          firmwareVersion: input.firmwareVersion,
          mqttClientId,
          mqttUsername,
          mqttPasswordHash: await hashPassword(mqttPassword),
          status: 'offline',
          telemetryInterval: input.telemetryInterval,
          enabled: true,
        });
      } catch (error) {
        // A device identifier is the credential's subject, so re-registering one
        // would either issue a second secret for a device the platform already
        // trusts or leak the raw SQL of the constraint that stopped it.
        if (!isUniqueViolation(error)) throw error;
        throw new TRPCError({
          code: 'CONFLICT',
          message:
            `Device '${input.deviceId}' is already registered. Its credential is issued once; ` +
            'rotate it on the existing device rather than registering it again.',
        });
      }

      // Log device registration
      await devicesDb.createDeviceLog({
        deviceId: deviceId,
        eventType: 'info',
        message: 'Device registered',
        metadata: JSON.stringify({ registeredBy: 'admin' }),
      });

      return {
        deviceId,
        mqttCredentials: {
          clientId: mqttClientId,
          username: mqttUsername,
          password: mqttPassword, // Only returned once during registration
        },
      };
    }),

  /**
   * Rotate a registered device's credential.
   *
   * Registration refuses to issue a second secret for a device the platform
   * already trusts and tells the operator to rotate instead, so this is the
   * route that makes that instruction actionable: the old secret stops
   * authenticating the moment the new hash is stored, and the rotation is
   * logged against the device it re-keyed.
   */
  rotateCredential: adminProcedure
    .input(z.object({ deviceId: z.string() }))
    .mutation(async ({ input }) => {
      const device = await devicesDb.getDeviceByDeviceId(input.deviceId);
      if (!device) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Device '${input.deviceId}' is not registered, so it has no credential to rotate.`,
        });
      }

      const mqttPassword = generateSecurePassword();
      const mqttClientId = `device-${device.assetId}-${Date.now()}`;
      await devicesDb.updateDevice(device.id, {
        mqttClientId,
        mqttUsername: device.deviceId,
        mqttPasswordHash: await hashPassword(mqttPassword),
      });

      await devicesDb.createDeviceLog({
        deviceId: device.id,
        eventType: 'info',
        message: 'Device credential rotated',
        metadata: JSON.stringify({ rotatedBy: 'admin' }),
      });

      return {
        deviceId: device.id,
        mqttCredentials: {
          clientId: mqttClientId,
          username: device.deviceId,
          password: mqttPassword, // Only returned once, at rotation
        },
      };
    }),

  /**
   * Update device
   */
  update: adminProcedure
    .input(z.object({
      id: z.number(),
      manufacturer: z.string().optional(),
      model: z.string().optional(),
      firmwareVersion: z.string().optional(),
      telemetryInterval: z.number().optional(),
      enabled: z.boolean().optional(),
    }))
    .mutation(async ({ input }) => {
      const { id, ...updates } = input;
      await devicesDb.updateDevice(id, updates);

      await devicesDb.createDeviceLog({
        deviceId: id,
        eventType: 'info',
        message: 'Device configuration updated',
      });

      return { success: true };
    }),

  /**
   * Delete device
   */
  delete: adminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      await devicesDb.deleteDevice(input.id);
      return { success: true };
    }),

  /**
   * Send command to device
   */
  sendCommand: adminProcedure
    .input(z.object({
      deviceId: z.number(),
      command: z.string(),
      payload: z.record(z.string(), z.any()).optional(),
    }))
    .mutation(async ({ input }) => {
      // Power-affecting commands must carry a validity window and a declared
      // fallback, which this generic path cannot express. Sending one here would
      // leave the device holding a setpoint no sweeper ever retires.
      if (SETPOINT_COMMANDS.has(input.command)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            `Command '${input.command}' changes power output and must be dispatched through ` +
            'controlWindows so it carries a validity window and a fallback.',
        });
      }

      const device = await devicesDb.getDeviceById(input.deviceId);
      if (!device) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Device not found',
        });
      }

      if (!device.enabled) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Device is disabled',
        });
      }

      // Create command record
      const commandId = await devicesDb.createDeviceCommand({
        deviceId: input.deviceId,
        command: input.command,
        payload: input.payload ? JSON.stringify(input.payload) : null,
      });

      // Send command via MQTT
      try {
        // Extract userId from asset
        const assetId = device.assetId;
        // Look up the owning user from the assets table
        const assetRecord = await getAssetById(assetId);
        const userId = assetRecord?.userId ?? null;
        if (!userId) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Could not resolve owner for asset ' + assetId,
          });
        }

        await mqttService.publishCommand(
          userId,
          assetId,
          input.command,
          input.payload || {}
        );

        await devicesDb.updateCommandStatus(commandId, 'sent');

        await devicesDb.createDeviceLog({
          deviceId: input.deviceId,
          eventType: 'info',
          message: `Command published to broker: ${input.command}`,
        });

        // The broker took the message; these devices send no acknowledgement, so
        // this is not evidence the command was executed.
        return { published: true, delivery: 'broker_queued' as const, commandId };
      } catch (error) {
        await devicesDb.updateCommandStatus(commandId, 'failed');
        
        await devicesDb.createDeviceLog({
          deviceId: input.deviceId,
          eventType: 'error',
          message: `Failed to send command: ${input.command}`,
          metadata: JSON.stringify({ error: String(error) }),
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to send command to device',
        });
      }
    }),

  /**
   * Get device commands history
   */
  getCommands: adminProcedure
    .input(z.object({
      deviceId: z.number(),
      limit: z.number().default(50),
    }))
    .query(async ({ input }) => {
      const commands = await devicesDb.getDeviceCommands(input.deviceId, input.limit);
      return { commands };
    }),

  /**
   * Get device logs
   */
  getLogs: adminProcedure
    .input(z.object({
      deviceId: z.number(),
      limit: z.number().default(100),
    }))
    .query(async ({ input }) => {
      const logs = await devicesDb.getDeviceLogs(input.deviceId, input.limit);
      return { logs };
    }),

  /**
   * Get device statistics
   */
  getStats: adminProcedure.query(async () => {
    return await devicesDb.getDeviceStats();
  }),
});

/**
 * Look up an asset row by its primary key.
 */
async function getAssetById(assetId: number): Promise<{ userId: number } | null> {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db.select({ userId: assets.userId }).from(assets).where(eq(assets.id, assetId)).limit(1);
  return row ?? null;
}

/**
 * Generate a cryptographically secure random password (32 bytes → 64 hex chars).
 */
function generateSecurePassword(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Hash a password using scrypt with a random salt.
 * Returns a "salt:hash" string that can be stored and later verified.
 */
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = await scryptAsync(password, salt, 64) as Buffer;
  return `${salt}:${derivedKey.toString('hex')}`;
}
