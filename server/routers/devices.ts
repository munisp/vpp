/**
 * Device Management Router
 * Admin-only endpoints for IoT device management
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { adminProcedure, router } from '../_core/trpc';
import * as devicesDb from '../devices-db';
import { mqttService } from '../_core/mqtt';

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

      const deviceId = await devicesDb.createDevice({
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
        // For now, use a placeholder userId - in production, look up from assets table
        const userId = 1;

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
          message: `Command sent: ${input.command}`,
        });

        return { success: true, commandId };
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
 * Generate secure random password
 */
function generateSecurePassword(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  let password = '';
  for (let i = 0; i < 32; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

/**
 * Hash password (simple implementation - use bcrypt in production)
 */
function hashPassword(password: string): string {
  // In production, use bcrypt or similar
  // For demo, just return a placeholder
  return `hashed_${password}`;
}
