import { z } from "zod";
import { router, protectedProcedure, adminProcedure } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { generateReport, listReports, getReportChecksum } from "../services/compliance-reports";
import { generateFranchiseReport, listFranchiseReports } from "../services/nerc-franchise-reports";

/**
 * Regulator-ready compliance PDF reports router (feature 15).
 */
export const complianceReportsRouter = router({
  /**
   * Admin: generate a date-ranged compliance report. Returns the PDF as
   * base64 plus the SHA-256 checksum of its canonical JSON source data.
   */
  generateReport: adminProcedure
    .input(
      z.object({
        periodStart: z.coerce.date(),
        periodEnd: z.coerce.date(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await generateReport({
          generatedBy: ctx.user.id,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
        });
      } catch (error: any) {
        console.error("[ComplianceReports] generateReport failed:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error?.message || "Failed to generate compliance report.",
        });
      }
    }),

  /**
   * Admin: list previously generated reports (metadata + checksums).
   */
  listReports: adminProcedure
    .input(z.object({ limit: z.number().int().positive().max(200).default(50) }))
    .query(async ({ input }) => {
      try {
        const reports = await listReports(input.limit);
        return { reports, count: reports.length };
      } catch (error) {
        console.error("[ComplianceReports] listReports failed:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to list reports." });
      }
    }),

  /**
   * Admin: generate a NERC franchise technical + commercial reporting pack for
   * a licensed franchise area. Returns the PDF as base64 plus the SHA-256
   * checksum of its canonical JSON source data. Unknowns are reported as
   * null + reason — never assumed values.
   */
  generateFranchiseReport: adminProcedure
    .input(
      z
        .object({
          periodStart: z.coerce.date(),
          periodEnd: z.coerce.date(),
          franchiseAreaName: z.string().min(1),
        })
        .refine((v) => v.periodEnd > v.periodStart, {
          message: "periodEnd must be after periodStart",
          path: ["periodEnd"],
        })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await generateFranchiseReport({
          generatedBy: ctx.user.id,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          franchiseAreaName: input.franchiseAreaName,
        });
      } catch (error: any) {
        console.error("[ComplianceReports] generateFranchiseReport failed:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error?.message || "Failed to generate franchise report.",
        });
      }
    }),

  /**
   * Admin: list previously generated franchise reports (metadata + checksums).
   */
  listFranchiseReports: adminProcedure
    .input(z.object({ limit: z.number().int().positive().max(200).default(50) }))
    .query(async ({ input }) => {
      try {
        const reports = await listFranchiseReports(input.limit);
        return { reports, count: reports.length };
      } catch (error) {
        console.error("[ComplianceReports] listFranchiseReports failed:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to list franchise reports." });
      }
    }),

  /**
   * Verify a report's integrity: recompute the checksum of the stored
   * canonical source JSON and compare. Available to any authenticated user
   * (e.g. an external auditor with credentials).
   */
  getReportChecksum: protectedProcedure
    .input(z.object({ reportId: z.number().int().positive() }))
    .query(async ({ input }) => {
      try {
        return await getReportChecksum(input.reportId);
      } catch (error: any) {
        const notFound = typeof error?.message === "string" && error.message.includes("not found");
        throw new TRPCError({
          code: notFound ? "NOT_FOUND" : "INTERNAL_SERVER_ERROR",
          message: error?.message || "Failed to verify report checksum.",
        });
      }
    }),
});
