import { z } from 'zod';
import { router, protectedProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import * as db from '../db';
import * as notifications from '../_core/notifications';
import * as paymentGateway from '../_core/paymentGateway';

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

        // Verify payment with gateway
        const provider = payment.paymentMethod === 'mpesa' ? 'mpesa' 
          : payment.paymentMethod === 'airtel_money' ? 'airtel_money'
          : payment.paymentMethod === 'tigo_pesa' ? 'tigo_pesa'
          : null;
        
        let verificationResult: { status: 'pending' | 'completed' | 'failed'; message: string } = { 
          status: 'completed', 
          message: 'Payment verified' 
        };
        
        if (provider) {
          verificationResult = await paymentGateway.verifyPaymentStatus(
            input.transactionId,
            provider
          );
        }

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
            const energyKwh = metadata.energyKwh || 10;
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

              // SMS notification with token
              // Note: In production, get phone number from user profile
              // const smsNotif = notifications.getTokenGeneratedSMS({
              //   tokenCode: token.tokenCode,
              //   energyKwh: token.energyKwh,
              // });
              // smsNotif.to = user.phone;
              // await notifications.sendSMS(smsNotif);

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

        // Generate 20-digit STS token (simplified)
        const tokenCode = Math.random().toString().slice(2, 22);
        
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
});

export type PaymentsRouter = typeof paymentsRouter;
