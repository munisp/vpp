import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { PaymentGatewayManager } from "../payment-gateways";
import { getDb } from "../db";
import { payments, billings } from "../../drizzle/schema";
import { and, eq } from "drizzle-orm";
import { KAFKA_TOPICS } from "../integration/kafka-config";
import { enqueueEvent } from "../services/events/outbox";
import { temporalClient } from "../integration/temporal-client";
import { resolveGatewayEnvironment } from "../payment-gateways/environment";
import { settleBillingIfCovered } from "../webhooks/payment-callbacks";

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
          resolveGatewayEnvironment()
        );

        if (!response.success) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: response.message,
          });
        }

        // The payment row and its event are written together: the gateway has
        // already been asked for money, so this process must not be able to end
        // with a payment nobody downstream hears about.
        const payment = await db.transaction(async tx => {
          const [row] = await tx.insert(payments).values({
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
          }).returning({ id: payments.id });

          await enqueueEvent(tx, {
            topic: KAFKA_TOPICS.PAYMENTS_INITIATED,
            eventKey: `payment.initiated:${row.id}`,
            partitionKey: row.id.toString(),
            payload: {
              event_id: `payment.initiated:${row.id}`,
              source: 'payment-processing',
              paymentId: row.id.toString(),
              userId: ctx.user.id.toString(),
              amount,
              currency: 'TZS',
              gateway: input.gateway,
              timestamp: new Date().toISOString(),
            },
          });

          return row;
        });

        // Start Temporal workflow for payment processing
        try {
          const workflowHandle = await temporalClient.startPaymentWorkflow({
            paymentId: payment.id.toString(),
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
          resolveGatewayEnvironment()
        );

        // A gateway-reported amount that disagrees with the recorded amount is
        // a discrepancy for reconciliation, not a settled payment.
        // `PaymentStatusResponse.amount` is already in the platform's minor
        // units (cents) — the gateway adapters scale provider major units once
        // (`amount * 100` in payment-gateways/*.ts). Scaling here again made
        // every genuine amount look 100x too large, so verification of a real
        // Airtel/Tigo payment could never match and nothing ever settled.
        if (
          response.status === "completed" &&
          typeof response.amount === "number" &&
          Math.round(response.amount) !== pmt.amount
        ) {
          console.error(
            `[Payment] Amount mismatch on payment ${pmt.id}: gateway ${response.amount} vs recorded ${pmt.amount} cents`
          );
          return {
            success: false,
            status: "discrepancy" as const,
            message:
              "Gateway reported a different amount than the recorded payment; held for reconciliation.",
            transactionId: response.transactionId,
          };
        }

        // Status transitions are conditional on the payment still being
        // pending so a concurrent callback cannot be applied twice.
        if (response.status === "completed") {
          const settled = await db
            .update(payments)
            .set({ status: "completed" })
            .where(and(eq(payments.id, pmt.id), eq(payments.status, "pending")));

          // Only the transition that actually happened settles the invoice,
          // and the invoice is only settled when the completed payments
          // against it cover the invoiced consumer share.
          if ((settled.rowCount ?? 0) > 0 && pmt.billingId) {
            const settlement = await settleBillingIfCovered(
              db,
              pmt.billingId,
              pmt.paymentMethod,
              pmt.transactionId
            );
            if (!settlement.paid) {
              return {
                success: true,
                status: "partial" as const,
                message:
                  `Payment confirmed, but the invoice is only partially covered ` +
                  `(${settlement.totalPaidCents}/${settlement.dueCents} cents); it remains issued.`,
                transactionId: response.transactionId,
              };
            }
          }
        } else if (response.status === "failed") {
          await db
            .update(payments)
            .set({ status: "failed" })
            .where(and(eq(payments.id, pmt.id), eq(payments.status, "pending")));
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
