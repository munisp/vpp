import { z } from 'zod';
import { protectedProcedure, router } from '../_core/trpc';
import { getDb } from '../db';
import { notificationPreferences } from '../../drizzle/schema';
import { eq } from 'drizzle-orm';

const updatePreferencesSchema = z.object({
  tradingAlerts: z.boolean().optional(),
  paymentNotifications: z.boolean().optional(),
  demandResponseEvents: z.boolean().optional(),
  systemAlerts: z.boolean().optional(),
});

export const notificationPreferencesRouter = router({
  // Get user's notification preferences
  getPreferences: protectedProcedure
    .query(async ({ ctx }) => {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      const userId = ctx.user.id;

      // Get existing preferences
      const prefs = await db
        .select()
        .from(notificationPreferences)
        .where(eq(notificationPreferences.userId, userId))
        .limit(1);

      if (prefs.length > 0) {
        return {
          tradingAlerts: prefs[0].pushPaymentReceived, // Map to existing schema
          paymentNotifications: prefs[0].pushPaymentReceived,
          demandResponseEvents: prefs[0].pushDREventReminder,
          systemAlerts: prefs[0].pushAchievementUnlocked,
        };
      }

      // Return defaults if no preferences exist
      return {
        tradingAlerts: true,
        paymentNotifications: true,
        demandResponseEvents: true,
        systemAlerts: true,
      };
    }),

  // Update user's notification preferences
  updatePreferences: protectedProcedure
    .input(updatePreferencesSchema)
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      const userId = ctx.user.id;

      // Check if preferences exist
      const existing = await db
        .select()
        .from(notificationPreferences)
        .where(eq(notificationPreferences.userId, userId))
        .limit(1);

      if (existing.length > 0) {
        // Update existing preferences
        const updateData: any = {};
        
        if (input.tradingAlerts !== undefined) {
          updateData.pushPaymentReceived = input.tradingAlerts;
        }
        if (input.paymentNotifications !== undefined) {
          updateData.pushPaymentReceived = input.paymentNotifications;
        }
        if (input.demandResponseEvents !== undefined) {
          updateData.pushDREventReminder = input.demandResponseEvents;
          updateData.pushDREventCreated = input.demandResponseEvents;
        }
        if (input.systemAlerts !== undefined) {
          updateData.pushAchievementUnlocked = input.systemAlerts;
        }

        await db
          .update(notificationPreferences)
          .set(updateData)
          .where(eq(notificationPreferences.userId, userId));
      } else {
        // Create new preferences
        await db.insert(notificationPreferences).values({
          userId,
          pushPaymentReceived: input.paymentNotifications ?? true,
          pushAchievementUnlocked: input.systemAlerts ?? true,
          pushDREventReminder: input.demandResponseEvents ?? true,
          pushDREventCreated: input.demandResponseEvents ?? true,
          pushLeaderboardRankChange: false,
        });
      }

      return { success: true };
    }),

  // Reset preferences to defaults
  resetPreferences: protectedProcedure
    .mutation(async ({ ctx }) => {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      const userId = ctx.user.id;

      await db
        .update(notificationPreferences)
        .set({
          pushPaymentReceived: true,
          pushAchievementUnlocked: true,
          pushDREventReminder: true,
          pushDREventCreated: true,
          pushLeaderboardRankChange: false,
        })
        .where(eq(notificationPreferences.userId, userId));

      return { success: true };
    }),
});
