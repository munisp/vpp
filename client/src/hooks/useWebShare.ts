import { useState, useCallback } from 'react';
import { toast } from 'sonner';

interface ShareData {
  title?: string;
  text?: string;
  url?: string;
  files?: File[];
}

interface UseWebShareReturn {
  isSupported: boolean;
  isSharing: boolean;
  share: (data: ShareData) => Promise<boolean>;
  canShareFiles: boolean;
}

/**
 * Hook for using the Web Share API
 * Allows sharing content to other apps on the device
 */
export function useWebShare(): UseWebShareReturn {
  const [isSharing, setIsSharing] = useState(false);

  // Check if Web Share API is supported
  const isSupported = typeof navigator !== 'undefined' && 'share' in navigator;

  // Check if file sharing is supported
  const canShareFiles = isSupported && navigator.canShare && typeof navigator.canShare === 'function';

  const share = useCallback(async (data: ShareData): Promise<boolean> => {
    if (!isSupported) {
      toast.error('Sharing is not supported on this device');
      return false;
    }

    setIsSharing(true);

    try {
      // Validate data
      const shareData: ShareData = {};

      if (data.title) shareData.title = data.title;
      if (data.text) shareData.text = data.text;
      if (data.url) shareData.url = data.url;
      if (data.files && canShareFiles) {
        // Check if files can be shared
        if (navigator.canShare?.({ files: data.files })) {
          shareData.files = data.files;
        } else {
          console.warn('File sharing not supported for these files');
        }
      }

      // Share
      await navigator.share(shareData);
      return true;
    } catch (error: any) {
      // User cancelled or error occurred
      if (error.name === 'AbortError') {
        // User cancelled, don't show error
        return false;
      }
      
      console.error('Share failed:', error);
      toast.error('Failed to share');
      return false;
    } finally {
      setIsSharing(false);
    }
  }, [isSupported, canShareFiles]);

  return {
    isSupported,
    isSharing,
    share,
    canShareFiles,
  };
}

/**
 * Helper functions for common share scenarios
 */

export function shareTradeOpportunity(
  assetType: string,
  price: number,
  capacity: number,
  share: (data: ShareData) => Promise<boolean>
) {
  const currentUrl = window.location.origin;
  return share({
    title: `Trade Opportunity: ${assetType}`,
    text: `Check out this ${assetType} trade opportunity! ${capacity}kW at $${price}/kWh`,
    url: `${currentUrl}/trading`,
  });
}

export function sharePaymentRequest(
  amount: number,
  recipient: string,
  reference: string,
  share: (data: ShareData) => Promise<boolean>
) {
  const currentUrl = window.location.origin;
  // Generate payment URL with parameters
  const paymentUrl = `${currentUrl}/qr-payment?amount=${amount}&recipient=${encodeURIComponent(recipient)}&reference=${encodeURIComponent(reference)}`;
  
  return share({
    title: 'Payment Request',
    text: `Payment request for $${amount} from ${recipient}`,
    url: paymentUrl,
  });
}

export function shareDeviceReferral(
  deviceName: string,
  deviceType: string,
  share: (data: ShareData) => Promise<boolean>
) {
  const currentUrl = window.location.origin;
  return share({
    title: `Join VPP Platform with ${deviceName}`,
    text: `I'm using ${deviceName} (${deviceType}) on VPP Platform to earn from my solar energy. Join me!`,
    url: `${currentUrl}/assets`,
  });
}

export function shareDREvent(
  eventName: string,
  reward: number,
  startTime: string,
  share: (data: ShareData) => Promise<boolean>
) {
  const currentUrl = window.location.origin;
  return share({
    title: `Demand Response Event: ${eventName}`,
    text: `Join this DR event and earn $${reward}! Starts at ${startTime}`,
    url: `${currentUrl}/demand-response`,
  });
}

export function shareAchievement(
  achievementName: string,
  description: string,
  share: (data: ShareData) => Promise<boolean>
) {
  const currentUrl = window.location.origin;
  return share({
    title: `Achievement Unlocked: ${achievementName}`,
    text: `I just unlocked "${achievementName}" on VPP Platform! ${description}`,
    url: `${currentUrl}/leaderboard`,
  });
}
