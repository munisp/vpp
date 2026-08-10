import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';

export interface PushSubscriptionState {
  isSupported: boolean;
  isSubscribed: boolean;
  isLoading: boolean;
  permission: NotificationPermission;
}

export function usePushNotifications() {
  const [state, setState] = useState<PushSubscriptionState>({
    isSupported: false,
    isSubscribed: false,
    isLoading: true,
    permission: 'default',
  });

  const utils = trpc.useUtils();
  const subscribeMutation = trpc.notifications?.subscribePush.useMutation();
  const unsubscribeMutation = trpc.notifications?.unsubscribePush.useMutation();

  useEffect(() => {
    checkPushSupport();
  }, []);

  const checkPushSupport = async () => {
    const isSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    
    if (!isSupported) {
      setState(prev => ({ ...prev, isSupported: false, isLoading: false }));
      return;
    }

    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      const permission = Notification.permission;

      setState({
        isSupported: true,
        isSubscribed: !!subscription,
        isLoading: false,
        permission,
      });
    } catch (error) {
      console.error('[Push] Error checking support:', error);
      setState(prev => ({ ...prev, isSupported: true, isLoading: false }));
    }
  };

  const requestPermission = async (): Promise<boolean> => {
    if (!state.isSupported) {
      return false;
    }

    try {
      const permission = await Notification.requestPermission();
      setState(prev => ({ ...prev, permission }));
      return permission === 'granted';
    } catch (error) {
      console.error('[Push] Error requesting permission:', error);
      return false;
    }
  };

  const subscribe = async (): Promise<boolean> => {
    if (!state.isSupported) {
      console.error('[Push] Push notifications not supported');
      return false;
    }

    setState(prev => ({ ...prev, isLoading: true }));

    try {
      // Request permission if not granted
      if (state.permission !== 'granted') {
        const granted = await requestPermission();
        if (!granted) {
          setState(prev => ({ ...prev, isLoading: false }));
          return false;
        }
      }

      // Get service worker registration
      const registration = await navigator.serviceWorker.ready;

      // Subscribe to push notifications
      const vapidKey = process.env.VITE_VAPID_PUBLIC_KEY || '';
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKey ? (urlBase64ToUint8Array(vapidKey) as any) : undefined,
      });

      // Send subscription to backend
      await subscribeMutation.mutateAsync({
        subscription: JSON.parse(JSON.stringify(subscription)),
      });

      setState(prev => ({ ...prev, isSubscribed: true, isLoading: false }));
      return true;
    } catch (error) {
      console.error('[Push] Error subscribing:', error);
      setState(prev => ({ ...prev, isLoading: false }));
      return false;
    }
  };

  const unsubscribe = async (): Promise<boolean> => {
    if (!state.isSupported || !state.isSubscribed) {
      return false;
    }

    setState(prev => ({ ...prev, isLoading: true }));

    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();

      if (subscription) {
        await subscription.unsubscribe();
        await unsubscribeMutation.mutateAsync();
      }

      setState(prev => ({ ...prev, isSubscribed: false, isLoading: false }));
      return true;
    } catch (error) {
      console.error('[Push] Error unsubscribing:', error);
      setState(prev => ({ ...prev, isLoading: false }));
      return false;
    }
  };

  const testNotificationMutation = trpc.notifications?.sendTestPush.useMutation();

  const sendTestNotification = async () => {
    if (!state.isSupported || state.permission !== 'granted') {
      return;
    }

    try {
      await testNotificationMutation.mutateAsync();
    } catch (error) {
      console.error('[Push] Error sending test notification:', error);
    }
  };

  return {
    ...state,
    subscribe,
    unsubscribe,
    requestPermission,
    sendTestNotification,
    refresh: checkPushSupport,
  };
}

// Helper function to convert VAPID key
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
