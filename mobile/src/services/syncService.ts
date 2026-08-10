import NetInfo from '@react-native-community/netinfo';
import { OfflineStorage, PendingAction } from './offlineStorage';
import { trpcClient } from './trpc';

/**
 * Background Sync Service
 * Handles synchronization of offline data when connection is restored
 */
export class SyncService {
  private static syncInProgress = false;
  private static syncInterval: NodeJS.Timeout | null = null;

  /**
   * Initialize sync service
   * Sets up network listener and periodic sync
   */
  static initialize(): void {
    // Listen for network changes
    NetInfo.addEventListener((state) => {
      if (state.isConnected && !this.syncInProgress) {
        this.syncPendingActions();
      }
    });

    // Periodic sync every 5 minutes
    this.syncInterval = setInterval(() => {
      this.syncPendingActions();
    }, 5 * 60 * 1000);
  }

  /**
   * Stop sync service
   */
  static stop(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  /**
   * Check if device is online
   */
  static async isOnline(): Promise<boolean> {
    const state = await NetInfo.fetch();
    return state.isConnected ?? false;
  }

  /**
   * Sync all pending actions
   */
  static async syncPendingActions(): Promise<void> {
    if (this.syncInProgress) {
      console.log('[Sync] Sync already in progress');
      return;
    }

    const isOnline = await this.isOnline();
    if (!isOnline) {
      console.log('[Sync] Device is offline, skipping sync');
      return;
    }

    this.syncInProgress = true;
    console.log('[Sync] Starting sync...');

    try {
      const pendingActions = await OfflineStorage.getPendingActions();
      console.log(`[Sync] Found ${pendingActions.length} pending actions`);

      for (const action of pendingActions) {
        try {
          await this.processPendingAction(action);
          await OfflineStorage.removePendingAction(action.id);
          console.log(`[Sync] Successfully synced action ${action.id}`);
        } catch (error) {
          console.error(`[Sync] Failed to sync action ${action.id}:`, error);
          
          // Increment retry count
          await OfflineStorage.incrementRetryCount(action.id);
          
          // Remove if exceeded max retries (5)
          if (action.retryCount >= 5) {
            console.log(`[Sync] Removing action ${action.id} after 5 failed attempts`);
            await OfflineStorage.removePendingAction(action.id);
          }
        }
      }

      // Update last sync timestamp
      await OfflineStorage.updateLastSync();
      console.log('[Sync] Sync completed');
    } catch (error) {
      console.error('[Sync] Sync failed:', error);
    } finally {
      this.syncInProgress = false;
    }
  }

  /**
   * Process a single pending action
   */
  private static async processPendingAction(action: PendingAction): Promise<void> {
    switch (action.type) {
      case 'register_asset':
        await trpcClient.assets.register.mutate(action.data);
        break;

      case 'create_trade':
        await trpcClient.trading.createTrade.mutate(action.data);
        break;

      case 'participate_dr':
        await trpcClient.demandResponse.participate.mutate(action.data);
        break;

      case 'initiate_payment':
        await trpcClient.paymentProcessing.initiatePayment.mutate(action.data);
        break;

      default:
        console.warn(`[Sync] Unknown action type: ${action.type}`);
    }
  }

  /**
   * Force sync now
   */
  static async forceSyncNow(): Promise<void> {
    await this.syncPendingActions();
  }

  /**
   * Sync fresh data from server
   */
  static async syncFromServer(): Promise<void> {
    const isOnline = await this.isOnline();
    if (!isOnline) {
      console.log('[Sync] Device is offline, using cached data');
      return;
    }

    try {
      // Fetch and cache assets
      const assets = await trpcClient.assets.list.query();
      await OfflineStorage.saveAssets(assets);

      // Fetch and cache trades
      const trades = await trpcClient.trading.getTrades.query({ status: 'active' });
      await OfflineStorage.saveTrades(trades);

      // Fetch and cache DR events
      const drEvents = await trpcClient.demandResponse.getEvents.query({ status: 'active' });
      await OfflineStorage.saveDREvents(drEvents);

      // Fetch and cache telemetry for each asset
      for (const asset of assets) {
        const telemetry = await trpcClient.monitoring.getTelemetry.query({
          assetId: asset.id,
          hours: 24,
        });
        await OfflineStorage.saveTelemetry(asset.id, telemetry);
      }

      await OfflineStorage.updateLastSync();
      console.log('[Sync] Fresh data synced from server');
    } catch (error) {
      console.error('[Sync] Failed to sync from server:', error);
    }
  }

  /**
   * Get sync status
   */
  static async getSyncStatus(): Promise<{
    isOnline: boolean;
    isSyncing: boolean;
    pendingActionsCount: number;
    lastSync: number | null;
  }> {
    const isOnline = await this.isOnline();
    const pendingActions = await OfflineStorage.getPendingActions();
    const lastSync = await OfflineStorage.getLastSync();

    return {
      isOnline,
      isSyncing: this.syncInProgress,
      pendingActionsCount: pendingActions.length,
      lastSync,
    };
  }
}
