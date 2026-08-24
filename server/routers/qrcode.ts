import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  generateSignedPaymentQRCode,
  parsePaymentQRCode,
  qrSigningConfigured,
} from "../_core/qrcode";

/**
 * A deployment with no signing key cannot issue a payment code, and must say so
 * rather than return a generic failure a client would retry.
 */
function requireSigning(): void {
  if (!qrSigningConfigured()) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Payment QR codes are unavailable on this deployment: QR_SIGNING_SECRET is not configured, and an unsigned payment code would be attacker-controllable.",
    });
  }
}

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
    .mutation(async ({ ctx, input }) => {
      // The signature attests who asked for the code, not that the encoded
      // merchant/recipient belongs to them: consumers must still authorize the
      // payee against issuedByUserId before moving money.
      requireSigning();
      const generated = await generateSignedPaymentQRCode({
        ...input,
        issuedByUserId: ctx.user.id,
      });
      // The payload goes back with the image: the caller has to store and
      // re-present the bytes a scanner would read, not a summary of them.
      return {
        image: generated.image,
        payload: generated.payload,
        reference: generated.reference,
        expiresAt: generated.expiresAt.toISOString(),
      };
    }),

  /**
   * Parse and validate a QR code
   */
  parse: protectedProcedure
    .input(z.object({ qrData: z.string() }))
    .mutation(async ({ input }) => {
      requireSigning();
      const parsed = await parsePaymentQRCode(input.qrData);
      return parsed;
    }),
});
