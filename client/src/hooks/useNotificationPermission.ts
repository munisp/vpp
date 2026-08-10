import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

export function useNotificationPermission() {
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [isSupported, setIsSupported] = useState(false);
  const [isSubscribed, setIsSubscribed] = useState(false);

  const subscribeMutation = trpc.notifications.subscribePush.useMutation({
    onSuccess: () => {
      setIsSubscribed(true);
      toast.success("Notifications enabled successfully!");
    },
    onError: (error: any) => {
      toast.error(error.message || "Failed to enable notifications");
    },
  });

  const unsubscribeMutation = trpc.notifications.unsubscribePush.useMutation({
    onSuccess: () => {
      setIsSubscribed(false);
      toast.success("Notifications disabled");
    },
    onError: (error: any) => {
      toast.error(error.message || "Failed to disable notifications");
    },
  });

  useEffect(() => {
    // Check if notifications are supported
    if ("Notification" in window && "serviceWorker" in navigator) {
      setIsSupported(true);
      setPermission(Notification.permission);
    }
  }, []);

  const requestPermission = async () => {
    if (!isSupported) {
      toast.error("Notifications are not supported in this browser");
      return false;
    }

    try {
      const result = await Notification.requestPermission();
      setPermission(result);

      if (result === "granted") {
        // Register service worker and subscribe to push notifications
        const registration = await navigator.serviceWorker.ready;
        
        // Get or create push subscription
        let subscription = await registration.pushManager.getSubscription();
        
        if (!subscription) {
          // Create new subscription
          const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY || "";
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as any,
          });
        }

        // Send subscription to backend
        await subscribeMutation.mutateAsync({
          subscription: {
            endpoint: subscription.endpoint,
            expirationTime: subscription.expirationTime,
            keys: {
              p256dh: arrayBufferToBase64(subscription.getKey("p256dh")!),
              auth: arrayBufferToBase64(subscription.getKey("auth")!),
            },
          },
        });

        return true;
      } else if (result === "denied") {
        toast.error("Notification permission denied. Please enable it in browser settings.");
        return false;
      }
    } catch (error: any) {
      console.error("Error requesting notification permission:", error);
      toast.error("Failed to enable notifications");
      return false;
    }

    return false;
  };

  const unsubscribe = async () => {
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      
      if (subscription) {
        await subscription.unsubscribe();
        await unsubscribeMutation.mutateAsync();
      }
    } catch (error: any) {
      console.error("Error unsubscribing from notifications:", error);
      toast.error("Failed to disable notifications");
    }
  };

  return {
    permission,
    isSupported,
    isSubscribed,
    requestPermission,
    unsubscribe,
    isLoading: subscribeMutation.isPending || unsubscribeMutation.isPending,
  };
}

// Helper functions
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}
