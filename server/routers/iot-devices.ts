import { z } from 'zod';
import { protectedProcedure, router } from '../_core/trpc';
import { mqttBrokerService } from '../integration/mqtt-broker';
import { getDb } from '../db';
import { telemetry, assets } from '../../drizzle/schema';
import { eq, desc, and, gte } from 'drizzle-orm';

export const iotDevicesRouter = router({
  /**
   * Get real-time telemetry for an asset
   */
  getLatestTelemetry: protectedProcedure
    .input(z.object({
      assetId: z.number(),
      limit: z.number().min(1).max(100).default(10),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) {
        throw new Error('Database not available');
      }

      const readings = await db
        .select()
        .from(telemetry)
        .where(eq(telemetry.assetId, input.assetId))
        .orderBy(desc(telemetry.timestamp))
        .limit(input.limit);

      return readings;
    }),

  /**
   * Get telemetry for a time range
   */
  getTelemetryRange: protectedProcedure
    .input(z.object({
      assetId: z.number(),
      startTime: z.date(),
      endTime: z.date(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) {
        throw new Error('Database not available');
      }

      const readings = await db
        .select()
        .from(telemetry)
        .where(
          and(
            eq(telemetry.assetId, input.assetId),
            gte(telemetry.timestamp, input.startTime)
          )
        )
        .orderBy(telemetry.timestamp);

      return readings.filter(r => r.timestamp <= input.endTime);
    }),

  /**
   * Get aggregated telemetry statistics
   */
  getTelemetryStats: protectedProcedure
    .input(z.object({
      assetId: z.number(),
      hours: z.number().min(1).max(720).default(24),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) {
        throw new Error('Database not available');
      }

      const startTime = new Date(Date.now() - input.hours * 3600000);

      const readings = await db
        .select()
        .from(telemetry)
        .where(
          and(
            eq(telemetry.assetId, input.assetId),
            gte(telemetry.timestamp, startTime)
          )
        );

      if (readings.length === 0) {
        return {
          avgPower: 0,
          maxPower: 0,
          minPower: 0,
          totalEnergy: 0,
          readingsCount: 0,
        };
      }

      const powers = readings.map(r => r.power).filter(p => p !== null) as number[];
      const energies = readings.map(r => r.energy).filter(e => e !== null) as number[];

      return {
        avgPower: powers.length > 0 ? powers.reduce((a, b) => a + b, 0) / powers.length : 0,
        maxPower: powers.length > 0 ? Math.max(...powers) : 0,
        minPower: powers.length > 0 ? Math.min(...powers) : 0,
        totalEnergy: energies.length > 0 ? energies.reduce((a, b) => a + b, 0) : 0,
        readingsCount: readings.length,
      };
    }),

  /**
   * Send command to IoT device
   */
  sendCommand: protectedProcedure
    .input(z.object({
      deviceId: z.string(),
      command: z.enum(['start', 'stop', 'restart', 'update_config', 'request_status']),
      params: z.record(z.string(), z.any()).optional(),
    }))
    .mutation(async ({ input }) => {
      if (!mqttBrokerService.isConnected()) {
        throw new Error('MQTT broker not connected');
      }

      await mqttBrokerService.publishCommand(
        input.deviceId,
        input.command,
        input.params
      );

      return {
        success: true,
        message: `Command ${input.command} sent to device ${input.deviceId}`,
      };
    }),

  /**
   * Get MQTT broker status
   */
  getBrokerStatus: protectedProcedure
    .query(() => {
      return {
        connected: mqttBrokerService.isConnected(),
        timestamp: new Date(),
      };
    }),

  /**
   * Get device health status
   */
  getDeviceHealth: protectedProcedure
    .input(z.object({
      assetId: z.number(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) {
        throw new Error('Database not available');
      }

      // Get latest reading
      const latestReading = await db
        .select()
        .from(telemetry)
        .where(eq(telemetry.assetId, input.assetId))
        .orderBy(desc(telemetry.timestamp))
        .limit(1);

      if (latestReading.length === 0) {
        return {
          status: 'unknown',
          lastSeen: null,
          message: 'No telemetry data available',
        };
      }

      const reading = latestReading[0];
      const lastSeenMinutes = (Date.now() - reading.timestamp.getTime()) / 60000;

      let status: 'online' | 'offline' | 'warning' = 'online';
      let message = 'Device is operating normally';

      if (lastSeenMinutes > 15) {
        status = 'offline';
        message = `Device offline for ${Math.floor(lastSeenMinutes)} minutes`;
      } else if (lastSeenMinutes > 5) {
        status = 'warning';
        message = `No data received for ${Math.floor(lastSeenMinutes)} minutes`;
      }

      // Check for anomalies
      if (reading.temperature && reading.temperature > 80) {
        status = 'warning';
        message = `High temperature detected: ${reading.temperature}°C`;
      }

      return {
        status,
        lastSeen: reading.timestamp,
        message,
        latestReading: {
          power: reading.power,
          energy: reading.energy,
          voltage: reading.voltage,
          current: reading.current,
          temperature: reading.temperature,
        },
      };
    }),

  /**
   * Get all assets with device health
   */
  getAllDevicesHealth: protectedProcedure
    .query(async ({ ctx }) => {
      const db = await getDb();
      if (!db) {
        throw new Error('Database not available');
      }

      // Get user's assets
      const userAssets = await db
        .select()
        .from(assets)
        .where(eq(assets.userId, ctx.user.id));

      // Get latest telemetry for each asset
      const devicesHealth = await Promise.all(
        userAssets.map(async (asset) => {
          const latestReading = await db
            .select()
            .from(telemetry)
            .where(eq(telemetry.assetId, asset.id))
            .orderBy(desc(telemetry.timestamp))
            .limit(1);

          let status: 'online' | 'offline' | 'warning' | 'unknown' = 'unknown';
          let lastSeen: Date | null = null;

          if (latestReading.length > 0) {
            const reading = latestReading[0];
            lastSeen = reading.timestamp;
            const lastSeenMinutes = (Date.now() - reading.timestamp.getTime()) / 60000;

            if (lastSeenMinutes > 15) {
              status = 'offline';
            } else if (lastSeenMinutes > 5) {
              status = 'warning';
            } else {
              status = 'online';
            }
          }

          return {
            assetId: asset.id,
            assetName: asset.name,
            assetType: asset.assetType,
            status,
            lastSeen,
          };
        })
      );

      return devicesHealth;
    }),
});
