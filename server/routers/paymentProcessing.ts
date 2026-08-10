import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { PaymentGatewayManager } from "../payment-gateways";
import { getDb } from "../db";
import { payments, billings } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { kafkaPublisher } from "../integration/kafka-publisher";
import { temporalClient } from "../integration/temporal-client";

/**
 * Payment Processing Router
 * Handles real payment gateway integrations
 */
export const paymentProcessingRouter = router({
  /**
   * Initiate a payment using real gateway
   */
  initiatePayment: protectedProcedure
    .input(
      z.object({
        invoiceId: z.number().int().positive(),
        gateway: z.enum(["mpesa", "airtel_money", "tigo_pesa"]),
        phoneNumber: z.string().min(10, "Invalid phone number"),
        environment: z.enum(["sandbox", "production"]).optional().default("sandbox"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Get billing record
      const billing = await db
        .select()
        .from(billings)
        .where(eq(billings.id, input.invoiceId))
        .limit(1);

      if (billing.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Billing record not found" });
      }

      const inv = billing[0];

      // Verify invoice belongs to user
      if (inv.userId !== ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }

      // Check if billing is already paid
      if (inv.status === "paid") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Billing already paid" });
      }

      // Calculate amount to pay (consumer share)
      const amount = inv.consumerShare;

      try {
        // Initiate payment through gateway
        const response = await PaymentGatewayManager.initiatePayment(
          input.gateway,
          {
            amount,
            phoneNumber: input.phoneNumber,
            accountReference: `BILL-${inv.id}`,
            transactionDesc: `Payment for billing period ${inv.periodStart.toLocaleDateString()} - ${inv.periodEnd.toLocaleDateString()}`,
            metadata: {
              userId: ctx.user.id,
              invoiceId: inv.id,
            },
          },
          input.environment
        );

        if (!response.success) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: response.message,
          });
        }

        // Create payment record
        const [payment] = await db.insert(payments).values({
          userId: ctx.user.id,
          billingId: inv.id,
          paymentType: "invoice",
          amount,
          currency: "TZS",
          paymentMethod: input.gateway,
          phoneNumber: input.phoneNumber,
          transactionId: response.transactionId,
          status: "pending",
          metadata: JSON.stringify({
            checkoutRequestId: response.checkoutRequestId,
            billingId: inv.id,
          }),
        });

        // Start Temporal workflow for payment processing
        try {
          const workflowHandle = await temporalClient.startPaymentWorkflow({
            paymentId: payment.insertId.toString(),
            userId: ctx.user.id.toString(),
            amount,
            currency: 'TZS',
            gateway: input.gateway,
            metadata: {
              billingId: inv.id,
              checkoutRequestId: response.checkoutRequestId,
              transactionId: response.transactionId,
            },
          });
          console.log(`[Payment] Started Temporal workflow: ${workflowHandle.workflowId}`);
        } catch (temporalError) {
          console.error('[Payment] Failed to start Temporal workflow:', temporalError);
          // Continue even if Temporal workflow fails (graceful degradation)
        }

        // Publish Kafka event for payment initiation
        await kafkaPublisher.publishPaymentInitiated({
          paymentId: payment.insertId.toString(),
          userId: ctx.user.id.toString(),
          amount,
          currency: 'TZS',
          gateway: input.gateway,
          timestamp: new Date(),
        }).catch(err => console.error('[Kafka] Failed to publish payment.initiated event:', err));

        return {
          success: true,
          message: response.message,
          transactionId: response.transactionId,
          checkoutRequestId: response.checkoutRequestId,
        };
      } catch (error: any) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error.message || "Payment initiation failed",
        });
      }
    }),

  /**
   * Query payment status
   */
  queryPaymentStatus: protectedProcedure
    .input(
      z.object({
        paymentId: z.number().int().positive(),
        environment: z.enum(["sandbox", "production"]).optional().default("sandbox"),
      })
    )
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Get payment
      const payment = await db
        .select()
        .from(payments)
        .where(eq(payments.id, input.paymentId))
        .limit(1);

      if (payment.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Payment not found" });
      }

      const pmt = payment[0];

      // Verify payment belongs to user
      if (pmt.userId !== ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }

      if (!pmt.paymentMethod || !pmt.transactionId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid payment record" });
      }

      // Get checkout request ID from metadata
      const metadata = pmt.metadata ? JSON.parse(pmt.metadata) : {};
      const checkoutRequestId = metadata.checkoutRequestId || pmt.transactionId;

      try {
        // Query gateway
        const response = await PaymentGatewayManager.queryPaymentStatus(
          pmt.paymentMethod as "mpesa" | "airtel_money" | "tigo_pesa",
          checkoutRequestId,
          input.environment
        );

        // Update payment status if completed
        if (response.status === "completed" && pmt.status !== "completed") {
          await db
            .update(payments)
            .set({
              status: "completed",
            })
            .where(eq(payments.id, pmt.id));

          // Update billing status
          if (pmt.billingId) {
            await db
              .update(billings)
              .set({ status: "paid" })
              .where(eq(billings.id, pmt.billingId));
          }
        } else if (response.status === "failed" && pmt.status !== "failed") {
          await db
            .update(payments)
            .set({ status: "failed" })
            .where(eq(payments.id, pmt.id));
        }

        return {
          success: true,
          status: response.status,
          message: response.message,
          transactionId: response.transactionId,
        };
      } catch (error: any) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error.message || "Status query failed",
        });
      }
    }),

  /**
   * Get supported payment gateways
   */
  getSupportedGateways: protectedProcedure.query(() => {
    return PaymentGatewayManager.getSupportedGateways();
  }),
});
