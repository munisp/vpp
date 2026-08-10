import { router, publicProcedure, adminProcedure } from "../_core/trpc";
import { z } from "zod";
import { mpesaService } from "../services/mpesa-service";
import { generateSTSToken } from "../_core/paymentGateway";
import { getDb } from "../db";
import { payments, billings, tokens, users } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { sendPushNotification } from "../_core/sendNotification";

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

          // Post-payment actions: update billing, generate token if applicable, notify user
          try {
            // Update associated billing record to 'paid'
            if (payment.billingId) {
              await db
                .update(billings)
                .set({ status: 'paid', paidAt: new Date(), paymentMethod: 'mpesa', transactionId: result.mpesaReceiptNumber ?? undefined })
                .where(eq(billings.id, payment.billingId));
            }

            // Generate energy token for token_purchase payments
            if (payment.paymentType === 'token_purchase') {
              const metadata = payment.metadata ? JSON.parse(payment.metadata) : {};
              const energyKwh = Number(metadata.energyKwh);
              if (Number.isInteger(energyKwh) && energyKwh > 0) {
                let tokenCode: string;
                let tokenStatus: 'active' | 'pending_issuance' = 'active';
                try {
                  tokenCode = generateSTSToken(energyKwh, payment.amount);
                } catch (stsError) {
                  if (stsError instanceof Error && stsError.message === 'STS_VENDING_NOT_CONFIGURED') {
                    // Record the owed token as pending issuance; never fabricate a code.
                    tokenCode = `PENDING_ISSUANCE_${payment.id}`;
                    tokenStatus = 'pending_issuance';
                  } else {
                    throw stsError;
                  }
                }
                await db.insert(tokens).values({
                  userId: payment.userId,
                  paymentId: payment.id,
                  tokenCode,
                  energyKwh,
                  amount: payment.amount,
                  validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
                  status: tokenStatus,
                });
                console.log('[MPesa Webhook] Energy token recorded for payment', payment.id, 'status:', tokenStatus);
              } else {
                console.error('[MPesa Webhook] token_purchase payment missing valid energyKwh metadata:', payment.id);
              }
            }

            // Send push notification to user
            await sendPushNotification(
              payment.userId,
              {
                title: 'Payment Successful',
                body: `Your M-Pesa payment of ${(payment.amount / 100).toFixed(2)} was received. Receipt: ${result.mpesaReceiptNumber}`,
                data: { paymentId: String(payment.id), type: 'payment_success' },
              },
              'pushPaymentReceived'
            );
          } catch (postPaymentError) {
            console.error('[MPesa Webhook] Post-payment action failed:', postPaymentError);
            // Do not rethrow — payment is already marked completed; post-payment
            // failures are logged and can be retried via reconciliation.
          }
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

          // Notify user of payment failure
          try {
            await sendPushNotification(
              payment.userId,
              {
                title: 'Payment Failed',
                body: `Your M-Pesa payment could not be completed. Reason: ${result.resultDesc}`,
                data: { paymentId: String(payment.id), type: 'payment_failed' },
              },
              'pushPaymentReceived'
            );
          } catch (notifError) {
            console.error('[MPesa Webhook] Failure notification error:', notifError);
          }
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
