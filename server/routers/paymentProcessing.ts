import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { PaymentGatewayManager } from "../payment-gateways";
import { getDb } from "../db";
import { payments, billings } from "../../drizzle/schema";
import { and, eq, sql } from "drizzle-orm";
import { KAFKA_TOPICS } from "../integration/kafka-config";
import { enqueueEvent } from "../services/events/outbox";
import { temporalClient } from "../integration/temporal-client";
import { resolveGatewayEnvironment } from "../payment-gateways/environment";

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

      // Calculate amount to pay (consumer share).
      const amount = inv.consumerShare;
      const environment = resolveGatewayEnvironment();
      const configured = await PaymentGatewayManager.isConfigured(input.gateway, environment);
      if (!configured.configured) {
        throw new TRPCError({
          code: 'SERVICE_UNAVAILABLE',
          message: configured.reason || 'The selected payment gateway is unavailable.',
        });
      }

      // Persist a single invoice attempt before contacting the provider. A
      // process crash or network ambiguity after the provider receives a prompt
      // now leaves a durable reconciliation record rather than a hidden charge.
      const payment = await db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${inv.id})`);
        const existing = await tx
          .select({ id: payments.id })
          .from(payments)
          .where(
            and(
              eq(payments.billingId, inv.id),
              eq(payments.userId, ctx.user.id),
              eq(payments.status, 'pending')
            )
          )
          .limit(1);
        if (existing.length > 0) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'This invoice already has a payment awaiting provider confirmation. Do not retry it; reconcile the existing payment first.',
          });
        }

        const [row] = await tx.insert(payments).values({
          userId: ctx.user.id,
          billingId: inv.id,
          paymentType: 'invoice',
          amount,
          currency: 'TZS',
          paymentMethod: input.gateway,
          phoneNumber: input.phoneNumber,
          status: 'pending',
          metadata: JSON.stringify({ billingId: inv.id, paymentProcessingEnvironment: environment }),
        }).returning({ id: payments.id });
        return row;
      });

      const accountReference = `BILL-${inv.id}-PAY-${payment.id}`;
      let response;
      try {
        response = await PaymentGatewayManager.initiatePayment(
          input.gateway,
          {
            amount,
            phoneNumber: input.phoneNumber,
            accountReference,
            transactionDesc: `Payment for billing period ${inv.periodStart.toLocaleDateString()} - ${inv.periodEnd.toLocaleDateString()}`,
            metadata: { userId: ctx.user.id, invoiceId: inv.id, paymentId: payment.id },
          },
          environment
        );
      } catch (error: any) {
        await db.update(payments).set({
          metadata: JSON.stringify({
            billingId: inv.id,
            paymentProcessingEnvironment: environment,
            accountReference,
            providerOutcome: 'unknown',
            reconciliationRequired: true,
            providerInitiationError: error.message || String(error),
          }),
        }).where(and(eq(payments.id, payment.id), eq(payments.status, 'pending')));
        throw new TRPCError({
          code: 'BAD_GATEWAY',
          message: 'The provider outcome is unknown. Do not retry; reconcile the existing payment reference.',
        });
      }

      // A gateway adapter can report a failed request after a timeout or a
      // transport error. Without provider-specific proof that no prompt was
      // received, retain the row as pending and require reconciliation.
      if (!response.success) {
        await db.update(payments).set({
          metadata: JSON.stringify({
            billingId: inv.id,
            paymentProcessingEnvironment: environment,
            accountReference,
            providerOutcome: 'unknown',
            reconciliationRequired: true,
            providerInitiationError: response.message,
          }),
        }).where(and(eq(payments.id, payment.id), eq(payments.status, 'pending')));
        return {
          success: false,
          reconciliationRequired: true,
          paymentId: payment.id,
          message: 'The provider did not return a confirmed initiation result. Do not retry; reconcile the existing payment reference.',
        };
      }

      // The durable payment update and initiated-event record commit together.
      await db.transaction(async tx => {
        await tx.update(payments).set({
          transactionId: response.transactionId,
          metadata: JSON.stringify({
            billingId: inv.id,
            paymentProcessingEnvironment: environment,
            accountReference,
            checkoutRequestId: response.checkoutRequestId,
          }),
        }).where(and(eq(payments.id, payment.id), eq(payments.status, 'pending')));

        await enqueueEvent(tx, {
          topic: KAFKA_TOPICS.PAYMENTS_INITIATED,
          eventKey: `payment.initiated:${payment.id}`,
          partitionKey: payment.id.toString(),
          payload: {
            event_id: `payment.initiated:${payment.id}`,
            source: 'payment-processing',
            paymentId: payment.id.toString(),
            userId: ctx.user.id.toString(),
            amount,
            currency: 'TZS',
            gateway: input.gateway,
            timestamp: new Date().toISOString(),
          },
        });
      });

      // A failed Temporal handoff is visible on the payment row and can be
      // recovered by reconciliation; it never changes the provider-backed
      // pending status to a fabricated terminal state.
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
        const reason = temporalError instanceof Error ? temporalError.message : String(temporalError);
        console.error('[Payment] Failed to start Temporal workflow:', temporalError);
        await db.update(payments).set({
          metadata: JSON.stringify({
            billingId: inv.id,
            paymentProcessingEnvironment: environment,
            accountReference,
            checkoutRequestId: response.checkoutRequestId,
            temporalStartFailure: { reason, recordedAt: new Date().toISOString() },
          }),
        }).where(eq(payments.id, payment.id));
      }

      return {
        success: true,
        paymentId: payment.id,
        message: response.message,
        transactionId: response.transactionId,
        checkoutRequestId: response.checkoutRequestId,
      };
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
        if (
          response.status === "completed" &&
          typeof response.amount === "number" &&
          Math.round(response.amount * 100) !== pmt.amount
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

          // Only the transition that actually happened settles the invoice.
          if ((settled.rowCount ?? 0) > 0 && pmt.billingId) {
            await db
              .update(billings)
              .set({ status: "paid", paidAt: new Date(), transactionId: pmt.transactionId })
              .where(eq(billings.id, pmt.billingId));
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
