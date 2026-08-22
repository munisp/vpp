import { z } from 'zod';
import { router, protectedProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import * as db from '../db';
import { authenticateDeviceForAsset } from '../_core/deviceAuth';

const InsertTelemetryInputSchema = z.object({
  assetId: z.number().int().positive(),
  power: z.number().int().optional(),
  energy: z.number().int().optional(),
  voltage: z.number().int().optional(),
  current: z.number().int().optional(),
  frequency: z.number().int().optional(),
  stateOfCharge: z.number().int().min(0).max(10000).optional(),
  temperature: z.number().int().optional(),
  metadata: z.string().optional(),
});

const GetLatestInputSchema = z.object({
  assetId: z.number().int().positive(),
});

const GetHistoricalInputSchema = z.object({
  assetId: z.number().int().positive(),
  startTime: z.date().or(z.string().datetime()),
  endTime: z.date().or(z.string().datetime()),
});

export const telemetryRouter = router({
  /**
   * Ingest a measurement. Telemetry is a settlement input, so the caller must
   * present the credential of a device registered to the asset; an asset owner
   * cannot self-report the energy they are paid for.
   */
  insert: protectedProcedure
    .input(InsertTelemetryInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        // Verify asset belongs to user
        const asset = await db.getAssetById(input.assetId);
        if (!asset || asset.userId !== ctx.user.id) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Asset not found.',
          });
        }

        const deviceAuth = await authenticateDeviceForAsset(ctx.req, input.assetId);
        if (!deviceAuth.ok) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: deviceAuth.reason,
          });
        }

        await db.insertTelemetry({
          assetId: input.assetId,
          timestamp: new Date(),
          power: input.power,
          energy: input.energy,
          voltage: input.voltage,
          current: input.current,
          frequency: input.frequency,
          stateOfCharge: input.stateOfCharge,
          temperature: input.temperature,
          metadata: input.metadata,
        });

        return {
          success: true,
          message: 'Telemetry data inserted successfully.',
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error('Error inserting telemetry:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to insert telemetry data.',
        });
      }
    }),

  getLatest: protectedProcedure
    .input(GetLatestInputSchema)
    .query(async ({ ctx, input }) => {
      try {
        // Verify asset belongs to user
        const asset = await db.getAssetById(input.assetId);
        if (!asset || asset.userId !== ctx.user.id) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Asset not found.',
          });
        }

        const telemetry = await db.getLatestTelemetry(input.assetId);
        return telemetry || null;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error('Error getting latest telemetry:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to retrieve telemetry data.',
        });
      }
    }),

  getHistorical: protectedProcedure
    .input(GetHistoricalInputSchema)
    .query(async ({ ctx, input }) => {
      try {
        // Verify asset belongs to user
        const asset = await db.getAssetById(input.assetId);
        if (!asset || asset.userId !== ctx.user.id) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Asset not found.',
          });
        }

        const startTime = new Date(input.startTime);
        const endTime = new Date(input.endTime);

        if (startTime >= endTime) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Start time must be before end time.',
          });
        }

        const telemetry = await db.getTelemetryRange(input.assetId, startTime, endTime);
        return telemetry;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error('Error getting historical telemetry:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to retrieve historical telemetry data.',
        });
      }
    }),
});

export type TelemetryRouter = typeof telemetryRouter;
