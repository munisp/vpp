import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { generatePaymentQRCode, parsePaymentQRCode } from "../_core/qrcode";

export const qrcodeRouter = router({
  /**
   * Generate a payment QR code
   */
  generate: protectedProcedure
    .input(
      z.object({
        type: z.enum(["merchant", "p2p", "bill", "token"]),
        amount: z.number().positive(),
        currency: z.enum(["NGN", "TZS", "USD"]),
        merchantId: z.string().optional(),
        merchantName: z.string().optional(),
        recipientId: z.string().optional(),
        recipientName: z.string().optional(),
        billId: z.string().optional(),
        billType: z.string().optional(),
        description: z.string().optional(),
        expiresIn: z.number().optional(), // seconds
      })
    )
    .mutation(async ({ input }) => {
      const qrData = await generatePaymentQRCode(input);
      return qrData;
    }),

  /**
   * Parse and validate a QR code
   */
  parse: protectedProcedure
    .input(z.object({ qrData: z.string() }))
    .mutation(async ({ input }) => {
      const parsed = await parsePaymentQRCode(input.qrData);
      return parsed;
    }),
});
