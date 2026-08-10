import AsyncStorage from '@react-native-async-storage/async-storage';

const KEYS = {
  TELEMETRY: 'offline_telemetry',
  ASSETS: 'offline_assets',
  TRADES: 'offline_trades',
  PAYMENTS: 'offline_payments',
  DR_EVENTS: 'offline_dr_events',
  PENDING_ACTIONS: 'pending_actions',
  LAST_SYNC: 'last_sync',
};

export interface PendingAction {
  id: string;
  type: 'register_asset' | 'create_trade' | 'participate_dr' | 'initiate_payment';
  data: any;
  timestamp: number;
  retryCount: number;
}

/**
 * Offline Storage Service
 * Provides local caching and offline-first capabilities
 */
export class OfflineStorage {
  /**
   * Save telemetry data for offline access
   */
  static async saveTelemetry(assetId: number, data: any[]): Promise<void> {
    try {
      const existing = await this.getTelemetry(assetId);
      const merged = [...data, ...existing].slice(0, 100); // Keep last 100 records
      await AsyncStorage.setItem(
        `${KEYS.TELEMETRY}_${assetId}`,
        JSON.stringify(merged)
      );
    } catch (error) {
      console.error('Failed to save telemetry:', error);
    }
  }

  /**
   * Get cached telemetry data
   */
  static async getTelemetry(assetId: number): Promise<any[]> {
    try {
      const data = await AsyncStorage.getItem(`${KEYS.TELEMETRY}_${assetId}`);
      return data ? JSON.parse(data) : [];
    } catch (error) {
      console.error('Failed to get telemetry:', error);
      return [];
    }
  }

  /**
   * Save assets list for offline access
   */
  static async saveAssets(assets: any[]): Promise<void> {
    try {
      await AsyncStorage.setItem(KEYS.ASSETS, JSON.stringify(assets));
    } catch (error) {
      console.error('Failed to save assets:', error);
    }
  }

  /**
   * Get cached assets
   */
  static async getAssets(): Promise<any[]> {
    try {
      const data = await AsyncStorage.getItem(KEYS.ASSETS);
      return data ? JSON.parse(data) : [];
    } catch (error) {
      console.error('Failed to get assets:', error);
      return [];
    }
  }

  /**
   * Save trades for offline access
   */
  static async saveTrades(trades: any[]): Promise<void> {
    try {
      await AsyncStorage.setItem(KEYS.TRADES, JSON.stringify(trades));
    } catch (error) {
      console.error('Failed to save trades:', error);
    }
  }

  /**
   * Get cached trades
   */
  static async getTrades(): Promise<any[]> {
    try {
      const data = await AsyncStorage.getItem(KEYS.TRADES);
      return data ? JSON.parse(data) : [];
    } catch (error) {
      console.error('Failed to get trades:', error);
      return [];
    }
  }

  /**
   * Save DR events for offline access
   */
  static async saveDREvents(events: any[]): Promise<void> {
    try {
      await AsyncStorage.setItem(KEYS.DR_EVENTS, JSON.stringify(events));
    } catch (error) {
      console.error('Failed to save DR events:', error);
    }
  }

  /**
   * Get cached DR events
   */
  static async getDREvents(): Promise<any[]> {
    try {
      const data = await AsyncStorage.getItem(KEYS.DR_EVENTS);
      return data ? JSON.parse(data) : [];
    } catch (error) {
      console.error('Failed to get DR events:', error);
      return [];
    }
  }

  /**
   * Add pending action to queue (for offline operations)
   */
  static async addPendingAction(action: Omit<PendingAction, 'id' | 'timestamp' | 'retryCount'>): Promise<void> {
    try {
      const pending = await this.getPendingActions();
      const newAction: PendingAction = {
        ...action,
        id: Date.now().toString(),
        timestamp: Date.now(),
        retryCount: 0,
      };
      pending.push(newAction);
      await AsyncStorage.setItem(KEYS.PENDING_ACTIONS, JSON.stringify(pending));
    } catch (error) {
      console.error('Failed to add pending action:', error);
    }
  }

  /**
   * Get all pending actions
   */
  static async getPendingActions(): Promise<PendingAction[]> {
    try {
      const data = await AsyncStorage.getItem(KEYS.PENDING_ACTIONS);
      return data ? JSON.parse(data) : [];
    } catch (error) {
      console.error('Failed to get pending actions:', error);
      return [];
    }
  }

  /**
   * Remove pending action after successful sync
   */
  static async removePendingAction(actionId: string): Promise<void> {
    try {
      const pending = await this.getPendingActions();
      const filtered = pending.filter((a) => a.id !== actionId);
      await AsyncStorage.setItem(KEYS.PENDING_ACTIONS, JSON.stringify(filtered));
    } catch (error) {
      console.error('Failed to remove pending action:', error);
    }
  }

  /**
   * Increment retry count for failed action
   */
  static async incrementRetryCount(actionId: string): Promise<void> {
    try {
      const pending = await this.getPendingActions();
      const updated = pending.map((a) =>
        a.id === actionId ? { ...a, retryCount: a.retryCount + 1 } : a
      );
      await AsyncStorage.setItem(KEYS.PENDING_ACTIONS, JSON.stringify(updated));
    } catch (error) {
      console.error('Failed to increment retry count:', error);
    }
  }

  /**
   * Update last sync timestamp
   */
  static async updateLastSync(): Promise<void> {
    try {
      await AsyncStorage.setItem(KEYS.LAST_SYNC, Date.now().toString());
    } catch (error) {
      console.error('Failed to update last sync:', error);
    }
  }

  /**
   * Get last sync timestamp
   */
  static async getLastSync(): Promise<number | null> {
    try {
      const data = await AsyncStorage.getItem(KEYS.LAST_SYNC);
      return data ? parseInt(data) : null;
    } catch (error) {
      console.error('Failed to get last sync:', error);
      return null;
    }
  }

  /**
   * Clear all offline data
   */
  static async clearAll(): Promise<void> {
    try {
      await AsyncStorage.multiRemove(Object.values(KEYS));
    } catch (error) {
      console.error('Failed to clear offline data:', error);
    }
  }

  /**
   * Get storage info
   */
  static async getStorageInfo(): Promise<{
    telemetryCount: number;
    assetsCount: number;
    tradesCount: number;
    drEventsCount: number;
    pendingActionsCount: number;
    lastSync: number | null;
  }> {
    const assets = await this.getAssets();
    const trades = await this.getTrades();
    const drEvents = await this.getDREvents();
    const pendingActions = await this.getPendingActions();
    const lastSync = await this.getLastSync();

    // Count telemetry across all assets
    let telemetryCount = 0;
    for (const asset of assets) {
      const telemetry = await this.getTelemetry(asset.id);
      telemetryCount += telemetry.length;
    }

    return {
      telemetryCount,
      assetsCount: assets.length,
      tradesCount: trades.length,
      drEventsCount: drEvents.length,
      pendingActionsCount: pendingActions.length,
      lastSync,
    };
  }
}
