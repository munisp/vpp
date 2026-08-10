import webpush from 'web-push';
import { getDb } from '../db';
import { pushSubscriptions, notificationPreferences, users } from '../../drizzle/schema';
import { eq } from 'drizzle-orm';

// Configure web-push with VAPID keys
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:admin@vpp-platform.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

export interface NotificationPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  data?: Record<string, any>;
  actions?: Array<{
    action: string;
    title: string;
    icon?: string;
  }>;
}

/**
 * Check if current time is within user's quiet hours
 */
function isWithinQuietHours(quietHoursStart: string, quietHoursEnd: string, userTimezone: string): boolean {
  try {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { 
      hour12: false, 
      timeZone: userTimezone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    // Convert HH:MM:SS to minutes since midnight for comparison
    const toMinutes = (time: string) => {
      const [h, m] = time.split(':').map(Number);
      return h * 60 + m;
    };

    const currentMinutes = toMinutes(timeStr);
    const startMinutes = toMinutes(quietHoursStart);
    const endMinutes = toMinutes(quietHoursEnd);

    // Handle quiet hours that span midnight
    if (startMinutes > endMinutes) {
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }

    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } catch (error) {
    console.error('[Notifications] Error checking quiet hours:', error);
    return false;
  }
}

/**
 * Send push notification to a specific user
 */
export async function sendPushNotification(
  userId: number,
  payload: NotificationPayload,
  notificationType?: 'pushTradeExecuted' | 'pushTradeFailed' | 'pushPaymentReceived' | 'pushDREventCreated' | 'pushDREventReminder' | 'pushSystemAlert' | 'pushBillingAlert' | 'pushAchievementUnlocked'
): Promise<{ success: boolean; sentCount: number; errors: number }> {
  const db = await getDb();
  if (!db) {
    console.error('[Notifications] Database not available');
    return { success: false, sentCount: 0, errors: 0 };
  }

  try {
    // Check user preferences
    const prefsResult = await db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, userId))
      .limit(1);

    const prefs = prefsResult[0];

    // Check if notification type is enabled (default to true if no preferences)
    if (prefs && notificationType && prefs[notificationType] === false) {
      console.log(`[Notifications] Type ${notificationType} disabled for user ${userId}`);
      return { success: true, sentCount: 0, errors: 0 };
    }

    // Check quiet hours
    if (prefs && prefs.quietHoursEnabled && prefs.quietHoursStart && prefs.quietHoursEnd) {
      const userResult = await db
        .select({ timezone: users.timezone })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      const userTimezone = userResult[0]?.timezone || 'UTC';

      if (isWithinQuietHours(prefs.quietHoursStart, prefs.quietHoursEnd, userTimezone)) {
        console.log(`[Notifications] User ${userId} in quiet hours, skipping`);
        return { success: true, sentCount: 0, errors: 0 };
      }
    }

    // Get all push subscriptions for the user
    const subscriptions = await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));

    if (subscriptions.length === 0) {
      console.log(`[Notifications] No push subscriptions found for user ${userId}`);
      return { success: true, sentCount: 0, errors: 0 };
    }

    // Prepare notification payload
    const notificationPayload = JSON.stringify({
      title: payload.title,
      body: payload.body,
      icon: payload.icon || '/icons/icon-192x192.png',
      badge: payload.badge || '/icons/icon-96x96.png',
      data: {
        ...payload.data,
        timestamp: Date.now(),
      },
      actions: payload.actions || [],
    });

    // Send notification to all user's devices
    let sentCount = 0;
    let errors = 0;

    await Promise.all(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: {
                p256dh: sub.p256dh,
                auth: sub.auth,
              },
            },
            notificationPayload
          );
          sentCount++;
        } catch (error: any) {
          errors++;
          console.error(`[Notifications] Failed to send to subscription ${sub.id}:`, error.message);
          
          // If subscription is invalid (410 Gone), remove it
          if (error.statusCode === 410) {
            await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
            console.log(`[Notifications] Removed invalid subscription ${sub.id}`);
          }
        }
      })
    );

    console.log(`[Notifications] Sent ${sentCount} notifications to user ${userId}, ${errors} errors`);
    return { success: true, sentCount, errors };
  } catch (error: any) {
    console.error('[Notifications] Error sending push notifications:', error);
    return { success: false, sentCount: 0, errors: 1 };
  }
}

/**
 * Send push notification to multiple users
 */
export async function sendPushNotificationToUsers(
  userIds: number[],
  payload: NotificationPayload
): Promise<{ success: boolean; totalSent: number; totalErrors: number }> {
  let totalSent = 0;
  let totalErrors = 0;

  await Promise.all(
    userIds.map(async (userId) => {
      const result = await sendPushNotification(userId, payload);
      totalSent += result.sentCount;
      totalErrors += result.errors;
    })
  );

  return { success: true, totalSent, totalErrors };
}
