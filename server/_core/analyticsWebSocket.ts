/**
 * Analytics WebSocket Helper
 * Emit real-time analytics updates to connected clients
 */

import { getIO } from "./websocket";

export interface AnalyticsUpdate {
  type: 'qr_transaction' | 'referral_update' | 'reward_earned';
  userId: number;
  data: any;
  timestamp: Date;
}

/**
 * Emit analytics update to a specific user
 */
export function emitAnalyticsUpdate(update: AnalyticsUpdate) {
  const io = getIO();
  if (!io) {
    console.warn('[Analytics WebSocket] Socket.IO not initialized');
    return;
  }

  // Emit to user's analytics room
  io.to(`analytics:${update.userId}`).emit('analytics:update', {
    ...update,
    timestamp: update.timestamp.toISOString(),
  });

  console.log(`[Analytics WebSocket] Sent ${update.type} update to user ${update.userId}`);
}

/**
 * Emit QR transaction update
 */
export function emitQRTransactionUpdate(userId: number, transaction: any) {
  emitAnalyticsUpdate({
    type: 'qr_transaction',
    userId,
    data: transaction,
    timestamp: new Date(),
  });
}

/**
 * Emit referral update
 */
export function emitReferralUpdate(userId: number, referral: any) {
  emitAnalyticsUpdate({
    type: 'referral_update',
    userId,
    data: referral,
    timestamp: new Date(),
  });
}

/**
 * Emit reward earned notification
 */
export function emitRewardEarned(userId: number, reward: any) {
  emitAnalyticsUpdate({
    type: 'reward_earned',
    userId,
    data: reward,
    timestamp: new Date(),
  });
}
