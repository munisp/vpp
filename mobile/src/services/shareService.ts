import { Share, Platform } from 'react-native';

/**
 * Native Share Service
 * Handles sharing content using the device's native share functionality
 */
export class ShareService {
  /**
   * Share trading opportunity
   */
  static async shareTradingOpportunity(
    type: 'buy' | 'sell',
    quantity: number,
    price: number
  ): Promise<boolean> {
    try {
      const action = type === 'sell' ? 'Selling' : 'Buying';
      const message = `${action} ${quantity} kWh of energy @ ${(price / 100).toFixed(2)} TZS/kWh on VPP Platform!\n\nJoin me in the energy marketplace and start earning from your solar energy.`;
      
      const result = await Share.share({
        message,
        title: `${action} Energy`,
        ...(Platform.OS === 'ios' && { url: 'https://vpp-platform.com/trading' }),
      });

      return result.action === Share.sharedAction;
    } catch (error) {
      console.error('Error sharing trading opportunity:', error);
      return false;
    }
  }

  /**
   * Share payment request
   */
  static async sharePaymentRequest(
    amount: number,
    recipient: string,
    reference?: string
  ): Promise<boolean> {
    try {
      const message = `Payment Request\n\nAmount: ${(amount / 100).toFixed(0)} TZS\nTo: ${recipient}${reference ? `\nReference: ${reference}` : ''}\n\nPay securely on VPP Platform`;
      
      const result = await Share.share({
        message,
        title: 'Payment Request',
        ...(Platform.OS === 'ios' && { url: 'https://vpp-platform.com/payments' }),
      });

      return result.action === Share.sharedAction;
    } catch (error) {
      console.error('Error sharing payment request:', error);
      return false;
    }
  }

  /**
   * Share device registration
   */
  static async shareDeviceReferral(
    deviceType: string,
    benefits: string[]
  ): Promise<boolean> {
    try {
      const benefitsList = benefits.map((b, i) => `${i + 1}. ${b}`).join('\n');
      const message = `I just registered my ${deviceType} on VPP Platform!\n\nBenefits:\n${benefitsList}\n\nJoin the virtual power plant and start earning from your energy devices!`;
      
      const result = await Share.share({
        message,
        title: 'Join VPP Platform',
        ...(Platform.OS === 'ios' && { url: 'https://vpp-platform.com/register' }),
      });

      return result.action === Share.sharedAction;
    } catch (error) {
      console.error('Error sharing device referral:', error);
      return false;
    }
  }

  /**
   * Share DR event participation
   */
  static async shareDREvent(
    eventName: string,
    compensationRate: number,
    startTime: Date
  ): Promise<boolean> {
    try {
      const message = `I'm participating in "${eventName}" DR event!\n\nCompensation: ${(compensationRate / 100).toFixed(2)} TZS/kWh\nStarts: ${startTime.toLocaleString()}\n\nJoin VPP Platform and earn from demand response events!`;
      
      const result = await Share.share({
        message,
        title: 'DR Event Participation',
        ...(Platform.OS === 'ios' && { url: 'https://vpp-platform.com/dr' }),
      });

      return result.action === Share.sharedAction;
    } catch (error) {
      console.error('Error sharing DR event:', error);
      return false;
    }
  }

  /**
   * Share achievement
   */
  static async shareAchievement(
    achievementName: string,
    achievementDescription: string,
    points: number
  ): Promise<boolean> {
    try {
      const message = `I just unlocked "${achievementName}" on VPP Platform! 🎉\n\n${achievementDescription}\n\n+${points} points\n\nJoin me and start earning rewards!`;
      
      const result = await Share.share({
        message,
        title: 'Achievement Unlocked!',
        ...(Platform.OS === 'ios' && { url: 'https://vpp-platform.com/achievements' }),
      });

      return result.action === Share.sharedAction;
    } catch (error) {
      console.error('Error sharing achievement:', error);
      return false;
    }
  }

  /**
   * Share earnings summary
   */
  static async shareEarnings(
    totalEarnings: number,
    period: string
  ): Promise<boolean> {
    try {
      const message = `I earned ${(totalEarnings / 100).toFixed(0)} TZS ${period} on VPP Platform by selling my solar energy!\n\nJoin the energy marketplace and start earning from your renewable energy.`;
      
      const result = await Share.share({
        message,
        title: 'My Earnings',
        ...(Platform.OS === 'ios' && { url: 'https://vpp-platform.com' }),
      });

      return result.action === Share.sharedAction;
    } catch (error) {
      console.error('Error sharing earnings:', error);
      return false;
    }
  }

  /**
   * Share app referral
   */
  static async shareAppReferral(referralCode?: string): Promise<boolean> {
    try {
      const message = referralCode
        ? `Join VPP Platform and earn from your solar energy!\n\nUse my referral code: ${referralCode}\n\nGet started today!`
        : `Join VPP Platform and earn from your solar energy!\n\nTrade energy, participate in demand response events, and maximize your renewable energy investment.`;
      
      const result = await Share.share({
        message,
        title: 'Join VPP Platform',
        ...(Platform.OS === 'ios' && { url: 'https://vpp-platform.com' }),
      });

      return result.action === Share.sharedAction;
    } catch (error) {
      console.error('Error sharing app referral:', error);
      return false;
    }
  }

  /**
   * Share P2P offer
   */
  static async shareP2POffer(
    type: 'buy' | 'sell',
    quantity: number,
    pricePerKwh: number,
    description?: string
  ): Promise<boolean> {
    try {
      const action = type === 'sell' ? 'Selling' : 'Buying';
      const message = `P2P Energy Offer\n\n${action} ${quantity} kWh @ ${(pricePerKwh / 100).toFixed(2)} TZS/kWh${description ? `\n\n${description}` : ''}\n\nCheck out this offer on VPP Platform!`;
      
      const result = await Share.share({
        message,
        title: `P2P ${action} Offer`,
        ...(Platform.OS === 'ios' && { url: 'https://vpp-platform.com/p2p' }),
      });

      return result.action === Share.sharedAction;
    } catch (error) {
      console.error('Error sharing P2P offer:', error);
      return false;
    }
  }

  /**
   * Check if sharing is available
   */
  static isAvailable(): boolean {
    return true; // Share API is available on all platforms
  }
}
