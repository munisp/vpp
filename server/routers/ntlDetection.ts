import { z } from "zod";
import { router, protectedProcedure, adminProcedure } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import {
  getNtlFlags,
  investigateFlag,
  getAssetRiskScore,
  runNtlAnalysis,
  runFleetNtlAnalysis,
} from "../services/ntl-detection";
import { getAssetById } from "../db";

const NtlStatusSchema = z.enum(["suspected", "under_review", "confirmed", "cleared"]);

/**
 * Non-technical-loss (theft/bypass) detection router (feature 13).
 * Flags are human-reviewed: suspected -> under_review -> confirmed | cleared.
 */
export const ntlDetectionRouter = router({
  /**
   * Admin: list NTL flags with filters.
   */
  getFlags: adminProcedure
    .input(
      z.object({
        status: NtlStatusSchema.optional(),
        assetId: z.number().int().positive().optional(),
        userId: z.number().int().positive().optional(),
        limit: z.number().int().positive().max(500).default(100),
      })
    )
    .query(async ({ input }) => {
      try {
        const flags = await getNtlFlags(input);
        return { flags, count: flags.length };
      } catch (error) {
        console.error("[NtlDetection] getFlags failed:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to list NTL flags." });
      }
    }),

  /**
   * Admin: transition a flag through the investigation workflow.
   */
  investigateFlag: adminProcedure
    .input(
      z.object({
        flagId: z.number().int().positive(),
        newStatus: NtlStatusSchema,
        notes: z.string().max(2000).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const flag = await investigateFlag({
          flagId: input.flagId,
          newStatus: input.newStatus,
          investigatorUserId: ctx.user.id,
          notes: input.notes,
        });
        return { success: true, flag };
      } catch (error: any) {
        console.error("[NtlDetection] investigateFlag failed:", error);
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: error?.message || "Failed to update NTL flag.",
        });
      }
    }),

  /**
   * Risk score for an asset. Owners can read their own assets; admins any.
   */
  getAssetRiskScore: protectedProcedure
    .input(z.object({ assetId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const asset = await getAssetById(input.assetId);
      if (!asset) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Asset not found." });
      }
      if (asset.userId !== ctx.user.id && ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "You do not have access to this asset." });
      }
      try {
        return await getAssetRiskScore(input.assetId);
      } catch (error) {
        console.error("[NtlDetection] getAssetRiskScore failed:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to compute risk score." });
      }
    }),

  /**
   * Admin: run divergence analysis for one asset or the whole fleet.
   */
  runAnalysis: adminProcedure
    .input(z.object({ assetId: z.number().int().positive().optional() }))
    .mutation(async ({ input }) => {
      try {
        if (input.assetId) {
          const result = await runNtlAnalysis(input.assetId);
          return { scope: "asset" as const, result };
        }
        const result = await runFleetNtlAnalysis();
        return { scope: "fleet" as const, result };
      } catch (error) {
        console.error("[NtlDetection] runAnalysis failed:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to run NTL analysis." });
      }
    }),
});
