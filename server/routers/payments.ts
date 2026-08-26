import { z } from 'zod';
import { router, protectedProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import * as db from '../db';
import * as notifications from '../_core/notifications';
import * as paymentGateway from '../_core/paymentGateway';
import { issuePrepaidTokenForPayment } from '../services/prepaid-issuance-entry';
import { payments, tokens, billings } from '../../drizzle/schema';
import { eq, desc, and, inArray, sql } from 'drizzle-orm';

const InitiatePaymentInputSchema = z.object({
  paymentType: z.enum(['invoice', 'token_purchase', 'monthly_fee']),
  amount: z.number().int().positive(),
  paymentMethod: z.enum(['mpesa', 'airtel_money', 'tigo_pesa', 'bank_transfer', 'card']),
  phoneNumber: z.string().optional(),
  accountNumber: z.string().optional(),
  billingId: z.number().int().positive().optional(),
  energyKwh: z.number().int().positive().optional(), // for token purchase
});

/**
 * The only payment methods behind which this platform has a provider are the
 * three mobile-money gateways. `bank_transfer` and `card` are collected by the
 * schema but reach no provider, so a payment made with them is never asked for:
 * it can only sit pending until someone reads it as money on its way.
 */
const GATEWAY_INITIATORS = {
  mpesa: 'initiateMpesaPayment',
  airtel_money: 'initiateAirtelPayment',
  tigo_pesa: 'initiateTigoPesaPayment',
} as const;

type GatewayMethod = keyof typeof GATEWAY_INITIATORS;

function isGatewayMethod(method: string): method is GatewayMethod {
  return method in GATEWAY_INITIATORS;
}

/**
 * A gateway that is not configured, or that could not be reached, is not a
 * fault in the request: the caller is told the method is unavailable rather
 * than being shown a failure it can do nothing about.
 */
function gatewayFailureCode(message: string): TRPCError['code'] {
  return /_NOT_CONFIGURED$/.test(message) ? 'SERVICE_UNAVAILABLE' : 'BAD_GATEWAY';
}

/**
 * A connection refusal means no provider process accepted the request. A timeout,
 * reset, or broken socket can occur after the provider received it; that outcome
 * is unknown and must remain reconcilable instead of being declared failed.
 */
function providerOutcomeIsUnknown(error: unknown): boolean {
  const details = error instanceof Error
    ? `${(error as Error & { code?: string }).code ?? ''} ${error.message}`
    : String(error);
  return /\b(ETIMEDOUT|ECONNABORTED|ECONNRESET|EPIPE|ERR_NETWORK|timeout|timed out|socket hang up)\b/i.test(
    details
  );
}

const VerifyPaymentInputSchema = z.object({
  paymentId: z.number().int().positive(),
});

const GenerateTokenInputSchema = z.object({
  paymentId: z.number().int().positive(),
});

export const paymentsRouter = router({
  initiate: protectedProcedure
    .input(InitiatePaymentInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        // Validate billing if provided
        if (input.billingId) {
          const billing = await db.getBillingById(input.billingId);
          if (!billing || billing.userId !== ctx.user.id) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Billing not found.',
            });
          }

          if (billing.status === 'paid' || billing.status === 'cancelled') {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `Invoice is already ${billing.status} and cannot be paid again.`,
            });
          }

          // Never accept more than the invoiced consumer share: an overpayment
          // would settle money the platform has no obligation to hold.
          if (input.amount > billing.consumerShare) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `Amount exceeds the invoiced amount of ${billing.consumerShare} cents.`,
            });
          }
        }

        // A token purchase without an energy quantity cannot be vended, and the
        // quantity must be known before money moves.
        if (input.paymentType === 'token_purchase' && !input.energyKwh) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'energyKwh is required for a token purchase.',
          });
        }

        // Refuse before a payment row exists: a pending payment nobody will ever
        // ask a provider about is indistinguishable from one in flight.
        if (!isGatewayMethod(input.paymentMethod)) {
          throw new TRPCError({
            code: 'SERVICE_UNAVAILABLE',
            message: `PAYMENT_METHOD_NO_PROVIDER: ${input.paymentMethod} has no payment provider on this deployment.`,
          });
        }

        if (!input.phoneNumber) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `phoneNumber is required to charge ${input.paymentMethod}.`,
          });
        }

        const payment = await db.createPayment({
          userId: ctx.user.id,
          billingId: input.billingId,
          paymentType: input.paymentType,
          amount: input.amount,
          currency: ctx.user.currency,
          paymentMethod: input.paymentMethod,
          phoneNumber: input.phoneNumber,
          accountNumber: input.accountNumber,
          status: 'pending',
          metadata: input.energyKwh ? JSON.stringify({ energyKwh: input.energyKwh }) : undefined,
        });

        const request = {
          amount: input.amount,
          phoneNumber: input.phoneNumber,
          accountReference: `PAY${payment.id}`,
          description: `VPP ${input.paymentType} payment`,
        };

        let gatewayResponse: paymentGateway.PaymentResponse;
        try {
          gatewayResponse = await paymentGateway[GATEWAY_INITIATORS[input.paymentMethod]](request);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);

          // A gateway timeout or reset can happen after the provider accepted the
          // request. Keep the payment pending with a durable reason and return a
          // truthful response so the caller does not create a second charge.
          if (providerOutcomeIsUnknown(error)) {
            await db.updatePaymentMetadata(payment.id, {
              ...(input.energyKwh ? { energyKwh: input.energyKwh } : {}),
              providerOutcome: 'unknown',
              providerOutcomeObservedAt: new Date().toISOString(),
              providerInitiationError: message,
              reconciliationRequired: true,
            });
            return {
              success: false,
              payment,
              gatewayResponse: null,
              reconciliationRequired: true,
              message:
                'We could not confirm whether the provider received this payment request. Do not retry; use the payment reference while its status is reconciled.',
            };
          }

          // A confidently pre-send failure, such as an unconfigured gateway or
          // refused connection, cannot have created a provider-side charge.
          await db.updatePaymentStatus(payment.id, 'failed', undefined, 'pending');
          throw new TRPCError({ code: gatewayFailureCode(message), message });
        }

        // A gateway that rejected the request must not leave a pending payment
        // behind that a later status query could resolve as completed.
        if (!gatewayResponse.success) {
          await db.updatePaymentStatus(payment.id, 'failed', undefined, 'pending');
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: gatewayResponse.message || 'Payment gateway rejected the request.',
          });
        }

        // Persist the gateway reference used to query status later. M-Pesa
        // status queries key off CheckoutRequestID, not MerchantRequestID, so
        // both are stored and the query reference is recorded in metadata.
        if (gatewayResponse.transactionId || gatewayResponse.checkoutRequestId) {
          const gatewayReference =
            gatewayResponse.checkoutRequestId || gatewayResponse.transactionId!;

          await db.updatePaymentMetadata(payment.id, {
            ...(input.energyKwh ? { energyKwh: input.energyKwh } : {}),
            gatewayReference,
            merchantRequestId: gatewayResponse.transactionId,
          });

          await db.updatePaymentStatus(
            payment.id,
            'pending',
            gatewayResponse.transactionId || gatewayReference
          );
          payment.transactionId = gatewayResponse.transactionId || gatewayReference;
        }

        return {
          success: true,
          payment,
          gatewayResponse,
          message: gatewayResponse.message || 'Payment initiated successfully.',
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error('Error initiating payment:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to initiate payment.',
        });
      }
    }),

  verify: protectedProcedure
    .input(VerifyPaymentInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const payment = await db.getPaymentById(input.paymentId);
        
        if (!payment || payment.userId !== ctx.user.id) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Payment not found.',
          });
        }

        // Verify payment with gateway. Only mobile-money gateway providers
        // support self-service verification via the gateway status query.
        const provider = payment.paymentMethod === 'mpesa' ? 'mpesa' 
          : payment.paymentMethod === 'airtel_money' ? 'airtel_money'
          : payment.paymentMethod === 'tigo_pesa' ? 'tigo_pesa'
          : null;
        
        if (!provider) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Bank transfer and card payments cannot be self-verified; they require admin reconciliation.',
          });
        }

        const paymentMetadata = payment.metadata ? JSON.parse(payment.metadata) : {};

        // Already-settled payments return the existing outcome instead of
        // re-running post-payment actions (double token issuance, duplicate
        // notifications) on every retry.
        if (payment.status === 'completed') {
          const existingToken = await db.getTokenByPaymentId(payment.id);
          return {
            success: true,
            message: 'Payment was already verified.',
            token: existingToken ?? null,
          };
        }

        if (payment.status !== 'pending') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Payment is ${payment.status} and can no longer be verified.`,
          });
        }

        // The gateway reference is the one recorded at initiation; a
        // client-supplied transaction id must never decide which transaction is
        // checked, or a caller could point at somebody else's payment.
        const gatewayReference: string | undefined =
          paymentMetadata.gatewayReference || payment.transactionId || undefined;

        if (!gatewayReference) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'This payment has no gateway reference to verify; it must be reconciled by an administrator.',
          });
        }

        const verificationResult = await paymentGateway.verifyPaymentStatus(
          gatewayReference,
          provider
        );

        if (verificationResult.status === 'completed') {
          const transitioned = await db.updatePaymentStatus(
            input.paymentId,
            'completed',
            gatewayReference,
            'pending'
          );

          if (!transitioned) {
            // Another verification or the gateway callback settled it first.
            const existingToken = await db.getTokenByPaymentId(payment.id);
            return {
              success: true,
              message: 'Payment was already verified.',
              token: existingToken ?? null,
            };
          }

          // Update billing if associated
          if (payment.billingId) {
            await db.updateBillingStatus(
              payment.billingId,
              'paid',
              new Date(),
              payment.paymentMethod,
              gatewayReference
            );
          }

          // Auto-generate token for token purchases
          let token = null;
          if (payment.paymentType === 'token_purchase') {
            const energyKwh = Number(paymentMetadata.energyKwh);
            if (!Number.isInteger(energyKwh) || energyKwh <= 0) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: 'Energy amount (energyKwh) is missing or invalid on this token purchase payment.',
              });
            }

            // Prepaid vending goes through the prepaid account layer first: it
            // posts the purchase to the ledger and vends an OpenPAYGO token the
            // customer's meter accepts, and it is idempotent per payment. The
            // legacy STS path below is only reached when this payment has no
            // prepaid account behind it.
            const prepaid = await issuePrepaidTokenForPayment({
              paymentId: payment.id,
              issuedBy: ctx.user.id,
            });
            if (prepaid.issued) {
              const vended = await db.getTokenByPaymentId(payment.id);
              if (vended) {
                token = vended;
              }
            }

            if (token === null) {
              try {
                const tokenCode = paymentGateway.generateSTSToken(energyKwh, payment.amount);
                token = await db.createToken({
                  userId: ctx.user.id,
                  paymentId: payment.id,
                  tokenCode,
                  energyKwh,
                  amount: payment.amount,
                  validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
                  status: 'active',
                });
              } catch (stsError) {
                if (stsError instanceof Error && stsError.message === 'STS_VENDING_NOT_CONFIGURED') {
                  // Neither a prepaid account nor an STS provider: the energy is
                  // owed and recorded as unissued, with the prepaid layer's own
                  // reason, instead of a token code nobody vended.
                  token = await db.createToken({
                    userId: ctx.user.id,
                    paymentId: payment.id,
                    tokenCode: `PENDING_ISSUANCE_${payment.id}`,
                    energyKwh,
                    amount: payment.amount,
                    validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
                    status: 'pending_issuance',
                  });

                  await notifications.sendPushNotification({
                    userId: ctx.user.id,
                    title: 'Token Pending Issuance',
                    body: `Your payment was confirmed. Your ${energyKwh} kWh token will be delivered once it is vended by the provider.`,
                    data: { paymentId: String(payment.id), type: 'token_pending_issuance' },
                  });

                  return {
                    success: true,
                    message: prepaid.retryScheduled
                      ? `Payment verified. The token has not been vended yet (${prepaid.reason}); issuance is being retried.`
                      : `Payment verified. The token has not been vended (${prepaid.reason ?? 'no vending provider is configured'}) and will be delivered once it is.`,
                    token,
                  };
                }
                throw stsError;
              }
            }
          }

          // Send notifications
          const user = await db.getUserByOpenId(ctx.user.openId);
          if (user?.email) {
            // Email notification
            const emailNotif = notifications.getPaymentSuccessEmail({
              userName: user.name || 'User',
              amount: payment.amount,
              transactionId: gatewayReference,
              paymentMethod: payment.paymentMethod,
            });
            emailNotif.to = user.email;
            await notifications.sendEmail(emailNotif);

            // If token was generated, send token notification
            if (token) {
              const tokenEmailNotif = notifications.getTokenGeneratedEmail({
                userName: user.name || 'User',
                tokenCode: token.tokenCode,
                energyKwh: token.energyKwh,
                amount: token.amount,
              });
              tokenEmailNotif.to = user.email;
              await notifications.sendEmail(tokenEmailNotif);

              // Push notification
              const pushNotif = notifications.getTokenGeneratedPush({
                tokenCode: token.tokenCode,
                energyKwh: token.energyKwh,
              });
              pushNotif.userId = user.id;
              await notifications.sendPushNotification(pushNotif);
            } else {
              // Push notification for payment success
              const pushNotif = notifications.getPaymentSuccessPush({
                amount: payment.amount,
                transactionId: gatewayReference,
              });
              pushNotif.userId = user.id;
              await notifications.sendPushNotification(pushNotif);
            }
          }

          return {
            success: true,
            message: 'Payment verified successfully.',
            token,
          };
        } else if (verificationResult.status === 'pending') {
          return {
            success: false,
            message: 'Payment is still pending. Please try again later.',
          };
        } else {
          await db.updatePaymentStatus(input.paymentId, 'failed', gatewayReference, 'pending');
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Payment verification failed.',
          });
        }
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error('Error verifying payment:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to verify payment.',
        });
      }
    }),

  generateToken: protectedProcedure
    .input(GenerateTokenInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const payment = await db.getPaymentById(input.paymentId);
        
        if (!payment || payment.userId !== ctx.user.id) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Payment not found.',
          });
        }

        if (payment.status !== 'completed') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Payment must be completed before generating token.',
          });
        }

        if (payment.paymentType !== 'token_purchase') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Token can only be generated for token purchase payments.',
          });
        }

        // A payment issues exactly one token; a second call returns the token
        // that was already vended rather than issuing free energy.
        const alreadyIssued = await db.getTokenByPaymentId(payment.id);
        if (alreadyIssued && alreadyIssued.status !== 'pending_issuance') {
          return {
            success: true,
            token: alreadyIssued,
            message: 'Token already issued for this payment.',
          };
        }

        // A row still reading `pending_issuance` is an obligation, not a token,
        // so this is the retry: prepaid vending is attempted (again) and, if it
        // succeeds, that placeholder becomes the real code.
        const prepaid = await issuePrepaidTokenForPayment({
          paymentId: payment.id,
          issuedBy: ctx.user.id,
        });
        if (prepaid.issued) {
          const vended = await db.getTokenByPaymentId(payment.id);
          if (vended) {
            return { success: true, token: vended, message: 'Token issued for this payment.' };
          }
        }
        if (alreadyIssued) {
          return {
            success: true,
            token: alreadyIssued,
            message: prepaid.retryScheduled
              ? `Not vended yet (${prepaid.reason}); issuance is being retried.`
              : `Not vended (${prepaid.reason ?? 'no vending provider is configured'}). The energy stays owed until it is.`,
          };
        }

        // Parse energy from metadata
        const metadata = payment.metadata ? JSON.parse(payment.metadata) : {};
        const energyKwh = Number(metadata.energyKwh);

        if (!Number.isInteger(energyKwh) || energyKwh <= 0) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Energy amount (energyKwh) is missing or invalid on this payment.',
          });
        }

        // Vend the token through the configured STS provider. When no STS
        // vending provider is configured, record the token as pending issuance
        // rather than inventing a code.
        let tokenCode: string;
        try {
          tokenCode = paymentGateway.generateSTSToken(energyKwh, payment.amount);
        } catch (stsError) {
          if (stsError instanceof Error && stsError.message === 'STS_VENDING_NOT_CONFIGURED') {
            const pendingToken = await db.createToken({
              userId: ctx.user.id,
              paymentId: payment.id,
              tokenCode: `PENDING_ISSUANCE_${payment.id}`,
              energyKwh,
              amount: payment.amount,
              validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
              status: 'pending_issuance',
            });

            return {
              success: true,
              token: pendingToken,
              message: 'Token is pending issuance and will be delivered once vended by the STS provider.',
            };
          }
          throw stsError;
        }

        const token = await db.createToken({
          userId: ctx.user.id,
          paymentId: payment.id,
          tokenCode,
          energyKwh,
          amount: payment.amount,
          validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
          status: 'active',
        });

        return {
          success: true,
          token,
          message: 'Token generated successfully.',
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error('Error generating token:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to generate token.',
        });
      }
    }),

  getToken: protectedProcedure
    .input(z.object({ tokenCode: z.string() }))
    .query(async ({ ctx, input }) => {
      try {
        const token = await db.getTokenByCode(input.tokenCode, ctx.user.id);

        if (!token) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Token not found.',
          });
        }

        return token;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error('Error getting token:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to retrieve token.',
        });
      }
    }),

  list: protectedProcedure
    .input(z.object({ limit: z.number().int().positive().max(100).default(50) }).optional())
    .query(async ({ ctx, input }) => {
      try {
        const dbInstance = await db.getDb();
        if (!dbInstance) throw new Error('Database not available');

        const rows = await dbInstance
          .select({
            id: payments.id,
            amount: payments.amount,
            currency: payments.currency,
            status: payments.status,
            paymentMethod: payments.paymentMethod,
            transactionId: payments.transactionId,
            createdAt: payments.createdAt,
          })
          .from(payments)
          .where(eq(payments.userId, ctx.user.id))
          .orderBy(desc(payments.createdAt))
          .limit(input?.limit ?? 50);

        return rows.map((row) => ({
          ...row,
          description: `${row.paymentMethod} payment`,
        }));
      } catch (error) {
        console.error('Error listing payments:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to list payments.',
        });
      }
    }),

  listTokens: protectedProcedure
    .query(async ({ ctx }) => {
      try {
        const dbInstance = await db.getDb();
        if (!dbInstance) throw new Error('Database not available');

        const rows = await dbInstance
          .select({
            id: tokens.id,
            tokenCode: tokens.tokenCode,
            status: tokens.status,
            energyKwh: tokens.energyKwh,
            amount: tokens.amount,
            createdAt: tokens.createdAt,
          })
          .from(tokens)
          .where(eq(tokens.userId, ctx.user.id))
          .orderBy(desc(tokens.createdAt));

        // Never expose a placeholder issuance marker as if it were a token.
        return rows.map((row) => ({
          id: row.id,
          token: row.status === 'pending_issuance' ? null : row.tokenCode,
          energyKwh: row.energyKwh,
          amount: row.amount,
          status: row.status,
          createdAt: row.createdAt,
        }));
      } catch (error) {
        console.error('Error listing tokens:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to list tokens.',
        });
      }
    }),

  getBalance: protectedProcedure
    .query(async ({ ctx }) => {
      try {
        const dbInstance = await db.getDb();
        if (!dbInstance) throw new Error('Database not available');

        const [paidRow] = await dbInstance
          .select({ total: sql<number>`COALESCE(SUM(${payments.amount}), 0)` })
          .from(payments)
          .where(and(eq(payments.userId, ctx.user.id), eq(payments.status, 'completed')));

        // Amounts the user owes or has settled through invoiced billings.
        const [billedRow] = await dbInstance
          .select({ total: sql<number>`COALESCE(SUM(${billings.consumerShare}), 0)` })
          .from(billings)
          .where(
            and(
              eq(billings.userId, ctx.user.id),
              inArray(billings.status, ['issued', 'paid', 'overdue'])
            )
          );

        const totalPaidCents = Number(paidRow?.total ?? 0);
        const totalBilledCents = Number(billedRow?.total ?? 0);

        return {
          balanceCents: totalPaidCents - totalBilledCents,
          computed: true,
          totalPaidCents,
          totalBilledCents,
        };
      } catch (error) {
        console.error('Error computing balance:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to compute balance.',
        });
      }
    }),
});

export type PaymentsRouter = typeof paymentsRouter;
