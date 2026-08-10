import { initializeApp, getApps, FirebaseApp } from 'firebase/app';
import { getAnalytics, Analytics, logEvent as firebaseLogEvent, setUserId, setUserProperties } from 'firebase/analytics';

// Firebase configuration
// Replace these with your actual Firebase project credentials
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyDemoKey-Replace-With-Your-Key",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "vpp-platform.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "vpp-platform",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "vpp-platform.appspot.com",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "123456789012",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:123456789012:web:abcdef123456",
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || "G-XXXXXXXXXX"
};

let app: FirebaseApp | null = null;
let analytics: Analytics | null = null;

// Initialize Firebase
export function initializeFirebase() {
  if (typeof window === 'undefined') {
    return null;
  }

  if (getApps().length === 0) {
    app = initializeApp(firebaseConfig);
    
    // Initialize Analytics only in browser
    if (typeof window !== 'undefined' && 'measurementId' in firebaseConfig) {
      analytics = getAnalytics(app);
    }
  }

  return { app, analytics };
}

// Get Firebase app instance
export function getFirebaseApp() {
  if (!app) {
    initializeFirebase();
  }
  return app;
}

// Get Analytics instance
export function getFirebaseAnalytics() {
  if (!analytics) {
    initializeFirebase();
  }
  return analytics;
}

// Analytics helper functions
export const AnalyticsService = {
  // Log custom event
  logEvent: (eventName: string, eventParams?: Record<string, any>) => {
    const analyticsInstance = getFirebaseAnalytics();
    if (analyticsInstance) {
      firebaseLogEvent(analyticsInstance, eventName, eventParams);
    }
  },

  // Set user ID
  setUserId: (userId: string) => {
    const analyticsInstance = getFirebaseAnalytics();
    if (analyticsInstance) {
      setUserId(analyticsInstance, userId);
    }
  },

  // Set user properties
  setUserProperties: (properties: Record<string, any>) => {
    const analyticsInstance = getFirebaseAnalytics();
    if (analyticsInstance) {
      setUserProperties(analyticsInstance, properties);
    }
  },

  // Page view
  logPageView: (pageName: string, pageTitle?: string) => {
    AnalyticsService.logEvent('page_view', {
      page_name: pageName,
      page_title: pageTitle || pageName,
      page_location: window.location.href,
      page_path: window.location.pathname,
    });
  },

  // User actions
  logUserAction: (action: string, category: string, label?: string, value?: number) => {
    AnalyticsService.logEvent('user_action', {
      action,
      category,
      label,
      value,
    });
  },

  // Trading events
  logTradeCreated: (tradeType: 'buy' | 'sell', quantity: number, price: number) => {
    AnalyticsService.logEvent('trade_created', {
      trade_type: tradeType,
      quantity,
      price,
      total_value: quantity * price,
    });
  },

  logTradeCompleted: (tradeType: 'buy' | 'sell', quantity: number, price: number, tradeId: string) => {
    AnalyticsService.logEvent('trade_completed', {
      trade_type: tradeType,
      quantity,
      price,
      total_value: quantity * price,
      trade_id: tradeId,
    });
  },

  logTradeFailed: (tradeType: 'buy' | 'sell', reason: string) => {
    AnalyticsService.logEvent('trade_failed', {
      trade_type: tradeType,
      failure_reason: reason,
    });
  },

  // Payment events
  logPaymentInitiated: (method: string, amount: number, currency: string = 'TZS') => {
    AnalyticsService.logEvent('payment_initiated', {
      payment_method: method,
      amount,
      currency,
    });
  },

  logPaymentCompleted: (method: string, amount: number, transactionId: string, currency: string = 'TZS') => {
    AnalyticsService.logEvent('payment_completed', {
      payment_method: method,
      amount,
      currency,
      transaction_id: transactionId,
    });
  },

  logPaymentFailed: (method: string, amount: number, reason: string) => {
    AnalyticsService.logEvent('payment_failed', {
      payment_method: method,
      amount,
      failure_reason: reason,
    });
  },

  // Asset management events
  logAssetRegistered: (assetType: string, capacity: number) => {
    AnalyticsService.logEvent('asset_registered', {
      asset_type: assetType,
      capacity,
    });
  },

  logAssetDeleted: (assetType: string, assetId: string) => {
    AnalyticsService.logEvent('asset_deleted', {
      asset_type: assetType,
      asset_id: assetId,
    });
  },

  // DR participation events
  logDREventEnrolled: (eventId: string, eventType: string, compensation: number) => {
    AnalyticsService.logEvent('dr_event_enrolled', {
      event_id: eventId,
      event_type: eventType,
      compensation,
    });
  },

  logDREventCompleted: (eventId: string, eventType: string, earnedAmount: number) => {
    AnalyticsService.logEvent('dr_event_completed', {
      event_id: eventId,
      event_type: eventType,
      earned_amount: earnedAmount,
    });
  },

  // Gamification events
  logAchievementUnlocked: (achievementId: string, achievementName: string, points: number) => {
    AnalyticsService.logEvent('achievement_unlocked', {
      achievement_id: achievementId,
      achievement_name: achievementName,
      points,
    });
  },

  logLeaderboardViewed: (timeframe: string) => {
    AnalyticsService.logEvent('leaderboard_viewed', {
      timeframe,
    });
  },

  // P2P Trading events
  logP2POfferCreated: (offerType: 'buy' | 'sell', quantity: number, price: number) => {
    AnalyticsService.logEvent('p2p_offer_created', {
      offer_type: offerType,
      quantity,
      price,
    });
  },

  logP2POfferAccepted: (offerId: string, offerType: 'buy' | 'sell', quantity: number, price: number) => {
    AnalyticsService.logEvent('p2p_offer_accepted', {
      offer_id: offerId,
      offer_type: offerType,
      quantity,
      price,
    });
  },

  // Share events
  logContentShared: (contentType: string, method: string) => {
    AnalyticsService.logEvent('share', {
      content_type: contentType,
      method,
    });
  },

  // QR Scanner events
  logQRScanned: (scanType: 'payment' | 'device', success: boolean) => {
    AnalyticsService.logEvent('qr_scanned', {
      scan_type: scanType,
      success,
    });
  },

  // Push notification events
  logNotificationReceived: (notificationType: string) => {
    AnalyticsService.logEvent('notification_received', {
      notification_type: notificationType,
    });
  },

  logNotificationOpened: (notificationType: string) => {
    AnalyticsService.logEvent('notification_opened', {
      notification_type: notificationType,
    });
  },

  // Error tracking
  logError: (errorType: string, errorMessage: string, errorContext?: Record<string, any>) => {
    AnalyticsService.logEvent('error', {
      error_type: errorType,
      error_message: errorMessage,
      ...errorContext,
    });
  },

  // Search events
  logSearch: (searchTerm: string, category?: string) => {
    AnalyticsService.logEvent('search', {
      search_term: searchTerm,
      category,
    });
  },

  // Engagement metrics
  logEngagement: (engagementType: string, duration?: number) => {
    AnalyticsService.logEvent('engagement', {
      engagement_type: engagementType,
      duration,
    });
  },
};

// Initialize Firebase on module load
if (typeof window !== 'undefined') {
  initializeFirebase();
}

export default AnalyticsService;
