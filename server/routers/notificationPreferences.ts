import { z } from 'zod';
import { router, protectedProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import { getDb } from '../db';
import { notificationPreferences } from '../../drizzle/schema';
import { eq } from 'drizzle-orm';

const UpdatePreferencesInputSchema = z.object({
  // Email notifications
  emailPaymentReceived: z.boolean().optional(),
  emailTradeExecuted: z.boolean().optional(),
  emailTradeFailed: z.boolean().optional(),
  emailSystemAlert: z.boolean().optional(),
  emailAchievementUnlocked: z.boolean().optional(),
  emailDREventReminder: z.boolean().optional(),
  emailDREventCreated: z.boolean().optional(),
  emailLeaderboardRankChange: z.boolean().optional(),
  emailWeeklySummary: z.boolean().optional(),
  emailMonthlySummary: z.boolean().optional(),
  
  // Push notifications
  pushPaymentReceived: z.boolean().optional(),
  pushAchievementUnlocked: z.boolean().optional(),
  pushDREventReminder: z.boolean().optional(),
  pushDREventCreated: z.boolean().optional(),
  pushLeaderboardRankChange: z.boolean().optional(),
  pushTradeExecuted: z.boolean().optional(),
  pushTradeFailed: z.boolean().optional(),
  pushSystemAlert: z.boolean().optional(),
  pushBillingAlert: z.boolean().optional(),
  
  // Notification preferences
  notificationSound: z.boolean().optional(),
  notificationFrequency: z.enum(['instant', 'hourly', 'daily']).optional(),
  
  // Quiet hours
  quietHoursEnabled: z.boolean().optional(),
  quietHoursStart: z.string().regex(/^\d{2}:\d{2}:\d{2}$/).optional(), // HH:MM:SS format
  quietHoursEnd: z.string().regex(/^\d{2}:\d{2}:\d{2}$/).optional(),
});

export const notificationPreferencesRouter = router({
  // Get user's notification preferences
  get: protectedProcedure.query(async ({ ctx }) => {
    try {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      const userId = ctx.user.id;

      // Get preferences from database
      const result = await db
        .select()
        .from(notificationPreferences)
        .where(eq(notificationPreferences.userId, userId))
        .limit(1);

      if (result.length === 0) {
        // Return default preferences if none exist
        return {
          userId,
          emailPaymentReceived: true,
          emailTradeExecuted: true,
          emailTradeFailed: true,
          emailSystemAlert: true,
          emailAchievementUnlocked: true,
          emailDREventReminder: true,
          emailDREventCreated: true,
          emailLeaderboardRankChange: true,
          emailWeeklySummary: false,
          emailMonthlySummary: false,
          pushPaymentReceived: true,
          pushAchievementUnlocked: true,
          pushDREventReminder: true,
          pushDREventCreated: true,
          pushLeaderboardRankChange: false,
          pushTradeExecuted: true,
          pushTradeFailed: true,
          pushSystemAlert: true,
          pushBillingAlert: true,
          notificationSound: true,
          notificationFrequency: 'instant' as const,
          quietHoursEnabled: false,
          quietHoursStart: '22:00:00',
          quietHoursEnd: '08:00:00',
        };
      }

      return result[0];
    } catch (error) {
      console.error('Error getting notification preferences:', error);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to retrieve notification preferences.',
      });
    }
  }),

  // Update user's notification preferences
  update: protectedProcedure
    .input(UpdatePreferencesInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const db = await getDb();
        if (!db) throw new Error('Database not available');

        const userId = ctx.user.id;

        // Check if preferences exist
        const existing = await db
          .select()
          .from(notificationPreferences)
          .where(eq(notificationPreferences.userId, userId))
          .limit(1);

        if (existing.length === 0) {
          // Create new preferences
          await db.insert(notificationPreferences).values({
            userId,
            ...input,
          });
        } else {
          // Update existing preferences
          await db
            .update(notificationPreferences)
            .set({
              ...input,
              updatedAt: new Date(),
            })
            .where(eq(notificationPreferences.userId, userId));
        }

        return {
          success: true,
          message: 'Notification preferences updated successfully.',
        };
      } catch (error) {
        console.error('Error updating notification preferences:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update notification preferences.',
        });
      }
    }),

  // Reset preferences to defaults
  reset: protectedProcedure.mutation(async ({ ctx }) => {
    try {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      const userId = ctx.user.id;

      // Delete existing preferences (will use defaults)
      await db
        .delete(notificationPreferences)
        .where(eq(notificationPreferences.userId, userId));

      return {
        success: true,
        message: 'Notification preferences reset to defaults.',
      };
    } catch (error) {
      console.error('Error resetting notification preferences:', error);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to reset notification preferences.',
      });
    }
  }),
});

export type NotificationPreferencesRouter = typeof notificationPreferencesRouter;
