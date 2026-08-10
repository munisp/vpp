import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { getYieldForecast, getPerformanceRatio, getUnderperformingAssets } from "../services/solar-yield";
import { getAssetById, getUserAssets } from "../db";

async function assertAssetAccess(assetId: number, user: { id: number; role: string }) {
  const asset = await getAssetById(assetId);
  if (!asset) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Asset not found." });
  }
  if (asset.userId !== user.id && user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "You do not have access to this asset." });
  }
  return asset;
}

/**
 * Weather-aware solar yield forecasting router (feature 12).
 */
export const solarYieldRouter = router({
  /**
   * 3-day expected yield forecast for a solar asset.
   */
  getYieldForecast: protectedProcedure
    .input(z.object({ assetId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await assertAssetAccess(input.assetId, ctx.user);
      try {
        return await getYieldForecast(input.assetId);
      } catch (error: any) {
        console.error("[SolarYield] getYieldForecast failed:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error?.message || "Failed to compute yield forecast.",
        });
      }
    }),

  /**
   * Learned performance ratio analysis for a solar asset.
   */
  getPerformanceRatio: protectedProcedure
    .input(z.object({ assetId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await assertAssetAccess(input.assetId, ctx.user);
      try {
        return await getPerformanceRatio(input.assetId);
      } catch (error: any) {
        console.error("[SolarYield] getPerformanceRatio failed:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error?.message || "Failed to compute performance ratio.",
        });
      }
    }),

  /**
   * Underperforming solar assets. Users see their own; admins see the fleet.
   */
  getUnderperformingAssets: protectedProcedure.query(async ({ ctx }) => {
    try {
      if (ctx.user.role === "admin") {
        const flagged = await getUnderperformingAssets();
        return { assets: flagged, count: flagged.length, scope: "fleet" as const };
      }
      const myAssets = await getUserAssets(ctx.user.id);
      const solarIds = myAssets.filter((a) => a.assetType === "solar").map((a) => a.id);
      if (solarIds.length === 0) {
        return { assets: [], count: 0, scope: "own" as const };
      }
      const flagged = await getUnderperformingAssets(solarIds);
      return { assets: flagged, count: flagged.length, scope: "own" as const };
    } catch (error) {
      console.error("[SolarYield] getUnderperformingAssets failed:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to evaluate assets." });
    }
  }),
});
