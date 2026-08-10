import { z } from 'zod';
import { router, protectedProcedure, adminProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import { getDb } from '../db';
import { assets } from '../../drizzle/schema';
import { anomalyEvents } from '../../drizzle/nextgen-vpp-schema';
import { eq, and } from 'drizzle-orm';
import { gridAnomalyEarlyWarning } from '../services/grid-anomaly';

/**
 * Grid anomaly early-warning router.
 * Statistical early-warning scoring (rolling z-score vs per-asset hour-of-day
 * baselines) over real telemetry, persisted anomaly events, web-push fan-out.
 */
export const gridAnomalyRouter = router({
  /**
   * Run the early-warning scan for one asset the caller owns (or any asset for admins).
   */
  scanAsset: protectedProcedure
    .input(z.object({
      assetId: z.number().int().positive(),
      windowMinutes: z.number().int().min(5).max(240).default(30),
    }))
    .mutation(async ({ ctx, input }) => {
      await assertAssetAccess(input.assetId, ctx.user.id, ctx.user.role);
      try {
        return await gridAnomalyEarlyWarning.scanAsset(input.assetId, input.windowMinutes);
      } catch (error: any) {
        console.error('[GridAnomaly] scanAsset error:', error);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message || 'Asset scan failed' });
      }
    }),

  /**
   * Fleet-wide early-warning sweep over all active assets (admin).
   */
  scanFleet: adminProcedure
    .input(z.object({ windowMinutes: z.number().int().min(5).max(240).default(30) }))
    .mutation(async ({ input }) => {
      try {
        return await gridAnomalyEarlyWarning.scanFleet(input.windowMinutes);
      } catch (error: any) {
        console.error('[GridAnomaly] scanFleet error:', error);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message || 'Fleet scan failed' });
      }
    }),

  /**
   * Persisted anomaly events for one asset (owner or admin).
   */
  getAssetAnomalies: protectedProcedure
    .input(z.object({
      assetId: z.number().int().positive(),
      limit: z.number().int().positive().max(200).default(50),
    }))
    .query(async ({ ctx, input }) => {
      await assertAssetAccess(input.assetId, ctx.user.id, ctx.user.role);
      try {
        const anomalies = await gridAnomalyEarlyWarning.getAssetAnomalies(input.assetId, input.limit);
        return { anomalies, count: anomalies.length };
      } catch (error: any) {
        console.error('[GridAnomaly] getAssetAnomalies error:', error);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to retrieve asset anomalies' });
      }
    }),

  /**
   * Fleet-wide anomaly summary (admin).
   */
  getFleetAnomalySummary: adminProcedure.query(async () => {
    try {
      return await gridAnomalyEarlyWarning.getFleetAnomalySummary();
    } catch (error: any) {
      console.error('[GridAnomaly] getFleetAnomalySummary error:', error);
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to compute fleet anomaly summary' });
    }
  }),

  /**
   * Acknowledge an anomaly event (asset owner or admin).
   */
  acknowledgeAnomaly: protectedProcedure
    .input(z.object({ anomalyId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database not available' });

      const rows = await db
        .select({ assetId: anomalyEvents.assetId })
        .from(anomalyEvents)
        .where(eq(anomalyEvents.id, input.anomalyId))
        .limit(1);
      if (!rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'Anomaly event not found' });
      await assertAssetAccess(rows[0].assetId, ctx.user.id, ctx.user.role);

      try {
        const anomaly = await gridAnomalyEarlyWarning.acknowledgeAnomaly(input.anomalyId, ctx.user.id);
        return { success: true, anomaly };
      } catch (error: any) {
        console.error('[GridAnomaly] acknowledgeAnomaly error:', error);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message || 'Failed to acknowledge anomaly' });
      }
    }),
});

async function assertAssetAccess(assetId: number, userId: number, role: string): Promise<void> {
  if (role === 'admin') return;
  const db = await getDb();
  if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database not available' });
  const rows = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.userId, userId)))
    .limit(1);
  if (!rows[0]) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not own this asset' });
  }
}
