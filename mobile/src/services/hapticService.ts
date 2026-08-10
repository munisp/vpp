import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

/**
 * Haptic Feedback Service
 * Provides tactile feedback for user interactions
 */
export class HapticService {
  /**
   * Check if haptic feedback is available on the device
   */
  static isAvailable(): boolean {
    return Platform.OS === 'ios' || Platform.OS === 'android';
  }

  /**
   * Light impact feedback for subtle interactions
   * Use for: button taps, toggle switches, selections
   */
  static async light(): Promise<void> {
    if (!this.isAvailable()) return;
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (error) {
      console.warn('Haptic feedback error:', error);
    }
  }

  /**
   * Medium impact feedback for standard interactions
   * Use for: confirmations, submissions, completions
   */
  static async medium(): Promise<void> {
    if (!this.isAvailable()) return;
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch (error) {
      console.warn('Haptic feedback error:', error);
    }
  }

  /**
   * Heavy impact feedback for significant interactions
   * Use for: important actions, deletions, errors
   */
  static async heavy(): Promise<void> {
    if (!this.isAvailable()) return;
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    } catch (error) {
      console.warn('Haptic feedback error:', error);
    }
  }

  /**
   * Success notification feedback
   * Use for: successful trades, payments, registrations
   */
  static async success(): Promise<void> {
    if (!this.isAvailable()) return;
    try {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      console.warn('Haptic feedback error:', error);
    }
  }

  /**
   * Warning notification feedback
   * Use for: warnings, cautions, confirmations needed
   */
  static async warning(): Promise<void> {
    if (!this.isAvailable()) return;
    try {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    } catch (error) {
      console.warn('Haptic feedback error:', error);
    }
  }

  /**
   * Error notification feedback
   * Use for: errors, failures, invalid actions
   */
  static async error(): Promise<void> {
    if (!this.isAvailable()) return;
    try {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } catch (error) {
      console.warn('Haptic feedback error:', error);
    }
  }

  /**
   * Selection feedback for scrolling through values
   * Use for: pickers, sliders, scrollable lists
   */
  static async selection(): Promise<void> {
    if (!this.isAvailable()) return;
    try {
      await Haptics.selectionAsync();
    } catch (error) {
      console.warn('Haptic feedback error:', error);
    }
  }

  /**
   * Custom vibration pattern (Android only)
   * @param pattern Array of durations in milliseconds [wait, vibrate, wait, vibrate, ...]
   */
  static async customPattern(pattern: number[]): Promise<void> {
    if (Platform.OS !== 'android') return;
    // Note: Custom patterns require native implementation
    // This is a placeholder for future enhancement
    await this.medium();
  }

  // Convenience methods for common interactions

  /**
   * Button press feedback
   */
  static async buttonPress(): Promise<void> {
    await this.light();
  }

  /**
   * Trade executed feedback
   */
  static async tradeExecuted(): Promise<void> {
    await this.success();
  }

  /**
   * Payment completed feedback
   */
  static async paymentCompleted(): Promise<void> {
    await this.success();
  }

  /**
   * Payment failed feedback
   */
  static async paymentFailed(): Promise<void> {
    await this.error();
  }

  /**
   * Device registered feedback
   */
  static async deviceRegistered(): Promise<void> {
    await this.success();
  }

  /**
   * DR event started feedback
   */
  static async drEventStarted(): Promise<void> {
    await this.warning();
  }

  /**
   * Achievement unlocked feedback
   */
  static async achievementUnlocked(): Promise<void> {
    // Double success feedback for special events
    await this.success();
    setTimeout(() => this.success(), 150);
  }

  /**
   * QR code scanned feedback
   */
  static async qrScanned(): Promise<void> {
    await this.medium();
  }

  /**
   * Delete action feedback
   */
  static async deleteAction(): Promise<void> {
    await this.heavy();
  }

  /**
   * Toggle switch feedback
   */
  static async toggleSwitch(): Promise<void> {
    await this.light();
  }

  /**
   * Pull to refresh feedback
   */
  static async pullToRefresh(): Promise<void> {
    await this.medium();
  }

  /**
   * Notification received feedback
   */
  static async notificationReceived(): Promise<void> {
    await this.medium();
  }

  /**
   * Biometric authentication success
   */
  static async biometricSuccess(): Promise<void> {
    await this.success();
  }

  /**
   * Biometric authentication failed
   */
  static async biometricFailed(): Promise<void> {
    await this.error();
  }

  /**
   * Share action feedback
   */
  static async shareAction(): Promise<void> {
    await this.light();
  }

  /**
   * P2P offer accepted feedback
   */
  static async offerAccepted(): Promise<void> {
    await this.success();
  }

  /**
   * Form validation error feedback
   */
  static async validationError(): Promise<void> {
    await this.error();
  }
}
