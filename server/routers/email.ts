import { z } from 'zod';
import { router, protectedProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import { sendEmail, verifyEmailService } from '../_core/emailService';
import { sendTestWeeklySummary, sendWeeklyAnalyticsSummary, sendMonthlyAnalyticsSummary } from '../_core/scheduledEmails';
import { paymentReceiptTemplate, drEventAlertTemplate, systemAlertTemplate, welcomeEmailTemplate } from '../_core/emailTemplates';

/**
 * Email management router
 * Provides endpoints for testing email delivery and triggering scheduled summaries
 */
export const emailRouter = router({
  /**
   * Verify email service configuration
   * Admin only
   */
  verifyService: protectedProcedure
    .mutation(async ({ ctx }) => {
      if (ctx.user.role !== 'admin') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Admin access required' });
      }

      const isValid = await verifyEmailService();
      return {
        success: isValid,
        message: isValid ? 'Email service is configured correctly' : 'Email service configuration failed',
      };
    }),

  /**
   * Send test email
   * Admin only
   */
  sendTestEmail: protectedProcedure
    .input(z.object({
      to: z.string().email(),
      subject: z.string(),
      message: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== 'admin') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Admin access required' });
      }

      const result = await sendEmail({
        to: input.to,
        subject: input.subject,
        html: `<p>${input.message}</p>`,
        text: input.message,
      });

      if (!result.success) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.error || 'Failed to send email' });
      }

      return {
        success: true,
        messageId: result.messageId,
      };
    }),

  /**
   * Send test weekly summary
   * Admin only
   */
  sendTestWeeklySummary: protectedProcedure
    .mutation(async ({ ctx }) => {
      if (ctx.user.role !== 'admin') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Admin access required' });
      }

      if (!ctx.user.email) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Admin email not configured' });
      }

      const success = await sendTestWeeklySummary(ctx.user.email);
      if (!success) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to send test summary' });
      }

      return {
        success: true,
        message: `Test weekly summary sent to ${ctx.user.email}`,
      };
    }),

  /**
   * Trigger weekly analytics summary
   * Admin only - sends to all admins
   */
  triggerWeeklySummary: protectedProcedure
    .mutation(async ({ ctx }) => {
      if (ctx.user.role !== 'admin') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Admin access required' });
      }

      await sendWeeklyAnalyticsSummary();
      return {
        success: true,
        message: 'Weekly analytics summary sent to all admins',
      };
    }),

  /**
   * Trigger monthly analytics summary
   * Admin only - sends to all admins
   */
  triggerMonthlySummary: protectedProcedure
    .mutation(async ({ ctx }) => {
      if (ctx.user.role !== 'admin') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Admin access required' });
      }

      await sendMonthlyAnalyticsSummary();
      return {
        success: true,
        message: 'Monthly analytics summary sent to all admins',
      };
    }),

  /**
   * Send welcome email to a user
   * Admin only
   */
  sendWelcomeEmail: protectedProcedure
    .input(z.object({
      userId: z.number(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== 'admin') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Admin access required' });
      }

      const { getUserById } = await import('../db');
      const user = await getUserById(input.userId);
      if (!user || !user.email) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found or email not configured' });
      }

      const emailHtml = welcomeEmailTemplate({
        userName: user.name || 'User',
        loginUrl: 'https://vpp-platform.com/login',
      });

      const result = await sendEmail({
        to: user.email,
        subject: '🎉 Welcome to VPP Platform',
        html: emailHtml,
      });

      if (!result.success) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.error || 'Failed to send email' });
      }

      return {
        success: true,
        message: `Welcome email sent to ${user.email}`,
      };
    }),
});
