import { z } from "zod";
import { router, protectedProcedure, adminProcedure } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { getUserSmsLog, listSmsCommands } from "../services/sms-commands";

/**
 * SMS Command Channel router (feature 11).
 * The inbound webhook itself lives in server/webhooks/sms-inbound.ts and is
 * mounted by the lead in server/_core/index.ts.
 */
export const smsCommandsRouter = router({
  /**
   * List the caller's own SMS command history.
   */
  getMySmsLog: protectedProcedure
    .input(z.object({ limit: z.number().int().positive().max(100).default(20) }))
    .query(async ({ ctx, input }) => {
      try {
        const entries = await getUserSmsLog(ctx.user.id, input.limit);
        return { entries, count: entries.length };
      } catch (error) {
        console.error("[SmsCommands] getMySmsLog failed:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to retrieve SMS log." });
      }
    }),

  /**
   * Admin: list all SMS commands with optional filters.
   */
  listCommands: adminProcedure
    .input(
      z.object({
        limit: z.number().int().positive().max(500).default(100),
        parsedCommand: z.enum(["BALANCE", "STATUS", "TOKEN_LAST", "OUTAGE", "HELP", "UNKNOWN"]).optional(),
        phoneNumber: z.string().max(20).optional(),
        resolvedVia: z.enum(["users_phone", "payments_phone", "unresolved"]).optional(),
      })
    )
    .query(async ({ input }) => {
      try {
        const entries = await listSmsCommands(input);
        return { entries, count: entries.length };
      } catch (error) {
        console.error("[SmsCommands] listCommands failed:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to list SMS commands." });
      }
    }),
});
