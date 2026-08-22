import { z } from 'zod';
import { protectedProcedure, publicProcedure, router } from '../_core/trpc';
import { getDb } from '../db';
import { pushSubscriptions } from '../../drizzle/schema';
import { eq } from 'drizzle-orm';
import webpush from 'web-push';

// Configure web-push with VAPID keys
// In production, these should be stored securely in environment variables
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:admin@vpp-platform.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

const pushSubscriptionSchema = z.object({
  endpoint: z.string(),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string(),
    auth: z.string(),
  }),
});

export const notificationsRouter = router({
  // Subscribe to push notifications
  subscribePush: protectedProcedure
    .input(z.object({
      subscription: pushSubscriptionSchema,
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      const userId = ctx.user.id;
      const { subscription } = input;

      // Store subscription in database
      await db.insert(pushSubscriptions).values({
        userId,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        expirationTime: subscription.expirationTime ? new Date(subscription.expirationTime) : null,
      }).onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
          expirationTime: subscription.expirationTime ? new Date(subscription.expirationTime) : null,
          updatedAt: new Date(),
        },
      });

      return { success: true };
    }),

  // Unsubscribe from push notifications
  unsubscribePush: protectedProcedure
    .mutation(async ({ ctx }) => {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      const userId = ctx.user.id;

      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));

      return { success: true };
    }),

  // Send test push notification
  sendTestPush: protectedProcedure
    .mutation(async ({ ctx }) => {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      const userId = ctx.user.id;

      // Get user's push subscriptions
      const subscriptions = await db
        .select()
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, userId));

      if (subscriptions.length === 0) {
        throw new Error('No push subscriptions found');
      }

      // Send notification to all user's devices
      const payload = JSON.stringify({
        title: 'Test Notification',
        body: 'This is a test notification from VPP Platform',
        icon: '/icons/icon-192x192.png',
        badge: '/icons/icon-96x96.png',
        data: {
          url: '/',
          timestamp: Date.now(),
        },
      });

      const results = await Promise.allSettled(
        subscriptions.map(sub =>
          webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: {
                p256dh: sub.p256dh,
                auth: sub.auth,
              },
            },
            payload
          )
        )
      );

      // Remove failed subscriptions (expired or invalid)
      const failedIndices = results
        .map((result, index) => (result.status === 'rejected' ? index : -1))
        .filter(index => index !== -1);

      if (failedIndices.length > 0) {
        await Promise.all(
          failedIndices.map(index =>
            db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, subscriptions[index].id))
          )
        );
      }

      return {
        success: true,
        sent: results.filter(r => r.status === 'fulfilled').length,
        failed: failedIndices.length,
      };
    }),

  // Get push subscription status
  getPushStatus: protectedProcedure
    .query(async ({ ctx }) => {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      const userId = ctx.user.id;

      const subscriptions = await db
        .select()
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, userId));

      return {
        isSubscribed: subscriptions.length > 0,
        deviceCount: subscriptions.length,
      };
    }),
});

// Helper function to send push notification to user
export async function sendPushNotification(
  userId: number,
  notification: {
    title: string;
    body: string;
    icon?: string;
    badge?: string;
    data?: any;
  }
) {
  const db = await getDb();
  if (!db) return;

  const subscriptions = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));

  if (subscriptions.length === 0) return;

  const payload = JSON.stringify({
    title: notification.title,
    body: notification.body,
    icon: notification.icon || '/icons/icon-192x192.png',
    badge: notification.badge || '/icons/icon-96x96.png',
    data: notification.data || {},
  });

  const results = await Promise.allSettled(
    subscriptions.map(sub =>
      webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth,
          },
        },
        payload
      )
    )
  );

  // Remove failed subscriptions
  const failedIndices = results
    .map((result, index) => (result.status === 'rejected' ? index : -1))
    .filter(index => index !== -1);

  if (failedIndices.length > 0) {
    await Promise.all(
      failedIndices.map(index =>
        db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, subscriptions[index].id))
      )
    );
  }
}
