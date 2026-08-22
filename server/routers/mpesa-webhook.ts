import { router, adminProcedure } from "../_core/trpc";
import { z } from "zod";
import { mpesaService } from "../services/mpesa-service";

/**
 * M-Pesa Webhook Router
 *
 * Administrative M-Pesa operations only.
 *
 * The payment callback is NOT exposed here. Gateway callbacks settle money, so
 * they are only accepted on POST /api/webhooks/mpesa, which verifies the
 * provider's HMAC signature before any payment state changes. An unauthenticated
 * tRPC mutation would let anyone mark an arbitrary payment completed by
 * replaying a CheckoutRequestID.
 */
export const mpesaWebhookRouter = router({
  /**
   * Test M-Pesa integration (admin only: triggers a real STK push)
   */
  testPayment: adminProcedure
    .input(
      z.object({
        phoneNumber: z.string(),
        amount: z.number().min(1),
        accountReference: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      const result = await mpesaService.initiatePayment({
        phoneNumber: input.phoneNumber,
        amount: input.amount,
        accountReference: input.accountReference,
        transactionDesc: 'Test Payment',
      });

      return result;
    }),

  /**
   * Query payment status (admin only: queries the live M-Pesa gateway)
   */
  queryStatus: adminProcedure
    .input(
      z.object({
        checkoutRequestId: z.string(),
      })
    )
    .query(async ({ input }) => {
      const result = await mpesaService.queryPaymentStatus(input.checkoutRequestId);
      return result;
    }),
});
