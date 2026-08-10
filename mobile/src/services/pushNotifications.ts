import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { trpcClient } from './trpc';

/**
 * Push Notifications Service
 * Handles push notification registration and management
 */
export class PushNotificationsService {
  private static pushToken: string | null = null;

  /**
   * Initialize push notifications
   */
  static async initialize(): Promise<void> {
    // Configure notification handler
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
      }),
    });

    // Request permissions and register
    await this.registerForPushNotifications();
  }

  /**
   * Register for push notifications
   */
  static async registerForPushNotifications(): Promise<string | null> {
    if (!Device.isDevice) {
      console.log('Push notifications only work on physical devices');
      return null;
    }

    try {
      // Request permissions
      const { status: existingStatus } = await Notifications.getPermissionsAsync();
      let finalStatus = existingStatus;

      if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }

      if (finalStatus !== 'granted') {
        console.log('Failed to get push notification permissions');
        return null;
      }

      // Get push token
      const token = await Notifications.getExpoPushTokenAsync({
        projectId: 'your-expo-project-id', // Replace with actual project ID
      });

      this.pushToken = token.data;

      // Configure Android channel
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('default', {
          name: 'default',
          importance: Notifications.AndroidImportance.MAX,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: '#10b981',
        });

        // Create DR events channel
        await Notifications.setNotificationChannelAsync('dr-events', {
          name: 'Demand Response Events',
          importance: Notifications.AndroidImportance.HIGH,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: '#8b5cf6',
        });

        // Create payments channel
        await Notifications.setNotificationChannelAsync('payments', {
          name: 'Payments',
          importance: Notifications.AndroidImportance.HIGH,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: '#10b981',
        });

        // Create alerts channel
        await Notifications.setNotificationChannelAsync('alerts', {
          name: 'System Alerts',
          importance: Notifications.AndroidImportance.MAX,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: '#ef4444',
        });
      }

      // Register token with backend
      await this.registerTokenWithBackend(token.data);

      console.log('Push notification token:', token.data);
      return token.data;
    } catch (error) {
      console.error('Error registering for push notifications:', error);
      return null;
    }
  }

  /**
   * Register push token with backend
   */
  private static async registerTokenWithBackend(token: string): Promise<void> {
    try {
      await trpcClient.system.registerPushToken.mutate({ token });
      console.log('Push token registered with backend');
    } catch (error) {
      console.error('Failed to register push token with backend:', error);
    }
  }

  /**
   * Schedule local notification
   */
  static async scheduleLocalNotification(
    title: string,
    body: string,
    data?: any,
    triggerSeconds?: number
  ): Promise<string> {
    const trigger = triggerSeconds
      ? { seconds: triggerSeconds }
      : null;

    return await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        data,
        sound: true,
        priority: Notifications.AndroidNotificationPriority.HIGH,
      },
      trigger,
    });
  }

  /**
   * Schedule DR event notification
   */
  static async scheduleDREventNotification(
    eventName: string,
    startTime: Date,
    compensationRate: number
  ): Promise<void> {
    const now = new Date();
    const timeUntilEvent = (startTime.getTime() - now.getTime()) / 1000;

    // Notify 30 minutes before event
    if (timeUntilEvent > 1800) {
      await this.scheduleLocalNotification(
        'DR Event Starting Soon',
        `${eventName} starts in 30 minutes. Compensation: ${(compensationRate / 100).toFixed(2)} TZS/kWh`,
        { type: 'dr-event', eventName },
        timeUntilEvent - 1800
      );
    }

    // Notify 5 minutes before event
    if (timeUntilEvent > 300) {
      await this.scheduleLocalNotification(
        'DR Event Starting',
        `${eventName} starts in 5 minutes!`,
        { type: 'dr-event', eventName },
        timeUntilEvent - 300
      );
    }
  }

  /**
   * Notify payment received
   */
  static async notifyPaymentReceived(amount: number, description: string): Promise<void> {
    await this.scheduleLocalNotification(
      'Payment Received',
      `${(amount / 100).toFixed(0)} TZS - ${description}`,
      { type: 'payment' }
    );
  }

  /**
   * Notify trade executed
   */
  static async notifyTradeExecuted(
    type: 'buy' | 'sell',
    quantity: number,
    price: number
  ): Promise<void> {
    await this.scheduleLocalNotification(
      'Trade Executed',
      `${type === 'sell' ? 'Sold' : 'Bought'} ${quantity} kWh @ ${(price / 100).toFixed(2)} TZS/kWh`,
      { type: 'trade' }
    );
  }

  /**
   * Notify asset alert
   */
  static async notifyAssetAlert(assetName: string, message: string): Promise<void> {
    await this.scheduleLocalNotification(
      `Asset Alert: ${assetName}`,
      message,
      { type: 'alert', assetName }
    );
  }

  /**
   * Get notification permissions status
   */
  static async getPermissionsStatus(): Promise<string> {
    const { status } = await Notifications.getPermissionsAsync();
    return status;
  }

  /**
   * Cancel all notifications
   */
  static async cancelAllNotifications(): Promise<void> {
    await Notifications.cancelAllScheduledNotificationsAsync();
  }

  /**
   * Get push token
   */
  static getPushToken(): string | null {
    return this.pushToken;
  }

  /**
   * Add notification received listener
   */
  static addNotificationReceivedListener(
    callback: (notification: Notifications.Notification) => void
  ): Notifications.Subscription {
    return Notifications.addNotificationReceivedListener(callback);
  }

  /**
   * Add notification response listener (when user taps notification)
   */
  static addNotificationResponseListener(
    callback: (response: Notifications.NotificationResponse) => void
  ): Notifications.Subscription {
    return Notifications.addNotificationResponseReceivedListener(callback);
  }
}
