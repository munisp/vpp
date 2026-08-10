import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { sendEmail, wrapEmailTemplate } from "../_core/emailService";
import {
  createReferralCode,
  getUserReferralCode,
  applyReferralCode,
  processReferralReward,
  getUserReferrals,
  getUserReferralRewards,
  getUserReferralStats,
  validateReferralCode,
  getReferralByCode,
} from "../db-referrals";
import {
  notifyReferralReward,
  notifyReferralCompleted,
  notifyMilestoneReached,
} from "../_core/referralNotifications";

/**
 * Referrals Router
 * 
 * Handles user referral program operations including code generation,
 * application, reward processing, and statistics tracking.
 */
export const referralsRouter = router({
  /**
   * Get or create user's referral code
   */
  getMyReferralCode: protectedProcedure.query(async ({ ctx }) => {
    // Check if user already has a referral code
    const existingCode = await getUserReferralCode(ctx.user.id);

    // If exists, return it
    if (existingCode) {
      return {
        id: existingCode.id,
        referralCode: existingCode.referralCode,
        expiresAt: existingCode.expiresAt,
      };
    }

    // Otherwise create a new one
    const newCode = await createReferralCode(ctx.user.id);
    return newCode;
  }),

  /**
   * Validate a referral code
   */
  validateCode: protectedProcedure
    .input(
      z.object({
        code: z.string().min(1),
      })
    )
    .query(async ({ input }) => {
      const isValid = await validateReferralCode(input.code);
      
      if (isValid) {
        const referral = await getReferralByCode(input.code);
        return {
          valid: true,
          referral: referral ? {
            referralCode: referral.referralCode,
            rewardAmount: referral.rewardAmount,
            rewardCurrency: referral.rewardCurrency,
            expiresAt: referral.expiresAt,
          } : null,
        };
      }

      return { valid: false, referral: null };
    }),

  /**
   * Apply a referral code (for new users during onboarding)
   */
  applyCode: protectedProcedure
    .input(
      z.object({
        code: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const referral = await applyReferralCode(
          input.code,
          ctx.user.id,
          ctx.user.email || undefined
        );

        // Process the reward for the referrer
        await processReferralReward(referral.id);

        // Send notifications
        await notifyReferralCompleted({
          userId: referral.referrerId,
          userName: ctx.user.name || "User",
          refereeEmail: ctx.user.email || undefined,
        });

        await notifyReferralReward({
          userId: referral.referrerId,
          userName: ctx.user.name || "User",
          amount: referral.rewardAmount,
          currency: referral.rewardCurrency,
          referralCode: input.code,
        });

        // Check for milestones
        const stats = await getUserReferralStats(referral.referrerId);
        const milestones = [
          { count: 5, name: "First Steps" },
          { count: 10, name: "Rising Star" },
          { count: 25, name: "Top Referrer" },
          { count: 50, name: "Referral Champion" },
          { count: 100, name: "Legendary Referrer" },
        ];

        const milestone = milestones.find(m => m.count === stats.totalReferrals);
        if (milestone) {
          await notifyMilestoneReached({
            userId: referral.referrerId,
            userName: ctx.user.name || "User",
            milestone: milestone.name,
            totalReferrals: stats.totalReferrals,
          });
        }

        return {
          success: true,
          message: "Referral code applied successfully!",
          reward: {
            amount: referral.rewardAmount,
            currency: referral.rewardCurrency,
          },
        };
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : "Failed to apply referral code",
        };
      }
    }),

  /**
   * Get all referrals made by the current user
   */
  getMyReferrals: protectedProcedure.query(async ({ ctx }) => {
    const referrals = await getUserReferrals(ctx.user.id);
    
    return referrals.map(r => ({
      id: r.id,
      referralCode: r.referralCode,
      status: r.status,
      refereeEmail: r.refereeEmail,
      refereePhone: r.refereePhone,
      rewardAmount: r.rewardAmount,
      rewardCurrency: r.rewardCurrency,
      completedAt: r.completedAt,
      rewardedAt: r.rewardedAt,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
    }));
  }),

  /**
   * Get all rewards earned by the current user
   */
  getMyRewards: protectedProcedure.query(async ({ ctx }) => {
    const rewards = await getUserReferralRewards(ctx.user.id);
    
    return rewards.map(r => ({
      id: r.id,
      referralId: r.referralId,
      rewardType: r.rewardType,
      amount: r.amount,
      currency: r.currency,
      status: r.status,
      description: r.description,
      processedAt: r.processedAt,
      createdAt: r.createdAt,
    }));
  }),

  /**
   * Get referral statistics for the current user
   */
  getMyStats: protectedProcedure.query(async ({ ctx }) => {
    return await getUserReferralStats(ctx.user.id);
  }),

  /**
   * Share referral code via different channels
   */
  shareReferralCode: protectedProcedure
    .input(
      z.object({
        channel: z.enum(["email", "sms", "whatsapp", "copy"]),
        recipient: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const referralCode = await getUserReferralCode(ctx.user.id);

      if (!referralCode) {
        throw new Error("No referral code found");
      }

      const shareUrl = `${process.env.VITE_APP_URL || "https://vpp-platform.com"}/signup?ref=${referralCode.referralCode}`;
      const message = `Join VPP Consumer Platform and earn rewards! Use my referral code: ${referralCode.referralCode} or click: ${shareUrl}`;

      // 'copy' just returns the text for the client to copy — nothing to send.
      if (input.channel === "copy") {
        return {
          success: true,
          channel: input.channel,
          message,
          shareUrl,
          referralCode: referralCode.referralCode,
        };
      }

      // Email channel: actually send via the configured email service.
      if (input.channel === "email") {
        if (!input.recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.recipient)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "A valid recipient email address is required for the email channel",
          });
        }

        const senderName = ctx.user.name || "A VPP Platform user";
        const result = await sendEmail({
          to: input.recipient,
          subject: `${senderName} invited you to VPP Consumer Platform`,
          html: wrapEmailTemplate(
            `<p>${senderName} has invited you to join VPP Consumer Platform.</p>
             <p>${message}</p>
             <p><a href="${shareUrl}" class="button">Sign up with this referral</a></p>`,
            "You're invited!"
          ),
          text: message,
        });

        if (!result.success) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Failed to send referral email: ${result.error || "email service unavailable"}`,
          });
        }

        return {
          success: true,
          channel: input.channel,
          message,
          shareUrl,
          referralCode: referralCode.referralCode,
        };
      }

      // sms / whatsapp: no SMS gateway or WhatsApp integration exists in this
      // codebase — fail honestly instead of pretending something was sent.
      return {
        success: false,
        channel: input.channel,
        reason: "channel_not_integrated",
        message,
        shareUrl,
        referralCode: referralCode.referralCode,
      };
    }),
});
