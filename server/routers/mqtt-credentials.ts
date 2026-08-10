/**
 * MQTT Broker Credentials Router
 * 
 * Admin endpoints for managing MQTT broker connection credentials
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import * as mqttCredDb from './mqtt-credentials-db';

export const mqttCredentialsRouter = router({
  /**
   * Get MQTT broker credentials
   */
  getCredentials: protectedProcedure
    .input(z.object({
      environment: z.enum(['sandbox', 'production']).default('production'),
    }))
    .query(async ({ input, ctx }) => {
      // Only admins can access credentials
      if (ctx.user.role !== 'admin') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Admin access required' });
      }

      const credentials = await mqttCredDb.getMQTTCredentials(input.environment);
      
      if (!credentials) {
        return null;
      }

      // Mask sensitive data for display
      return {
        ...credentials,
        password: credentials.password ? '********' : undefined,
        key: credentials.key ? '********' : undefined,
      };
    }),

  /**
   * Save MQTT broker credentials
   */
  saveCredentials: protectedProcedure
    .input(z.object({
      environment: z.enum(['sandbox', 'production']),
      credentials: z.object({
        host: z.string().min(1),
        port: z.number().int().min(1).max(65535),
        protocol: z.enum(['mqtt', 'mqtts', 'ws', 'wss']),
        username: z.string().optional(),
        password: z.string().optional(),
        clientId: z.string().optional(),
        clean: z.boolean().optional(),
        keepalive: z.number().int().optional(),
        reconnectPeriod: z.number().int().optional(),
        connectTimeout: z.number().int().optional(),
        ca: z.string().optional(),
        cert: z.string().optional(),
        key: z.string().optional(),
      }),
      isActive: z.boolean().default(true),
    }))
    .mutation(async ({ input, ctx }) => {
      // Only admins can save credentials
      if (ctx.user.role !== 'admin') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Admin access required' });
      }

      const success = await mqttCredDb.saveMQTTCredentials(
        input.credentials,
        input.environment,
        input.isActive
      );

      if (!success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to save MQTT credentials',
        });
      }

      return { success: true };
    }),

  /**
   * Test MQTT broker connection
   */
  testConnection: protectedProcedure
    .input(z.object({
      credentials: z.object({
        host: z.string().min(1),
        port: z.number().int().min(1).max(65535),
        protocol: z.enum(['mqtt', 'mqtts', 'ws', 'wss']),
        username: z.string().optional(),
        password: z.string().optional(),
        clientId: z.string().optional(),
        connectTimeout: z.number().int().optional(),
      }),
    }))
    .mutation(async ({ input, ctx }) => {
      // Only admins can test connections
      if (ctx.user.role !== 'admin') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Admin access required' });
      }

      const result = await mqttCredDb.testMQTTConnection(input.credentials);
      return result;
    }),

  /**
   * Delete MQTT broker credentials
   */
  deleteCredentials: protectedProcedure
    .input(z.object({
      environment: z.enum(['sandbox', 'production']),
    }))
    .mutation(async ({ input, ctx }) => {
      // Only admins can delete credentials
      if (ctx.user.role !== 'admin') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Admin access required' });
      }

      const success = await mqttCredDb.deleteMQTTCredentials(input.environment);

      if (!success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to delete MQTT credentials',
        });
      }

      return { success: true };
    }),
});
