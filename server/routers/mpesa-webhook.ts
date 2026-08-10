import { router, publicProcedure } from "../_core/trpc";
import { z } from "zod";
import { mpesaService } from "../services/mpesa-service";
import { getDb } from "../db";
import { payments } from "../../drizzle/schema";
import { eq } from "drizzle-orm";

/**
 * M-Pesa Webhook Router
 * 
 * Handles payment callbacks from M-Pesa
 */
export const mpesaWebhookRouter = router({
  /**
   * M-Pesa STK Push Callback
   * This endpoint receives payment notifications from M-Pesa
   */
  callback: publicProcedure
    .input(
      z.object({
        Body: z.object({
          stkCallback: z.object({
            MerchantRequestID: z.string(),
            CheckoutRequestID: z.string(),
            ResultCode: z.number(),
            ResultDesc: z.string(),
            CallbackMetadata: z
              .object({
                Item: z.array(
                  z.object({
                    Name: z.string(),
                    Value: z.any(),
                  })
                ),
              })
              .optional(),
          }),
        }),
      })
    )
    .mutation(async ({ input }) => {
      console.log('[MPesa Webhook] Received callback:', JSON.stringify(input, null, 2));

      try {
        // Process the callback
        const result = await mpesaService.processCallback(input);

        // Update payment status in database
        const db = await getDb();
        if (!db) {
          console.error('[MPesa Webhook] Database not available');
          return {
            ResultCode: 0,
            ResultDesc: 'Accepted',
          };
        }

        // Find payment by checkout request ID
        const paymentRecords = await db
          .select()
          .from(payments)
          .where(eq(payments.transactionId, result.checkoutRequestId))
          .limit(1);

        if (paymentRecords.length === 0) {
          console.warn('[MPesa Webhook] Payment not found for checkout request:', result.checkoutRequestId);
          return {
            ResultCode: 0,
            ResultDesc: 'Accepted',
          };
        }

        const payment = paymentRecords[0];

        // Update payment status
        if (result.success) {
          await db
            .update(payments)
            .set({
              status: 'completed',
              metadata: JSON.stringify({
                merchantRequestId: result.merchantRequestId,
                checkoutRequestId: result.checkoutRequestId,
                mpesaReceiptNumber: result.mpesaReceiptNumber,
                transactionDate: result.transactionDate,
                phoneNumber: result.phoneNumber,
                amount: result.amount,
              }),
            })
            .where(eq(payments.id, payment.id));

          console.log('[MPesa Webhook] Payment completed:', {
            paymentId: payment.id,
            receipt: result.mpesaReceiptNumber,
            amount: result.amount,
          });

          // TODO: Trigger post-payment actions
          // - Generate energy tokens
          // - Send confirmation notification
          // - Update billing status
        } else {
          await db
            .update(payments)
            .set({
              status: 'failed',
              metadata: JSON.stringify({
                merchantRequestId: result.merchantRequestId,
                checkoutRequestId: result.checkoutRequestId,
                resultCode: result.resultCode,
                resultDesc: result.resultDesc,
              }),
            })
            .where(eq(payments.id, payment.id));

          console.log('[MPesa Webhook] Payment failed:', {
            paymentId: payment.id,
            resultCode: result.resultCode,
            resultDesc: result.resultDesc,
          });

          // TODO: Send failure notification
        }

        // Acknowledge receipt to M-Pesa
        return {
          ResultCode: 0,
          ResultDesc: 'Accepted',
        };
      } catch (error) {
        console.error('[MPesa Webhook] Error processing callback:', error);
        
        // Still acknowledge to M-Pesa to avoid retries
        return {
          ResultCode: 0,
          ResultDesc: 'Accepted',
        };
      }
    }),

  /**
   * Test M-Pesa integration
   */
  testPayment: publicProcedure
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
   * Query payment status
   */
  queryStatus: publicProcedure
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
