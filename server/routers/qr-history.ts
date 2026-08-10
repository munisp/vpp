import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  recordQRScan,
  recordQRGeneration,
  getUserQRHistory,
  updateQRStatus,
  getUserQRStats,
} from "../db-qr-history";

export const qrHistoryRouter = router({
  /**
   * Get user's QR code history
   */
  getMyHistory: protectedProcedure
    .input(z.object({ limit: z.number().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const history = await getUserQRHistory(ctx.user.id, input?.limit);
      return history;
    }),

  /**
   * Get user's QR code statistics
   */
  getMyStats: protectedProcedure.query(async ({ ctx }) => {
    const stats = await getUserQRStats(ctx.user.id);
    return stats;
  }),

  /**
   * Record a QR code scan
   */
  recordScan: protectedProcedure
    .input(
      z.object({
        paymentType: z.enum(["merchant", "p2p", "bill", "token"]),
        amount: z.string(),
        currency: z.string(),
        qrCodeData: z.string(),
        merchantId: z.string().optional(),
        merchantName: z.string().optional(),
        recipientId: z.string().optional(),
        recipientName: z.string().optional(),
        billId: z.string().optional(),
        billType: z.string().optional(),
        reference: z.string().optional(),
        description: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await recordQRScan({
        userId: ctx.user.id,
        ...input,
      });
      return { success: true };
    }),

  /**
   * Record a QR code generation
   */
  recordGeneration: protectedProcedure
    .input(
      z.object({
        paymentType: z.enum(["merchant", "p2p", "bill", "token"]),
        amount: z.string(),
        currency: z.string(),
        qrCodeData: z.string(),
        qrCodeImage: z.string().optional(),
        merchantId: z.string().optional(),
        merchantName: z.string().optional(),
        recipientId: z.string().optional(),
        recipientName: z.string().optional(),
        billId: z.string().optional(),
        billType: z.string().optional(),
        reference: z.string().optional(),
        description: z.string().optional(),
        expiresAt: z.date().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await recordQRGeneration({
        userId: ctx.user.id,
        ...input,
      });
      return { success: true };
    }),

  /**
   * Update QR code transaction status
   */
  updateStatus: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        status: z.enum(["pending", "completed", "failed", "expired"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await updateQRStatus(input.id, ctx.user.id, input.status);
      return { success: true };
    }),
});
