import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

const BIOMETRIC_ENABLED_KEY = 'biometric_enabled';

/**
 * Biometric Authentication Service
 * Handles fingerprint and face recognition authentication
 */
export class BiometricAuthService {
  /**
   * Check if device supports biometric authentication
   */
  static async isAvailable(): Promise<boolean> {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();
    return hasHardware && isEnrolled;
  }

  /**
   * Get supported biometric types
   */
  static async getSupportedTypes(): Promise<string[]> {
    const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
    return types.map((type) => {
      switch (type) {
        case LocalAuthentication.AuthenticationType.FINGERPRINT:
          return 'Fingerprint';
        case LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION:
          return 'Face ID';
        case LocalAuthentication.AuthenticationType.IRIS:
          return 'Iris';
        default:
          return 'Unknown';
      }
    });
  }

  /**
   * Authenticate user with biometrics
   */
  static async authenticate(
    promptMessage: string = 'Authenticate to continue'
  ): Promise<{
    success: boolean;
    error?: string;
  }> {
    try {
      const available = await this.isAvailable();
      if (!available) {
        return {
          success: false,
          error: 'Biometric authentication not available',
        };
      }

      const result = await LocalAuthentication.authenticateAsync({
        promptMessage,
        fallbackLabel: 'Use passcode',
        disableDeviceFallback: false,
      });

      if (result.success) {
        return { success: true };
      } else {
        return {
          success: false,
          error: result.error || 'Authentication failed',
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Enable biometric authentication
   */
  static async enable(): Promise<boolean> {
    try {
      const available = await this.isAvailable();
      if (!available) {
        return false;
      }

      // Test authentication before enabling
      const result = await this.authenticate('Enable biometric authentication');
      if (result.success) {
        await SecureStore.setItemAsync(BIOMETRIC_ENABLED_KEY, 'true');
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to enable biometric auth:', error);
      return false;
    }
  }

  /**
   * Disable biometric authentication
   */
  static async disable(): Promise<void> {
    try {
      await SecureStore.deleteItemAsync(BIOMETRIC_ENABLED_KEY);
    } catch (error) {
      console.error('Failed to disable biometric auth:', error);
    }
  }

  /**
   * Check if biometric authentication is enabled
   */
  static async isEnabled(): Promise<boolean> {
    try {
      const value = await SecureStore.getItemAsync(BIOMETRIC_ENABLED_KEY);
      return value === 'true';
    } catch (error) {
      console.error('Failed to check biometric auth status:', error);
      return false;
    }
  }

  /**
   * Authenticate for sensitive operation
   */
  static async authenticateForOperation(
    operation: string
  ): Promise<boolean> {
    const enabled = await this.isEnabled();
    if (!enabled) {
      return true; // Skip if not enabled
    }

    const result = await this.authenticate(`Authenticate to ${operation}`);
    return result.success;
  }

  /**
   * Authenticate for payment
   */
  static async authenticateForPayment(amount: number): Promise<boolean> {
    return await this.authenticateForOperation(
      `confirm payment of ${(amount / 100).toFixed(0)} TZS`
    );
  }

  /**
   * Authenticate for trading
   */
  static async authenticateForTrade(): Promise<boolean> {
    return await this.authenticateForOperation('execute trade');
  }

  /**
   * Authenticate for asset management
   */
  static async authenticateForAssetManagement(): Promise<boolean> {
    return await this.authenticateForOperation('manage assets');
  }

  /**
   * Get biometric info
   */
  static async getInfo(): Promise<{
    available: boolean;
    enabled: boolean;
    supportedTypes: string[];
  }> {
    const available = await this.isAvailable();
    const enabled = await this.isEnabled();
    const supportedTypes = available ? await this.getSupportedTypes() : [];

    return {
      available,
      enabled,
      supportedTypes,
    };
  }
}
