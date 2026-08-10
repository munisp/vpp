import { z } from 'zod';
import { router, protectedProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import * as db from '../db';
import * as notifications from '../_core/notifications';
import * as paymentGateway from '../_core/paymentGateway';
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

const VerifyPaymentInputSchema = z.object({
  paymentId: z.number().int().positive(),
  transactionId: z.string(),
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

        // Initiate payment with gateway for mobile money
        let gatewayResponse: paymentGateway.PaymentResponse | null = null;
        
        if (input.paymentMethod === 'mpesa' && input.phoneNumber) {
          gatewayResponse = await paymentGateway.initiateMpesaPayment({
            amount: input.amount,
            phoneNumber: input.phoneNumber,
            accountReference: `PAY${payment.id}`,
            description: `VPP ${input.paymentType} payment`
          });
        } else if (input.paymentMethod === 'airtel_money' && input.phoneNumber) {
          gatewayResponse = await paymentGateway.initiateAirtelPayment({
            amount: input.amount,
            phoneNumber: input.phoneNumber,
            accountReference: `PAY${payment.id}`,
            description: `VPP ${input.paymentType} payment`
          });
        } else if (input.paymentMethod === 'tigo_pesa' && input.phoneNumber) {
          gatewayResponse = await paymentGateway.initiateTigoPesaPayment({
            amount: input.amount,
            phoneNumber: input.phoneNumber,
            accountReference: `PAY${payment.id}`,
            description: `VPP ${input.paymentType} payment`
          });
        }

        // Update payment with transaction ID if gateway returned one
        if (gatewayResponse?.transactionId) {
          await db.updatePaymentStatus(
            payment.id,
            'pending',
            gatewayResponse.transactionId
          );
          // Store checkout request ID in metadata for status checking
          payment.transactionId = gatewayResponse.transactionId;
        }

        return {
          success: true,
          payment,
          gatewayResponse,
          message: gatewayResponse?.message || 'Payment initiated successfully.',
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

        const verificationResult = await paymentGateway.verifyPaymentStatus(
          input.transactionId,
          provider
        );

        if (verificationResult.status === 'completed') {
          await db.updatePaymentStatus(input.paymentId, 'completed', input.transactionId);

          // Update billing if associated
          if (payment.billingId) {
            await db.updateBillingStatus(
              payment.billingId,
              'paid',
              new Date(),
              payment.paymentMethod,
              input.transactionId
            );
          }

          // Auto-generate token for token purchases
          let token = null;
          if (payment.paymentType === 'token_purchase') {
            const metadata = payment.metadata ? JSON.parse(payment.metadata) : {};
            const energyKwh = Number(metadata.energyKwh);
            if (!Number.isInteger(energyKwh) || energyKwh <= 0) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: 'Energy amount (energyKwh) is missing or invalid on this token purchase payment.',
              });
            }

            let tokenCode: string;
            try {
              tokenCode = paymentGateway.generateSTSToken(energyKwh, payment.amount);
            } catch (stsError) {
              if (stsError instanceof Error && stsError.message === 'STS_VENDING_NOT_CONFIGURED') {
                // No STS vending provider configured: record the owed token as
                // pending issuance instead of fabricating a token code.
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
                  message: 'Payment verified successfully. Your token is pending issuance and will be delivered once vended.',
                  token,
                };
              }
              throw stsError;
            }

            token = await db.createToken({
              userId: ctx.user.id,
              paymentId: payment.id,
              tokenCode,
              energyKwh,
              amount: payment.amount,
              validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
              status: 'active',
            });
          }

          // Send notifications
          const user = await db.getUserByOpenId(ctx.user.openId);
          if (user?.email) {
            // Email notification
            const emailNotif = notifications.getPaymentSuccessEmail({
              userName: user.name || 'User',
              amount: payment.amount,
              transactionId: input.transactionId,
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
                transactionId: input.transactionId,
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
          await db.updatePaymentStatus(input.paymentId, 'failed', input.transactionId);
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

        // Parse energy from metadata
        const metadata = payment.metadata ? JSON.parse(payment.metadata) : {};
        const energyKwh = metadata.energyKwh || 0;

        if (!energyKwh) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Energy amount not found in payment.',
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
        const token = await db.getTokenByCode(input.tokenCode);
        
        if (!token || token.userId !== ctx.user.id) {
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
